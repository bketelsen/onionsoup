import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import type { WorkItem } from './ledger.ts';
import { distill, wake } from './owner.ts';
import { Runtime } from './runtime.ts';
import { approveCreate, approveDelete, denyRequest, processRequests } from './brokering.ts';
import { daemon, recordDutyRun, tick, type TickLog } from './daemon.ts';
import { publish } from './publish.ts';
import type { ResourceRequest } from './requests.ts';
import { advance, approvePlan, rejectPlan, revisePlan } from './workflow.ts';

const run = promisify(execFile);

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    declarations: { type: 'string', default: 'examples/owners' },
    state: { type: 'string', default: '.local/owners/state' },
    note: { type: 'string' },
    reason: { type: 'string' },
    'no-advance': { type: 'boolean', default: false },
    'with-delete': { type: 'boolean', default: false },
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
  return `${request.id}  ${request.status.padEnd(24)} ${request.from} → ${request.to}  ${request.ask.image}${instance}${result}${why}`;
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
    const result = await distill(runtime, required(ownerId, 'owner'));
    console.log(`distilled: ${result.edits} edits, $${result.cost.toFixed(4)}`);
  },
  async notebook(runtime, [ownerId]) {
    const notebook = runtime.notebook(required(ownerId, 'owner'));
    const { stdout } = await run('git', ['-C', notebook.root, 'log', '--oneline', '-15', '--', notebook.ownerId]);
    console.log(`${notebook.directory}\n${stdout}`);
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
  async tick(runtime) {
    await tick(runtime, tickLog);
  },
  async daemon(runtime) {
    const stop = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
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
if (!command) {
  console.error(`usage: owners <${Object.keys(COMMANDS).join('|')}> …`);
  process.exit(2);
}
const runtime = await Runtime.open({ declarations: options.declarations!, state: options.state! });
/** Commands that only read, or only record a person's decision, never take the runtime lock. */
const LOCK_FREE = ['items', 'show', 'notebook', 'requests', 'approve', 'revise-plan', 'reject', 'approve-create', 'approve-delete', 'deny-request'];
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
