import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { OperatorJobs } from '../src/operator-jobs.ts';
import { abandonOperatorChild, operatorRecoveryDigest, prepareOperatorRecovery } from '../src/operator-job-recovery.ts';
import { OperatorRecoveryPermissions } from '../src/operator-recovery-permission.ts';
import { OPERATOR_INVESTIGATOR, type OperatorSessionSnapshot, type OperatorSupervisorClient } from '../src/operator-jobs-types.ts';
import { operatorChildOccupiesSlot } from '../src/operator-scheduler.ts';
import { checkOperatorChildMessage, checkOperatorChildTool } from '../src/operator-child-scope.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'operator-recovery-'));
  const jobs = new OperatorJobs(directory, directory, 'Duncan');
  const origin = { operator: 'Duncan', sessionID: 'ses_parent', directory };
  const job = await jobs.create(origin, { messageID: 'msg_person', text: 'Investigate two files read-only.' }, {
    key: 'investigate', goal: 'Explain both files', constraints: ['No changes'], tasks: [
      { id: 'one', goal: 'Read file one', directory, access: 'read-only', dependsOn: [] },
      { id: 'two', goal: 'Read file two', directory, access: 'read-only', dependsOn: ['one'] },
    ],
  });
  await jobs.transaction(async (ledger, save) => {
    const stored = ledger.jobs[0]!;
    const child = stored.children[0]!;
    stored.status = 'blocked';
    child.sessionID = 'ses_child';
    child.status = 'blocked';
    child.blocker = 'operator_child_dispatch_uncertain';
    child.attempts.push({ id: 'attempt_one', messageID: 'msg_dispatch', createdAt: new Date().toISOString() });
    child.uncertainty = { kind: 'dispatch', since: new Date().toISOString(), observations: 3,
      lastObservedAt: new Date().toISOString(), nextCheckAt: new Date().toISOString(), needsDecision: true,
      reason: 'operator_child_dispatch_uncertain' };
    await save();
  });
  const observations: { snapshot: OperatorSessionSnapshot; unavailable: boolean } = { snapshot: { status: 'idle', messages: [] }, unavailable: false };
  let effects = 0;
  const client: OperatorSupervisorClient = {
    listSessions: async () => [],
    readSession: async () => {
      if (observations.unavailable) throw new Error('fixture_transport_unavailable');
      return observations.snapshot;
    },
    createSession: async () => { effects++; return { id: 'unexpected' }; },
    prompt: async () => { effects++; }, abort: async () => { effects++; },
  };
  const permissions = new OperatorRecoveryPermissions({ eventGraceMs: 1 });
  const approvals: Parameters<ToolContext['ask']>[0][] = [];
  const context = { sessionID: origin.sessionID, messageID: 'msg_recovery', abort: new AbortController().signal,
    metadata: () => {}, ask: async (request: Parameters<ToolContext['ask']>[0]) => {
      approvals.push(request);
      const permissionID = `per_recovery_${approvals.length}`;
      permissions.event({ type: 'permission.asked', properties: { ...request, id: permissionID, sessionID: origin.sessionID,
        tool: { messageID: 'msg_recovery', callID: `call_recovery_${approvals.length}` } } });
      permissions.event({ type: 'permission.replied', properties: { requestID: permissionID, sessionID: origin.sessionID, reply: 'once' } });
    } };
  const preview = () => prepareOperatorRecovery(jobs, client, origin, job.id, 'one');
  const abandon = (digest: string) => abandonOperatorChild(jobs, client, origin, job.id, 'one', digest,
    'Stop pursuing this exact uncertain child; preserve its unknown outcome.', context, permissions);
  return { directory, jobs, origin, job, observations, client, permissions, approvals, context, preview, abandon, effects: () => effects };
}

