import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import type { WorkItem } from './ledger.ts';
import { wake } from './owner.ts';
import { requestDistill } from './memory.ts';
import { Runtime } from './runtime.ts';
import { askOwner, formatAnswer } from './ask.ts';
import { approveCreate, approveDelete, denyRequest, processRequests, requestPublish } from './brokering.ts';
import { DAEMON_LIMITS, daemon, drain, recordDutyRun, tick, type TickLog } from './daemon.ts';
import { publish } from './publish.ts';
import { approvePush } from './rebase.ts';
import { describeAsk, type ResourceRequest } from './requests.ts';
import { proposeDeskChanges, resetDeskReviews } from './desk-changes.ts';
import { shipEngine } from './ship.ts';
import { deskState, initiativesText, initiativeText } from './desk.ts';
import { approveInitiative, cancelInitiative, initiativeView, initiativeViews, reviseInitiative } from './org-work.ts';
import { initConfig } from './init.ts';
import { configDirectory, stateDirectory } from './paths.ts';
import { ensureDesk } from './workspace.ts';
import { advance, approvePlan, rejectPlan, resumeItem, retryItem, cancelItem, revisePlan, landOverFindings } from './workflow.ts';

const run = promisify(execFile);

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    declarations: { type: 'string', default: configDirectory() },
    state: { type: 'string', default: stateDirectory() },
    note: { type: 'string' },
    reason: { type: 'string' },
    'no-advance': { type: 'boolean', default: false },
    'with-delete': { type: 'boolean', default: false },
    agent: { type: 'string' },
    directory: { type: 'string' },
    owner: { type: 'string' },
    repository: { type: 'string' },
  },
});

function cost(item: WorkItem) {
  return item.hires.reduce((total, hire) => total + hire.cost, 0);
}

function line(item: WorkItem) {
  return `${item.id}  ${item.status.padEnd(22)} $${cost(item).toFixed(3).padStart(7)}  ${item.proposal.title}${item.reason ? `  (${item.reason})` : ''}`;
}

function detail(item: WorkItem) {
  const out = [line(item), '', `Goal: ${item.proposal.goal}`, `Why: ${item.proposal.rationale}`, 'Acceptance:', ...item.proposal.acceptance.map(entry => `  - ${entry}`)];
  if (item.humanNotes.length) out.push('', 'Notes from people:', ...item.humanNotes.map(note => `  ${note.kind} by ${note.by}: ${note.note}`));
  if (item.ownerAnswers) out.push('', 'Owner answered the planner:', ...item.ownerAnswers.answers.map(entry => `  Q: ${entry.question}\n  A: ${entry.answer}`));
  if (item.plan) {
    out.push('', `Plan: ${item.plan.summary}`, ...item.plan.steps.map((step, index) => `  ${index + 1}. ${step.description} [${step.files.join(', ')}]`));
    out.push('Tests:', ...item.plan.tests.map(entry => `  - ${entry}`), 'Risks:', ...item.plan.risks.map(entry => `  - ${entry}`), 'Out of scope:', ...item.plan.outOfScope.map(entry => `  - ${entry}`));
  }
  item.implementations.forEach((implementation, index) => {
    const verified = implementation.verification.map(result => `${result.command}=${result.exitCode}`).join(' ');
    out.push('', `Implementation ${index + 1}: ${implementation.report.summary}`, `  ${implementation.diffStat.split('\n').at(-1) ?? ''}`, `  verify: ${verified}`);
  });
  item.verdicts.forEach((verdict, index) => {
    out.push('', `Review ${index + 1}: ${verdict.decision}: ${verdict.summary}`, ...verdict.findings.map(finding => `  [${finding.severity}] ${finding.file}: ${finding.issue}`));
  });
  out.push('', 'Hires:', ...item.hires.map(hire => `  ${hire.stage.padEnd(9)} ${hire.craft.padEnd(14)} ${hire.model.padEnd(34)} ${hire.family.padEnd(9)} ${hire.outcome} $${hire.cost.toFixed(4)}${hire.error ? ` ${hire.error}` : ''}`));
  if (item.branch) out.push('', `Branch: ${item.branch}  Worktree: ${item.worktree}`);
  if (item.landedCommit) out.push(`Landed: ${item.landedCommit}`);
  if (item.publication) out.push(`Published: ${item.publication.url}`);
  return out.join('\n');
}

