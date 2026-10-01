import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { processRequest } from '../src/brokering.ts';
import { delegatedWorkOutcome } from '../src/delegation.ts';
import { WorkItem } from '../src/ledger.ts';
import { obsoleteUnsubmittedWake, trackingRequestPreserved } from '../src/maintenance-tracking-proof.ts';
import { deliverOperatorJobWakes, operatorJobWakeCandidate, operatorJobWakeStatus, type Wake } from '../src/operator-job-wake.ts';
import { OperatorJobs, operatorJobEvent } from '../src/operator-jobs.ts';
import { OperatorJob } from '../src/operator-jobs-types.ts';
import { ResourceRequest } from '../src/requests.ts';
import { Runtime } from '../src/runtime.ts';

const at = '2026-04-01T12:00:00.000Z';
const proposal = { title: 'Scoped original task', goal: 'Preserve original evidence', rationale: 'Synthetic fixture',
  acceptance: ['No replay'], size: 'small' as const, repository: 'example/project' };
function request() {
  return ResourceRequest.parse({ id: 'r_fixture', from: 'bellonda', to: 'clippy', status: 'work-running',
    ask: { kind: 'work', purpose: proposal.goal, proposal }, workItem: 'w_fixture', followUp: 'none',
    operation: { id: 'operation_fixture', stage: 'work-running', startedAt: at }, createdAt: at, updatedAt: at });
}
function item() {
  return WorkItem.parse({ id: 'w_fixture', request: 'r_fixture', owner: 'clippy', workflow: 'owner-change',
    status: 'working', proposal, planWorktree: '/synthetic/worktree',
    session: { sessionID: 'ses_execution', directory: '/synthetic/worktree' },
    planDocument: { markdown: 'An approved implementation plan with differently worded goal', digest: 'plan_fixture' },
    planApproval: { by: 'fixture-person', at }, verdicts: [{ decision: 'revise', summary: 'Historical findings', findings: [] }],
    createdAt: at, updatedAt: at });
}
function job() {
  return OperatorJob.parse({ id: 'job_fixture', origin: { operator: 'Duncan', sessionID: 'ses_parent', directory: '/synthetic' },
    intake: { messageID: 'msg_intake', text: 'Make two separately reviewed changes' }, key: 'fixture',
    goal: 'Preserve unfinished edits', constraints: ['No integration before acceptance'], scope: 'scoped-write',
    createdAt: at, updatedAt: at, revision: 2, status: 'needs-review', children: [], events: [
      { id: 'event_created', at, kind: 'created', detail: 'Original task retained' },
      { id: 'event_review', at, kind: 'write-review', detail: 'One change awaits review' },
    ] });
}
function stale() {
  const current = job();
  const wake = operatorJobWakeCandidate(current)!;
  operatorJobEvent(current, 'write-accepted', 'Only one child accepted; other child remains unaccepted');
  return { current, wake };
}

