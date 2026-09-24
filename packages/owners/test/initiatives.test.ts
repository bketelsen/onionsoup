import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { processRequest } from '../src/brokering.ts';
import { drain, tick, type TickLog } from '../src/daemon.ts';
import { INITIATIVE_LIMITS, type InitiativeDraft } from '../src/initiatives.ts';
import { pendingNotices } from '../src/notices.ts';
import {
  approveInitiative, cancelAssignment, cancelInitiative, draftInitiative, initiativeView, planDigest, raiseToManager, resolveEscalation,
  reviewReportPlan, reviseInitiative, steerReportItem, submitInitiative, superviseInitiatives, updateInitiative,
} from '../src/org-work.ts';
import { Runtime } from '../src/runtime.ts';
import { listAttention } from '../src/attention.ts';
import type { ManagerPlanVerdict } from '../src/artifacts.ts';
import { withActiveHooks } from './active-hooks.ts';

const origin = { sessionID: 'ses_odrade', directory: '/evidence/odrade' };

function proposal(title: string) {
  return { title, goal: `Do ${title}`, rationale: 'Org-wide change', acceptance: ['It works'], size: 'small' as const };
}

function twoRepoDraft(): InitiativeDraft {
  return {
    title: 'Cross-repository change', goal: 'Change core, then document it', rationale: 'The person asked for it',
    assignments: [
      { id: 'a1', to: 'clippy', proposal: proposal('Core change'), after: [] },
      { id: 'a2', to: 'bellonda', proposal: proposal('Wiki follow-up'), after: ['a1'] },
    ],
  };
}

async function setup() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'initiatives-')) });
  for (const owner of runtime.declarations.owners.values()) await runtime.notebook(owner.id).ensure('# Test charter');
  runtime.hire = async () => { throw new Error('no_hire_permitted'); };
  return runtime;
}

function supervise(runtime: Runtime) {
  return superviseInitiatives(runtime, { onError: (_context, error) => { throw error; } });
}

async function journalOf(runtime: Runtime, ownerId: string) {
  const directory = join(runtime.notebook(ownerId).directory, 'journal');
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line) as { kind: string; note?: string });
}

async function submitted(runtime: Runtime, draft = twoRepoDraft()) {
  const initiative = await draftInitiative(runtime, 'odrade', draft, origin);
  return submitInitiative(runtime, 'odrade', initiative.id);
}

/** Accept the dispatched request (no hire), then record its PR as merged and let the request see it. */
async function mergeAssignment(runtime: Runtime, requestId: string) {
  await processRequest(runtime, requestId);
  const item = await runtime.ledger.get((await runtime.requests.get(requestId)).workItem!);
  const publication = { url: `https://example.test/pr/${item.id}`, branch: `owners/${item.id}`, by: 'person', at: item.createdAt, state: 'merged' as const };
  await runtime.ledger.save({ ...item, status: 'landed', publication });
  await processRequest(runtime, requestId);
  return item;
}

async function assignmentRequest(runtime: Runtime, initiativeId: string, assignmentId: string) {
  return (await runtime.initiatives.get(initiativeId)).assignments.find(assignment => assignment.id === assignmentId)?.request;
}