test('explicit native approval releases only the exact reservation once, retaining unknown history and fences', async () => {
  const f = await fixture();
  const before = await f.jobs.get(f.origin, f.job.id);
  const preview = await f.preview();
  assert.equal(preview.eligible, true);
  assert.match(preview.warning, /may still finish/);
  const abandoned = await f.abandon(preview.digest);
  assert.equal(abandoned.status, 'blocked');
  assert.equal(abandoned.children[0]!.status, 'abandoned');
  assert.equal(abandoned.children[1]!.status, 'queued');
  assert.deepEqual(abandoned.children[0]!.attempts, before.children[0]!.attempts, 'no false physical endedAt');
  assert.equal(abandoned.children[0]!.abandonment!.approval.permissionID, 'per_recovery_1');
  assert.equal(operatorChildOccupiesSlot(abandoned.children[0]!), false);
  assert.equal(operatorChildOccupiesSlot(before.children[0]!), true);
  assert.deepEqual(abandoned.intake, before.intake);
  assert.deepEqual(abandoned.constraints, before.constraints);
  assert.equal(abandoned.goal, before.goal);
  assert.equal(f.effects(), 0, 'recovery never creates, prompts, aborts or deletes a runtime session');
  assert.equal(f.approvals.length, 1);
  assert.deepEqual(f.approvals[0]!.always, []);
  assert.deepEqual(await f.abandon(preview.digest), abandoned);
  assert.equal(f.approvals.length, 1, 'duplicate call has no new approval or side effects');
  await assert.rejects(checkOperatorChildMessage(f.jobs, OPERATOR_INVESTIGATOR, 'ses_child', 'msg_dispatch'), /message_unbound/);
  await assert.rejects(checkOperatorChildTool(f.jobs, 'ses_child', 'read', { filePath: f.directory }), /not_running/);
});

test('permission denial and automatic allow cannot release an uncertain reservation', async () => {
  for (const mode of ['deny', 'auto-allow'] as const) {
    const f = await fixture();
    f.context.ask = async () => { if (mode === 'deny') throw new Error('person rejected'); };
    await assert.rejects(f.abandon((await f.preview()).digest), /not_approved|human_permission_unobserved/);
    const stored = await f.jobs.get(f.origin, f.job.id);
    assert.equal(stored.children[0]!.status, 'blocked');
    assert.equal(operatorChildOccupiesSlot(stored.children[0]!), true);
    assert.equal(stored.events.at(-1)!.kind, 'recovery-denied');
    assert.equal(f.effects(), 0);
  }
});

test('changed goal, parent, or a fresh receipt invalidates recovery without fabricating completion', async () => {
  const f = await fixture();
  const digest = (await f.preview()).digest;
  const ordinaryAsk = f.context.ask;
  f.context.ask = async request => {
    await ordinaryAsk(request);
    f.observations.snapshot.messages.push({ id: 'msg_dispatch', role: 'user', text: 'Exact prior prompt', tools: [] });
  };
  await assert.rejects(f.abandon(digest), /stale/);
  assert.equal((await f.jobs.get(f.origin, f.job.id)).children[0]!.status, 'blocked');
  await assert.rejects(abandonOperatorChild(f.jobs, f.client, { ...f.origin, sessionID: 'ses_other' }, f.job.id,
    'one', digest, 'Wrong parent', f.context, f.permissions), /origin_mismatch/);
  f.observations.snapshot.messages = [];
  await f.jobs.transaction(async (ledger, save) => {
    ledger.jobs[0]!.goal = 'Changed goal';
    await save();
  });
  await assert.rejects(f.abandon(digest), /stale/);
});

test('known foreign work remains protected even when a later metadata read fails', async () => {
  const f = await fixture();
  const digest = (await f.preview()).digest;
  await f.jobs.transaction(async (ledger, save) => {
    ledger.jobs[0]!.children[0]!.blocker = 'operator_child_foreign_work';
    await save();
  });
  f.observations.unavailable = true;
  const fresh = await f.preview();
  assert.equal(fresh.eligible, false);
  assert.equal(fresh.reason, 'foreign-work');
  assert.notEqual(fresh.digest, digest);
  await assert.rejects(f.abandon(fresh.digest), /not_eligible/);
  assert.equal(f.approvals.length, 0);
});