test('a preserved tracking request executes only bookkeeping and retains different plan wording and revise history', async context => {
  const state = await mkdtemp(join(tmpdir(), 'maintenance-tracking-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state });
  runtime.hire = async () => { throw new Error('unexpected_model_execution'); };
  const work = item();
  await runtime.ledger.create(work.owner, work.workflow, work.proposal, work);
  await runtime.requests.save(request());
  const path = join(runtime.ledger.directory, `${work.id}.json`);
  const before = await readFile(path, 'utf8');
  assert.equal(trackingRequestPreserved(request(), work), true);
  await processRequest(runtime, request().id);
  const after = await runtime.requests.get(request().id);
  assert.equal(after.status, 'work-running');
  assert.equal(after.ask.kind, 'work');
  assert.deepEqual(after.ask, request().ask);
  assert.equal(after.operation?.runner, undefined);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(trackingRequestPreserved(after, await runtime.ledger.get(work.id)), true);
});

const itemChanges: Record<string, (work: WorkItem) => void> = {
  'different item': work => { work.id = 'other'; },
  'different request': work => { work.request = 'other'; },
  'different owner': work => { work.owner = 'other'; },
  'different repository': work => { work.proposal.repository = 'example/other'; },
  'different original goal': work => { work.proposal.goal = 'Different task'; },
  'other workflow': work => { work.workflow = 'rebase'; },
  'runner including zero': work => { work.activeRunner = 0; },
  'missing execution identity': work => { work.session = undefined; },
  'foreign execution directory': work => { work.session!.directory = '/foreign'; },
  'relative execution directory': work => { work.session!.directory = 'relative'; work.planWorktree = 'relative'; },
  'empty execution identity': work => { work.session!.sessionID = ''; },
  'pending publication': work => { work.deskPublication = { stage: 'open', reviewedHead: 'head', reviewedTree: 'tree', reviewer: 'fixture' }; },
  'queued execution': work => { work.status = 'landing'; },
  'planning': work => { work.status = 'planning'; },
  'interrupted': work => { work.status = 'interrupted'; },
  'failed': work => { work.status = 'failed'; },
};
for (const [name, change] of Object.entries(itemChanges)) {
  test(`tracking preservation rejects ${name}`, () => {
    const work = item();
    change(work);
    assert.equal(trackingRequestPreserved(request(), work), false);
  });
}

test('missing work, request runner, uncertain operation stage and new request stage remain blocked', () => {
  assert.equal(trackingRequestPreserved(request(), undefined), false);
  const variants = [
    { ...request(), operation: { ...request().operation!, runner: 0 } },
    { ...request(), operation: { ...request().operation!, stage: 'create-approved' as const } },
    { ...request(), status: 'pending-owner' as const },
    { ...request(), followUp: 'unknown' },
  ];
  for (const changed of variants) assert.equal(trackingRequestPreserved(changed, item()), false);
});

test('open publication preserves tracking but local merged or closed transitions are not observational', () => {
  const work = item();
  work.status = 'landed';
  work.publication = { url: 'https://github.com/example/project/pull/123', state: 'open', branch: 'fixture', by: 'fixture-person', at };
  assert.equal(trackingRequestPreserved(request(), work), true);
  work.publication.state = 'merged';
  assert.equal(delegatedWorkOutcome(work), 'completed');
  assert.equal(trackingRequestPreserved(request(), work), false);
  work.publication.state = 'closed';
  assert.equal(delegatedWorkOutcome(work), 'failed');
  assert.equal(trackingRequestPreserved(request(), work), false);
});

test('obsolete unsent write-review wake is preserved without changing job or wake bytes', () => {
  const { current, wake } = stale();
  const before = JSON.stringify({ current, wake });
  assert.equal(obsoleteUnsubmittedWake(wake, current), true);
  assert.equal(JSON.stringify({ current, wake }), before);
});
const wakeChanges: Record<string, (wake: Wake, current: OperatorJob) => void> = {
  'another job': wake => { wake.jobID = 'foreign'; },
  'another operator': wake => { wake.origin = { ...wake.origin, operator: 'foreign' }; },
  'another parent': wake => { wake.origin = { ...wake.origin, sessionID: 'ses_foreign' }; },
  'another directory': wake => { wake.origin = { ...wake.origin, directory: '/foreign' }; },
  'submitted message': wake => { wake.messageID = 'msg_sent'; },
  'empty submitted identity': wake => { wake.messageID = ''; },
  'sending without receipt': wake => { wake.status = 'sending'; },
  'uncertain reason': wake => { wake.reason = 'operator_job_wake_delivery_uncertain'; },
  'blocked status': wake => { wake.status = 'blocked'; },
  'missing old event': wake => { wake.eventID = 'event_missing'; },
  'invalid digest': wake => { wake.digest = 'invalid'; },
  'invalid revision': wake => { wake.revision = 0; },
  'wrong revision-event binding': wake => { wake.revision = 1; },
  'same revision': (wake, current) => { wake.revision = current.revision; },
  'future revision': (wake, current) => { wake.revision = current.revision + 1; },
  'changed event history': (_wake, current) => { current.events.splice(0, 1); },
  'duplicate event identity': (_wake, current) => { current.events[0]!.id = current.events[1]!.id; },
  'non-actionable old event': (_wake, current) => { current.events[1]!.kind = 'created'; },
  'new actionable continuation': (_wake, current) => { operatorJobEvent(current, 'ready', 'New actionable event'); },
};
for (const [name, change] of Object.entries(wakeChanges)) {
  test(`obsolete wake proof rejects ${name}`, () => {
    const { current, wake } = stale();
    change(wake, current);
    assert.equal(obsoleteUnsubmittedWake(wake, current), false);
  });
}

test('ordinary delivery ignores retained obsolete unsent row across a store reopen', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-wake-proof-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = new OperatorJobs(join(directory, 'state'), directory, 'Duncan');
  const origin = { operator: 'Duncan', sessionID: 'ses_parent', directory };
  const opened = await jobs.create(origin, { messageID: 'msg_intake', text: 'Investigate without edits' },
    { key: 'fixture', goal: 'Inspect code', constraints: ['No writes'], tasks: [
      { id: 'first', goal: 'Inspect source', directory, access: 'read-only', dependsOn: [] },
    ] });
  await jobs.transaction(async (ledger, save) => {
    operatorJobEvent(ledger.jobs[0]!, 'progress', 'Progress ready');
    await save();
  });
  let prompts = 0;
  const client = { exists: async () => true, messages: async () => [], idle: async () => false,
    prompt: async () => { prompts++; } };
  const onError = (_id: string, error: unknown) => { throw error; };
  await deliverOperatorJobWakes(jobs, client, onError);
  const before = await operatorJobWakeStatus(jobs, opened.id);
  assert.equal(before.length, 1);
  await jobs.transaction(async (ledger, save) => {
    operatorJobEvent(ledger.jobs[0]!, 'write-accepted', 'A newer event does not need a wake');
    await save();
  });
  const reopened = new OperatorJobs(jobs.home, directory, 'Duncan');
  assert.equal(obsoleteUnsubmittedWake(before[0]!, await reopened.get(origin, opened.id)), true);
  client.idle = async () => true;
  await deliverOperatorJobWakes(reopened, client, onError);
  assert.equal(prompts, 0);
  assert.deepEqual(await operatorJobWakeStatus(reopened, opened.id), before);
  await jobs.transaction(async (ledger, save) => {
    operatorJobEvent(ledger.jobs[0]!, 'ready', 'Fresh continuation invalidates preservation');
    await save();
  });
  assert.equal(obsoleteUnsubmittedWake(before[0]!, await reopened.get(origin, opened.id)), false);
});