test('an approved initiative dispatches in dependency order, auto-accepts, and completes when the last PR merges', async () => {
  const runtime = await setup();
  const initiative = await submitted(runtime);
  assert.equal(initiative.status, 'awaiting-approval');
  await supervise(runtime);
  assert.deepEqual(await runtime.requests.list(), [], 'nothing dispatches before the person approves');

  await approveInitiative(runtime, initiative.id, 'person');
  await supervise(runtime);
  await supervise(runtime);
  const [first, ...others] = await runtime.requests.list();
  assert.equal(others.length, 0, 'exactly one request: a2 waits for a1');
  assert.equal(first?.to, 'clippy');
  assert.deepEqual(first?.ask.kind === 'work' && first.ask.assignment, { initiative: initiative.id, assignment: 'a1' });
  assert.equal(await assignmentRequest(runtime, initiative.id, 'a1'), first!.id);

  await runtime.initiatives.update(initiative.id, current => ({ ...current, assignments: current.assignments.map(assignment => ({ ...assignment, request: undefined })) }));
  await supervise(runtime);
  assert.equal((await runtime.requests.list()).length, 1, 'a dispatch that crashed before linking is linked, not repeated');
  assert.equal(await assignmentRequest(runtime, initiative.id, 'a1'), first!.id);

  const firstItem = await mergeAssignment(runtime, first!.id);
  assert.deepEqual(firstItem.assignment, { initiative: initiative.id, assignment: 'a1' });
  assert.equal((await runtime.requests.get(first!.id)).status, 'completed');
  assert.equal((await initiativeView(runtime, initiative.id)).assignments[0]?.state, 'completed');

  await supervise(runtime);
  const second = (await runtime.requests.list()).find(request => request.to === 'bellonda');
  assert.ok(second, 'a2 dispatches once a1 merged');
  await mergeAssignment(runtime, second.id);
  await supervise(runtime);
  const done = await runtime.initiatives.get(initiative.id);
  assert.equal(done.status, 'completed');
  assert.match(done.outcome!, /all 2 assignments merged/);
  const kinds = (await journalOf(runtime, 'odrade')).map(entry => entry.kind);
  for (const kind of ['initiative-drafted', 'initiative-submitted', 'initiative-approved', 'assignment-dispatched', 'initiative-completed']) assert.ok(kinds.includes(kind), kind);
  assert.ok((await journalOf(runtime, 'bellonda')).some(entry => entry.kind === 'assignment-dispatched'));
  const notices = (await pendingNotices(runtime)).filter(notice => notice.initiative === initiative.id);
  assert.deepEqual(notices.map(notice => notice.change).sort(), ['initiative-approved', 'initiative-completed']);
  assert.ok(notices.every(notice => notice.owner === 'odrade' && notice.origin?.sessionID === origin.sessionID));
});

test('the daemon tick supervises initiatives after requests', async () => {
  const runtime = await setup();
  const initiative = await submitted(runtime);
  await approveInitiative(runtime, initiative.id, 'person');
  const errors: string[] = [];
  const log: TickLog = { duty: () => {}, item: () => {}, request: () => {}, error: context => { errors.push(context); } };
  await tick(runtime, log);
  await drain();
  const [request] = await runtime.requests.list();
  assert.equal(request?.status, 'pending-owner');
  assert.equal(request?.to, 'clippy');
  assert.ok(!errors.includes('initiatives') && !errors.includes(initiative.id));
});

test('submission refuses cycles, unknown dependencies, non-reports, reports that cannot see merges, and too many open initiatives', async () => {
  const runtime = await setup();
  const withAssignments = (assignments: InitiativeDraft['assignments']) => ({ ...twoRepoDraft(), assignments });
  const cases: [InitiativeDraft['assignments'], RegExp][] = [
    [[{ id: 'a1', to: 'clippy', proposal: proposal('x'), after: ['a2'] }, { id: 'a2', to: 'bellonda', proposal: proposal('y'), after: ['a1'] }], /assignment_cycle: a1 → a2 → a1/],
    [[{ id: 'a1', to: 'clippy', proposal: proposal('x'), after: ['missing'] }], /assignment_unknown_dependency: a1 waits for missing/],
    [[{ id: 'a1', to: 'homelab', proposal: proposal('x'), after: [] }], /assignment_not_a_report: a1: homelab does not report to odrade/],
    [[], /initiative_has_no_assignments/],
  ];
  for (const [assignments, expected] of cases) await assert.rejects(submitted(runtime, withAssignments(assignments)), expected);
  await assert.rejects(draftInitiative(runtime, 'homelab', twoRepoDraft()), /not_a_manager/);

  const bellonda = runtime.declarations.owners.get('bellonda')!;
  runtime.declarations.owners.set('bellonda', { ...bellonda, duties: [] });
  await assert.rejects(submitted(runtime), /assignment_report_cannot_observe_merges: a2: bellonda has no maintain-prs duty/);
  runtime.declarations.owners.set('bellonda', bellonda);

  const previous = INITIATIVE_LIMITS.maxOpenPerManager;
  INITIATIVE_LIMITS.maxOpenPerManager = 1;
  try {
    await submitted(runtime);
    await assert.rejects(submitted(runtime), /initiative_limit_reached: odrade already has 1 open/);
  } finally {
    INITIATIVE_LIMITS.maxOpenPerManager = previous;
  }
  assert.equal((await runtime.initiatives.list()).filter(initiative => initiative.status === 'awaiting-approval').length, 1);
});