test('observed busy runtime without a receipt cannot release its reservation', async () => {
  const f = await fixture();
  f.observations.snapshot.status = 'busy';
  const preview = await f.preview();
  assert.equal(preview.eligible, false);
  assert.equal(preview.reason, 'busy');
  await assert.rejects(f.abandon(preview.digest), /not_eligible: busy/);
  assert.equal(f.approvals.length, 0);
  assert.equal(operatorChildOccupiesSlot((await f.jobs.get(f.origin, f.job.id)).children[0]!), true);
});

test('recovery inspection retains newly observed foreign work through later unavailable reads', async () => {
  const f = await fixture();
  const before = await f.jobs.get(f.origin, f.job.id);
  f.observations.snapshot.messages.push({ id: 'msg_foreign', role: 'user', text: 'Another task', tools: [] });
  const observed = await f.preview();
  assert.equal(observed.eligible, false);
  assert.equal(observed.reason, 'foreign-work');
  f.observations.unavailable = true;
  const repeated = await f.preview();
  assert.equal(repeated.eligible, false);
  assert.equal(repeated.reason, 'foreign-work');
  assert.equal(repeated.digest, observed.digest);
  await assert.rejects(f.abandon(repeated.digest), /not_eligible/);
  const protectedJob = await f.jobs.get(f.origin, f.job.id);
  assert.deepEqual(protectedJob.children[0]!.attempts, before.children[0]!.attempts);
  assert.equal(protectedJob.events.filter(event => event.detail === 'operator_child_foreign_work').length, 1);
  assert.equal(f.effects(), 0);
  assert.equal(f.approvals.length, 0);
});

test('human approval holds no ledger lock; concurrent pause invalidates that approval', async () => {
  const f = await fixture();
  let answer!: () => void;
  let appeared!: () => void;
  const pending = new Promise<void>(resolve => { appeared = resolve; });
  const humanAnswer = new Promise<void>(resolve => { answer = resolve; });
  const ordinaryAsk = f.context.ask;
  f.context.ask = async request => {
    appeared();
    await humanAnswer;
    await ordinaryAsk(request);
  };
  const action = f.abandon((await f.preview()).digest);
  const failure = assert.rejects(action, /stale/);
  await pending;
  await f.jobs.transaction(async (ledger, save) => {
    ledger.jobs[0]!.status = 'paused';
    await save();
  });
  answer();
  await failure;
  assert.equal((await f.jobs.get(f.origin, f.job.id)).status, 'paused');
});

test('poll timestamps do not change approval scope, but operation/evidence changes do', async () => {
  const f = await fixture();
  const job = await f.jobs.get(f.origin, f.job.id);
  const child = job.children[0]!;
  const digest = operatorRecoveryDigest(job, child);
  child.uncertainty!.lastObservedAt = new Date(0).toISOString();
  child.uncertainty!.observations++;
  assert.equal(operatorRecoveryDigest(job, child), digest);
  child.operation = { token: 'fresh_claim', kind: 'observe', startedAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
  assert.notEqual(operatorRecoveryDigest(job, child), digest);
});

test('concurrent exact approvals record one abandonment and retain the first permission audit', async () => {
  const f = await fixture();
  const digest = (await f.preview()).digest;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const ordinaryAsk = f.context.ask;
  let arrived = 0;
  f.context.ask = async request => {
    await ordinaryAsk(request);
    arrived++;
    if (arrived === 2) release();
    await barrier;
  };
  const [first, second] = await Promise.all([f.abandon(digest), f.abandon(digest)]);
  assert.deepEqual(first, second);
  const recorded = await f.jobs.get(f.origin, f.job.id);
  assert.equal(recorded.events.filter(event => event.kind === 'abandoned').length, 1);
  assert.deepEqual(recorded.children[0]!.abandonment, first.children[0]!.abandonment);
  assert.equal(f.effects(), 0);
});