const progress = (item: WorkItem) => console.log(`  → ${line(item)}`);

function requestLine(request: ResourceRequest) {
  const instance = request.instance ? `  ${request.instance.remote}:${request.instance.name}` : '';
  const result = request.followUpResult ? `  [${request.followUp}: ${request.followUpResult.ok ? 'ok' : 'FAILED'}: ${request.followUpResult.summary}]` : '';
  const why = request.reason ? `  (${request.reason})` : '';
  return `${request.id}  ${request.status.padEnd(24)} ${request.from} → ${request.to}  ${describeAsk(request.ask)}${instance}${result}${why}`;
}

const tickLog: TickLog = {
  duty: (ownerId, dutyId, summary) => console.log(`[duty] ${ownerId}/${dutyId}: ${summary}`),
  item: item => console.log(`[item] ${line(item)}`),
  request: request => console.log(`[request] ${requestLine(request)}`),
  error: (context, error) => console.error(`[error] ${context}: ${error instanceof Error ? error.message : error}`),
};

/** Record a decision, then continue in this process only if no daemon holds the runtime. */
async function continueIfFree(runtime: Runtime, item: WorkItem) {
  if (options['no-advance']) return;
  const unlock = await runtime.lock().catch(() => undefined);
  if (!unlock) {
    console.log(`  recorded. The runtime is ${await runtime.lockHolder()}.`);
    console.log('  A running daemon picks this up at its next tick; otherwise run `owners tick` once that finishes.');
    return;
  }
  try {
    console.log(detail(await advance(runtime, item.id, progress)));
  } finally {
    await unlock();
  }
}

type Command = (runtime: Runtime, args: string[]) => Promise<void>;