test('an edit after approval is a new revision that stops dispatch until the person approves it again', async () => {
  const runtime = await setup();
  const initiative = await submitted(runtime);
  await approveInitiative(runtime, initiative.id, 'person');
  await supervise(runtime);
  const changed = twoRepoDraft();
  changed.assignments[1]!.proposal.title = 'Wiki follow-up, revised';
  const updated = await updateInitiative(runtime, 'odrade', initiative.id, changed);
  assert.deepEqual([updated.status, updated.revision], ['awaiting-approval', 1]);
  assert.equal(updated.assignments[0]?.request, (await runtime.requests.list())[0]?.id, 'the dispatched link survives the edit');
  const moved = twoRepoDraft();
  moved.assignments[0]!.to = 'bellonda';
  await assert.rejects(updateInitiative(runtime, 'odrade', initiative.id, moved), /assignment_already_dispatched: a1/);

  await mergeAssignment(runtime, (await runtime.requests.list())[0]!.id);
  await supervise(runtime);
  assert.equal((await runtime.requests.list()).length, 1, 'the new revision is not approved yet');
  await approveInitiative(runtime, initiative.id, 'person');
  await supervise(runtime);
  const second = (await runtime.requests.list()).find(request => request.to === 'bellonda');
  assert.equal(second?.ask.kind === 'work' && second.ask.proposal.title, 'Wiki follow-up, revised');
});

test('the person sends an initiative back or cancels it, and the manager hears it in her chat', async () => {
  const runtime = await setup();
  const initiative = await submitted(runtime);
  const revised = await reviseInitiative(runtime, initiative.id, 'person', 'Split the wiki work');
  assert.equal(revised.status, 'drafting');
  assert.equal(revised.feedback[0]?.note, 'Split the wiki work');
  await assert.rejects(approveInitiative(runtime, initiative.id, 'person'), /initiative_not_awaiting_approval: drafting/);
  await submitInitiative(runtime, 'odrade', initiative.id);
  const cancelled = await cancelInitiative(runtime, initiative.id, 'person', 'Not this quarter');
  assert.equal(cancelled.status, 'cancelled');
  await supervise(runtime);
  assert.deepEqual(await runtime.requests.list(), []);
  const notices = await pendingNotices(runtime);
  assert.deepEqual(notices.map(notice => notice.change).sort(), ['initiative-cancelled', 'initiative-revised']);
  assert.ok(notices.find(notice => notice.change === 'initiative-revised')!.text.includes('Split the wiki work'));
});

test('failed assigned work fails the initiative and nothing after it dispatches', async () => {
  const runtime = await setup();
  const initiative = await submitted(runtime);
  await approveInitiative(runtime, initiative.id, 'person');
  await supervise(runtime);
  const [request] = await runtime.requests.list();
  await processRequest(runtime, request!.id);
  const item = await runtime.ledger.get((await runtime.requests.get(request!.id)).workItem!);
  await runtime.ledger.save({ ...item, status: 'failed', reason: 'verification_failed' });
  await processRequest(runtime, request!.id);
  await supervise(runtime);
  const failed = await runtime.initiatives.get(initiative.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.outcome!, /a1 \(clippy\) failed: .*verification_failed/);
  assert.equal((await runtime.requests.list()).length, 1);
  assert.ok((await pendingNotices(runtime)).some(notice => notice.change === 'initiative-failed'));
});

test('a manager cancels an assignment nothing waits for, and the initiative completes without it', async () => {
  const runtime = await setup();
  const initiative = await submitted(runtime);
  await approveInitiative(runtime, initiative.id, 'person');
  await assert.rejects(cancelAssignment(runtime, 'odrade', initiative.id, 'a1', 'Not needed'), /assignment_has_dependents: a2 wait for a1/);
  await assert.rejects(cancelAssignment(runtime, 'bellonda', initiative.id, 'a2', 'Mine'), /not_your_initiative/);
  await cancelAssignment(runtime, 'odrade', initiative.id, 'a2', 'The wiki is fine');
  await supervise(runtime);
  await mergeAssignment(runtime, (await runtime.requests.list())[0]!.id);
  await supervise(runtime);
  const done = await initiativeView(runtime, initiative.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.assignments.map(assignment => assignment.state), ['completed', 'cancelled']);
  assert.equal((await runtime.requests.list()).length, 1);
});

function plan(summary: string) {
  return { summary, steps: [{ description: 'Change it', files: ['main.go'] }], tests: ['go test'], risks: [], outOfScope: [], questionsForOwner: [] };
}

/** Stand in for the planner: the item now waits for approval of this plan. */
function setPlan(runtime: Runtime, itemId: string, summary: string) {
  return runtime.ledger.update(itemId, item => ({ ...item, status: 'awaiting-plan-approval', plan: plan(summary) }));
}

/** Approve the initiative, dispatch a1 and let clippy accept it; returns clippy's item. */
async function dispatchedCoreItem(runtime: Runtime) {
  const initiative = await submitted(runtime);
  await approveInitiative(runtime, initiative.id, 'person');
  await supervise(runtime);
  const [request] = await runtime.requests.list();
  await processRequest(runtime, request!.id);
  return { initiative, request: request!, itemId: (await runtime.requests.get(request!.id)).workItem! };
}

/** Only the manager's plan review may hire, and it answers with these verdicts in order. */
function scriptManager(runtime: Runtime, verdicts: ManagerPlanVerdict[]) {
  const hires: string[] = [];
  runtime.hire = async (_owner, request) => {
    if (!request.title.endsWith(': manager plan review')) throw new Error('no_hire_permitted');
    hires.push(request.title);
    const verdict = verdicts.shift();
    if (!verdict) throw new Error('no_verdict_scripted');
    return { value: request.schema.parse(verdict), sessionID: 'scripted', cost: 0, startedAt: '', finishedAt: '' };
  };
  return hires;
}

/** Supervise with a review pool, wait for the reviews it started, and say how many. */
async function superviseWithReviews(runtime: Runtime) {
  const started: Promise<void>[] = [];
  await superviseInitiatives(runtime, {
    onError: (_context, error) => { throw error; },
    startReview: (_key, review) => { started.push(review()); },
  });
  await Promise.all(started);
  return started.length;
}

test('a manager approves a report plan under its grant, journaled to both; without a grant the plan waits for the person', async () => {
  const runtime = await setup();
  const hires = scriptManager(runtime, [{ decision: 'approve', note: 'Fits the initiative' }]);
  const { initiative, request, itemId } = await dispatchedCoreItem(runtime);
  const clippy = runtime.declarations.owners.get('clippy')!;
  runtime.declarations.owners.set('clippy', { ...clippy, grants: [] });
  const waiting = await setPlan(runtime, itemId, 'Core plan');
  assert.equal(await superviseWithReviews(runtime), 0, 'removing the grant restores the person\'s gate');
  await assert.rejects(reviewReportPlan(runtime, 'odrade', itemId, { decision: 'approve', note: '' }), /plan_review_no_grant: clippy/);
  runtime.declarations.owners.set('clippy', clippy);

  assert.equal(await superviseWithReviews(runtime), 1);
  const approved = await runtime.ledger.get(itemId);
  assert.equal(approved.status, 'implementing');
  assert.equal(approved.planApproval?.by, 'owner:odrade (standing grant approve-plans in clippy)');
  for (const owner of ['odrade', 'clippy']) {
    assert.ok((await journalOf(runtime, owner)).some(entry => entry.kind === 'grant-used' && entry.note?.includes(itemId)), owner);
  }
  const reviews = (await runtime.initiatives.get(initiative.id)).planReviews;
  assert.deepEqual(reviews.map(review => [review.item, review.verdict, review.digest]), [[itemId, 'approve', planDigest(waiting.plan!)]]);
  assert.equal(await superviseWithReviews(runtime), 0);
  assert.deepEqual(hires, [`${itemId}: manager plan review`]);

  await mergeAssignment(runtime, request.id);
  await supervise(runtime);
  const second = (await runtime.requests.list()).find(candidate => candidate.to === 'bellonda')!;
  await processRequest(runtime, second.id);
  const bellondaItem = (await runtime.requests.get(second.id)).workItem!;
  await setPlan(runtime, bellondaItem, 'Wiki plan');
  assert.equal(await superviseWithReviews(runtime), 0, 'bellonda granted nothing');
  await assert.rejects(reviewReportPlan(runtime, 'odrade', bellondaItem, { decision: 'approve', note: '' }), /plan_review_no_grant: bellonda/);
  assert.equal((await runtime.ledger.get(bellondaItem)).status, 'awaiting-plan-approval');
});