const COMMANDS: Record<string, Command> = {
  async wake(runtime, [ownerId, dutyId = 'survey']) {
    console.log(`waking ${ownerId} for ${dutyId} (${runtime.owner(required(ownerId, 'owner')).model})`);
    const result = await wake(runtime, required(ownerId, 'owner'), dutyId);
    console.log(`${ownerId} ${dutyId}: ${result.survey.summary}\nnotebook edits: ${result.survey.notebook.length}; cost $${result.cost.toFixed(4)}`);
    await recordDutyRun(runtime, required(ownerId, 'owner'), dutyId);
    if (result.request) {
      await processRequests(runtime, tickLog.request);
      console.log(requestLine(await runtime.requests.get(result.request.id)));
    }
    for (const item of result.attention) console.log(`ATTENTION: ${item.title}\n  ${item.goal}\n  why: ${item.rationale}\n  do: ${item.acceptance.join('; ')}`);
    for (const item of result.items) {
      console.log(line(item));
      if (!options['no-advance']) await advance(runtime, item.id, progress);
    }
  },
  async items(runtime) {
    for (const item of await runtime.ledger.list()) console.log(line(item));
  },
  async show(runtime, [itemId]) {
    console.log(detail(await runtime.ledger.get(required(itemId, 'work item'))));
  },
  async approve(runtime, [itemId]) {
    const item = await approvePlan(runtime, required(itemId, 'work item'), userInfo().username, options.note);
    console.log(line(item));
    await continueIfFree(runtime, item);
  },
  async 'revise-plan'(runtime, [itemId]) {
    const item = await revisePlan(runtime, required(itemId, 'work item'), userInfo().username, required(options.note, '--note'));
    console.log(line(item));
    await continueIfFree(runtime, item);
  },
  async publish(runtime, [itemId]) {
    const item = await publish(runtime, required(itemId, 'work item'), userInfo().username);
    console.log(`${line(item)}\n${item.publication?.url ?? ''}`);
  },
  async reject(runtime, [itemId]) {
    console.log(line(await rejectPlan(runtime, required(itemId, 'work item'), userInfo().username, required(options.reason, '--reason'))));
  },
  async run(runtime, [itemId]) {
    console.log(detail(await advance(runtime, required(itemId, 'work item'), progress)));
  },
  async distill(runtime, [ownerId]) {
    await requestDistill(runtime, required(ownerId, 'owner'), userInfo().username);
    console.log('Distillation queued; the daemon or `owners tick` will run it.');
  },
  async notebook(runtime, [ownerId]) {
    const notebook = runtime.notebook(required(ownerId, 'owner'));
    const { stdout } = await run('git', ['-C', notebook.root, 'log', '--oneline', '-15', '--', notebook.ownerId]);
    console.log(`${notebook.directory}\n${stdout}`);
  },
  async resume(runtime, [itemId]) {
    const item = await resumeItem(runtime, required(itemId, 'work item'), userInfo().username, options.note);
    console.log(line(item));
    await continueIfFree(runtime, item);
  },
  async retry(runtime, [itemId]) {
    const item = await retryItem(runtime, required(itemId, 'work item'), userInfo().username, options.note);
    console.log(line(item));
    await continueIfFree(runtime, item);
  },
  async 'land-over-findings'(runtime, [itemId]) {
    const { item, followUp } = await landOverFindings(runtime, required(itemId, 'work item'), userInfo().username, required(options.note, '--note'));
    console.log(line(item));
    if (followUp) console.log(`follow-up: ${line(followUp)}`);
    await continueIfFree(runtime, item);
  },
  async cancel(runtime, [itemId]) {
    console.log(line(await cancelItem(runtime, required(itemId, 'work item'), userInfo().username, required(options.reason, '--reason'))));
  },
  async 'approve-push'(runtime, [itemId]) {
    const item = await approvePush(runtime, required(itemId, 'work item'), userInfo().username);
    console.log(line(item));
    await continueIfFree(runtime, item);
  },
  async desk(runtime, [ownerId]) {
    for (const owner of runtime.repositoryViews(required(ownerId, 'owner'))) {
      const desk = await ensureDesk(owner, runtime.desksRoot);
      console.log(`${owner.persona?.name ?? owner.id}'s desk for ${owner.domain.name}: ${desk.path} (branch ${desk.branch})`);
    }
    console.log('Chat with the owner in the surface (npm run surface); its chats run in this desk.');
  },
  async ask(runtime, [fromId, toName]) {
    const { answerer, answer, cost } = await askOwner(runtime, required(fromId, 'asking owner'), required(toName, 'answering owner'), required(options.note, '--note (the question)'));
    console.log(`${formatAnswer(answerer, answer)}\n(cost $${cost.toFixed(4)})`);
  },
  async 'request-publish'(runtime, [fromId, siteId]) {
    const request = await requestPublish(runtime, required(fromId, 'owner'), required(siteId, 'site'), options.note ?? 'publish the current base branch');
    console.log(requestLine(request));
    if (!options['no-advance']) {
      const unlock = await runtime.lock().catch(() => undefined);
      if (!unlock) return console.log(`  recorded. The runtime is ${await runtime.lockHolder()}; the daemon continues it.`);
      try {
        await processRequests(runtime, tickLog.request);
      } finally {
        await unlock();
      }
    }
  },
  async ship(runtime, [ownerId]) {
    const result = await shipEngine(runtime, required(ownerId, 'owner'));
    console.log(`${result.outcome}: ${result.summary}`);
  },
  async propose(runtime, [ownerId]) {
    const result = await proposeDeskChanges(runtime, required(ownerId, 'owner'), required(options.note, '--note (title)'), options.reason ?? options.note!, options.repository);
    console.log(`${result.outcome}: ${result.summary}`);
  },
  async 'desk-state'(runtime) {
    console.log(JSON.stringify(await deskState(runtime, { agent: options.agent, directory: options.directory, owner: options.owner })));
  },
  async retract(runtime, [ownerId]) {
    const notebook = runtime.notebook(required(ownerId, 'owner'));
    await notebook.journal({ kind: 'retracted', note: required(options.note, '--note') });
    await notebook.commit('retraction').catch(() => undefined);
    console.log('retracted');
  },
  async requests(runtime) {
    for (const request of await runtime.requests.list()) console.log(requestLine(request));
  },
  async 'approve-create'(runtime, [requestId]) {
    console.log(requestLine(await approveCreate(runtime, required(requestId, 'request'), userInfo().username, options['with-delete']!)));
  },
  async 'approve-delete'(runtime, [requestId]) {
    console.log(requestLine(await approveDelete(runtime, required(requestId, 'request'), userInfo().username)));
  },
  async 'deny-request'(runtime, [requestId]) {
    console.log(requestLine(await denyRequest(runtime, required(requestId, 'request'), userInfo().username, required(options.reason, '--reason'))));
  },
  async 'desk-review-reset'(runtime, [ownerId, repository]) {
    const cleared = await resetDeskReviews(runtime, required(ownerId, 'owner'), repository, userInfo().username);
    console.log(`${ownerId}: ${cleared} review rounds cleared; the next proposal is reviewed afresh`);
  },
  async initiatives(runtime) {
    console.log(initiativesText(await initiativeViews(runtime)));
  },
  async initiative(runtime, [initiativeId]) {
    console.log(initiativeText(await initiativeView(runtime, required(initiativeId, 'initiative'))));
  },
  async 'approve-initiative'(runtime, [initiativeId]) {
    const approved = await approveInitiative(runtime, required(initiativeId, 'initiative'), userInfo().username, options.note);
    console.log(`${approved.id}: ${approved.status} (revision ${approved.revision}); the daemon dispatches its ready assignments`);
  },
  async 'revise-initiative'(runtime, [initiativeId]) {
    const revised = await reviseInitiative(runtime, required(initiativeId, 'initiative'), userInfo().username, required(options.note, '--note'));
    console.log(`${revised.id}: ${revised.status}; sent back to ${revised.owner}`);
  },
  async 'cancel-initiative'(runtime, [initiativeId]) {
    const cancelled = await cancelInitiative(runtime, required(initiativeId, 'initiative'), userInfo().username, required(options.reason, '--reason'));
    console.log(`${cancelled.id}: ${cancelled.status}`);
  },
  async tick(runtime) {
    await tick(runtime, tickLog);
    // One tick from the command line holds the runtime until the work it started is done.
    await drain();
  },
  async daemon(runtime) {
    const stop = new AbortController();
    const shutdown = () => {
      stop.abort();
      // Give in-flight work a moment, then mark it interrupted (never replayed) and exit cleanly.
      setTimeout(async () => {
        const stranded = await runtime.ledger.markInterrupted();
        console.log(`owners daemon: stopped; ${stranded} work items marked interrupted`);
        runtime.close();
        await rm(join(runtime.stateDirectory, 'runtime.lock'), { recursive: true, force: true });
        process.exit(0);
      }, DAEMON_LIMITS.shutdownGraceMs).unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);
    console.log(`owners daemon: ${runtime.declarations.owners.size} owners, tick every ${60}s; stop with SIGTERM`);
    await daemon(runtime, tickLog, stop.signal);
  },
  async recover(runtime) {
    console.log(`marked interrupted: ${await runtime.ledger.markInterrupted()}`);
  },
};

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const [commandName, ...args] = positionals;
const command = COMMANDS[commandName ?? ''];
if (!command && commandName !== 'init') {
  console.error(`usage: owners <${Object.keys(COMMANDS).join('|')}> …`);
  process.exit(2);
}
if (commandName === 'init') {
  await initConfig(options.declarations!);
  process.exit(0);
}
const runtime = await Runtime.open({ declarations: options.declarations!, state: options.state! });
/** Commands that only read, or only record a person's decision, never take the runtime lock. */
const LOCK_FREE = [
  'distill', 'items', 'show', 'notebook', 'requests', 'approve', 'publish', 'revise-plan', 'reject',
  'resume', 'retry', 'land-over-findings', 'cancel', 'desk', 'desk-state', 'retract', 'ask', 'request-publish', 'propose',
  'ship', 'approve-push', 'approve-create', 'approve-delete', 'deny-request',
  'desk-review-reset', 'initiatives', 'initiative', 'approve-initiative', 'revise-initiative', 'cancel-initiative',
];
try {
  const unlock = LOCK_FREE.includes(commandName!) ? async () => {} : await runtime.lock();
  try {
    await command(runtime, args);
  } finally {
    runtime.close();
    await unlock();
  }
} catch (error) {
  console.error(`owners ${commandName}: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