test('a manager sends a plan back within a revision budget, after which it escalates to the person without a hire', async () => {
  const runtime = await setup();
  const hires = scriptManager(runtime, [{ decision: 'revise', note: 'Smaller' }, { decision: 'revise', note: 'Smaller still' }]);
  const { initiative, itemId } = await dispatchedCoreItem(runtime);
  for (const summary of ['Plan 1', 'Plan 2']) {
    await setPlan(runtime, itemId, summary);
    assert.equal(await superviseWithReviews(runtime), 1);
    assert.equal((await runtime.ledger.get(itemId)).status, 'planning');
  }
  assert.deepEqual((await runtime.ledger.get(itemId)).humanNotes.map(note => [note.kind, note.by, note.note]), [
    ['plan-feedback', 'owner:odrade', 'Smaller'], ['plan-feedback', 'owner:odrade', 'Smaller still'],
  ]);
  await setPlan(runtime, itemId, 'Plan 3');
  assert.equal(await superviseWithReviews(runtime), 1);
  assert.equal(hires.length, 2, 'the budget is spent: no third hire');
  assert.equal((await runtime.ledger.get(itemId)).status, 'awaiting-plan-approval', 'the person decides');
  const last = (await runtime.initiatives.get(initiative.id)).planReviews.at(-1);
  assert.equal(last?.verdict, 'escalate');
  assert.match(last!.note, /revision_limit_reached/);
  assert.ok((await listAttention(runtime)).some(entry => entry.owner === 'odrade' && entry.note.includes(itemId)));
  assert.equal(await superviseWithReviews(runtime), 0, 'a reviewed plan is not reviewed again');
});

test('a failed plan-review hire escalates with its error instead of approving', async () => {
  const runtime = await setup();
  const { initiative, itemId } = await dispatchedCoreItem(runtime);
  await setPlan(runtime, itemId, 'Core plan');
  assert.equal(await superviseWithReviews(runtime), 1);
  const [review] = (await runtime.initiatives.get(initiative.id)).planReviews;
  assert.equal(review?.verdict, 'escalate');
  assert.match(review!.note, /plan_review_hire_failed: no_hire_permitted/);
  assert.equal((await runtime.ledger.get(itemId)).status, 'awaiting-plan-approval');
});

test('a report escalation wakes the manager and blocks her approvals until resolved; steering is limited to her reports\' assigned work', async () => {
  const runtime = await setup();
  const { initiative, itemId } = await dispatchedCoreItem(runtime);
  await setPlan(runtime, itemId, 'Core plan');
  const escalation = await raiseToManager(runtime, 'clippy', { kind: 'objection', note: 'This belongs in the wiki', item: itemId });
  await assert.rejects(raiseToManager(runtime, 'bellonda', { kind: 'question', note: 'Why?', item: itemId }), /not_your_assignment/);
  assert.equal((await runtime.initiatives.get(initiative.id)).escalations[0]?.id, escalation.id);
  assert.ok((await journalOf(runtime, 'clippy')).some(entry => entry.kind === 'escalation' && entry.note?.includes('This belongs in the wiki')));
  assert.ok((await listAttention(runtime)).some(entry => entry.owner === 'odrade' && entry.note.includes('clippy escalated (objection)')));
  const woken = (await pendingNotices(runtime)).find(notice => notice.change === 'escalation');
  assert.equal(woken?.owner, 'odrade');
  assert.deepEqual(woken?.origin, origin);

  assert.equal(await superviseWithReviews(runtime), 0);
  await assert.rejects(steerReportItem(runtime, 'odrade', itemId, 'approve-plan', ''), /plan_review_escalation_open/);
  await resolveEscalation(runtime, 'odrade', initiative.id, escalation.id, 'Core first, then the wiki');
  assert.ok((await journalOf(runtime, 'clippy')).some(entry => entry.kind === 'escalation-resolved'));

  await steerReportItem(runtime, 'odrade', itemId, 'note', 'Keep it small');
  assert.ok((await journalOf(runtime, 'clippy')).some(entry => entry.kind === 'manager-note' && entry.note?.includes('Keep it small')));
  assert.equal(await steerReportItem(runtime, 'odrade', itemId, 'revise-plan', 'Drop step 2'), 'planning');
  await setPlan(runtime, itemId, 'Core plan, smaller');
  assert.equal(await steerReportItem(runtime, 'odrade', itemId, 'approve-plan', ''), 'implementing');
  assert.equal((await runtime.ledger.get(itemId)).planApproval?.by, 'owner:odrade (standing grant approve-plans in clippy)');

  const peerWork = await runtime.ledger.create('homelab', 'change', proposal('Fleet change'));
  const ownWork = await runtime.ledger.create('clippy', 'change', proposal('Unassigned'));
  await assert.rejects(steerReportItem(runtime, 'odrade', peerWork.id, 'note', 'x'), /not_your_report_item/);
  await assert.rejects(steerReportItem(runtime, 'odrade', ownWork.id, 'cancel', 'x'), /not_your_report_item/);
  await assert.rejects(steerReportItem(runtime, 'homelab', itemId, 'note', 'x'), /not_your_report_item/);
});

test('in chat, a manager drafts from her chat, reads her reports\' assigned work, and sees her initiatives in status', async () => {
  const runtime = await setup();
  const { initiative, itemId } = await dispatchedCoreItem(runtime);
  await raiseToManager(runtime, 'clippy', { kind: 'question', note: 'Which branch?', item: itemId });
  const input = new Proxy({} as Parameters<typeof withActiveHooks>[0], {
    get(_target, key) { throw new Error(`unexpected_plugin_input: ${String(key)}`); },
  });
  const hooks = await withActiveHooks(input, { declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  const context = (agent: string) => ({ agent, sessionID: `ses_${agent}`, messageID: 'msg_1', directory: '/chat', worktree: '/chat', abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });
  const tools = hooks.tool!;
  assert.match(String(await tools.onionsoup_status!.execute({ item: itemId }, context('Odrade'))), new RegExp(`^${itemId}: Core change`));
  assert.match(String(await tools.onionsoup_status!.execute({ item: itemId }, context('Bellonda'))), /^No work item/);
  const summary = String(await tools.onionsoup_status!.execute({}, context('Odrade')));
  assert.ok(summary.includes(`- ${initiative.id} [approved]: Cross-repository change (0/2 merged; 1 open escalation)`), summary);
  const drafted = String(await tools.onionsoup_initiative!.execute({ action: 'draft', initiative: twoRepoDraft() }, context('Odrade')));
  const draftedId = /Drafted (i-\S+)\./.exec(drafted)![1]!;
  assert.deepEqual((await runtime.initiatives.get(draftedId)).origin, { sessionID: 'ses_Odrade', directory: '/chat' });
  await assert.rejects(tools.onionsoup_initiative!.execute({ action: 'draft', initiative: { title: 'x' } }, context('Odrade')), /initiative_invalid: goal/);
});
