import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deliverOperatorJobWakes, operatorJobWakeStatus } from '../src/operator-job-wake.ts';
import { OperatorJobs, operatorJobEvent } from '../src/operator-jobs.ts';
import type { OperatorJob, OperatorJobEvent } from '../src/operator-jobs-types.ts';
import type { PlanRevisionClient } from '../src/plan-revision.ts';

async function setup(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'operator-wake-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = new OperatorJobs(join(directory, 'home'), directory, 'Duncan');
  const origin = { operator: 'Duncan', sessionID: 'ses_parent', directory };
  const create = (key: string) => jobs.create(origin, { messageID: `msg_human_${key}`, text: 'Investigate two independent code paths, without edits.' },
    { key, goal: 'Explain both code paths', constraints: ['No edits'], tasks: [{ id: 'first', goal: 'Inspect source', directory, access: 'read-only', dependsOn: [] }] });
  const job = await create('original');
  const event = async (kind: OperatorJobEvent['kind'], status?: OperatorJob['status']) => jobs.transaction(async (ledger, save) => {
    const current = ledger.jobs.find(entry => entry.id === job.id)!;
    if (status) current.status = status;
    operatorJobEvent(current, kind, `Fixture ${kind}`);
    await save();
  });
  const messages: string[] = [];
  const calls: Array<{ text: string; id: string }> = [];
  const state = { exists: true, idle: true, accept: true, fail: false, beforeIdle: async () => {} };
  const client: PlanRevisionClient = {
    exists: async target => { assert.equal(target.sessionID, origin.sessionID); assert.equal(target.directory, directory); return state.exists; },
    messages: async () => [...messages],
    idle: async () => { await state.beforeIdle(); return state.idle; },
    prompt: async (target, agent, text, id) => {
      assert.equal(target.sessionID, origin.sessionID);
      assert.equal(target.directory, directory);
      assert.equal(agent, 'Duncan');
      calls.push({ text, id });
      if (state.accept) messages.push(id);
      if (state.fail) throw new Error('fixture_lost_response');
    },
  };
  const deliver = (instance = jobs) => deliverOperatorJobWakes(instance, client, (_id, error) => { throw error; });
  return { jobs, job, create, origin, event, client, messages, calls, state, deliver, directory };
}

test('operator wakes deliver one durable actionable continuation across races and restart', async context => {
  const fixture = await setup(context);
  await fixture.event('progress');
  const reopened = new OperatorJobs(fixture.jobs.home, fixture.directory, 'Duncan');
  await Promise.all([fixture.deliver(), fixture.deliver(reopened)]);
  await fixture.deliver(reopened);
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].id, /^msg_[a-f0-9]{26}$/);
  assert.match(fixture.calls[0].text, /runtime continuation, not a new user request or approval/);
  assert.match(fixture.calls[0].text, /Child conclusions are model claims/);
  assert.match(fixture.calls[0].text, /Read the current job with onionsoup_operator_job/);
  const receipts = await operatorJobWakeStatus(reopened, fixture.job.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'delivered');
  assert.equal((await reopened.get(fixture.origin, fixture.job.id)).intake.text, fixture.job.intake.text);
});

test('operator job creation is not a wake; busy parent coalesces progress into latest ready event', async context => {
  const fixture = await setup(context);
  await fixture.deliver();
  assert.equal(fixture.calls.length, 0);
  fixture.state.idle = false;
  await fixture.event('progress');
  await fixture.deliver();
  await fixture.event('ready', 'needs-synthesis');
  fixture.state.idle = true;
  await fixture.deliver();
  assert.equal(fixture.calls.length, 1);
  const receipts = await operatorJobWakeStatus(fixture.jobs, fixture.job.id);
  assert.deepEqual(receipts.map(entry => entry.status), ['superseded', 'delivered']);
  const job = await fixture.jobs.get(fixture.origin, fixture.job.id);
  assert.match(fixture.calls[0].text, new RegExp(job.events.at(-1)!.id));
});

test('operator wake pre-send origin failures retry only when parent is available and idle', async context => {
  const fixture = await setup(context);
  await fixture.event('blocked', 'blocked');
  fixture.state.exists = false;
  await fixture.deliver();
  assert.equal((await operatorJobWakeStatus(fixture.jobs, fixture.job.id))[0].reason, 'operator_job_wake_origin_unavailable');
  fixture.state.exists = true;
  fixture.state.idle = false;
  await fixture.deliver();
  assert.equal(fixture.calls.length, 0);
  fixture.state.idle = true;
  await fixture.deliver();
  assert.equal(fixture.calls.length, 1);
});

test('lost response reconciles receipt and unobserved uncertainty never retries or sends later parent wakes', async context => {
  for (const accept of [true, false]) {
    const fixture = await setup(context);
    fixture.state.accept = accept;
    fixture.state.fail = true;
    await fixture.event('progress');
    await fixture.deliver();
    const reopened = new OperatorJobs(fixture.jobs.home, fixture.directory, 'Duncan');
    await fixture.deliver(reopened);
    assert.equal(fixture.calls.length, 1);
    assert.equal((await operatorJobWakeStatus(reopened, fixture.job.id))[0].status, accept ? 'delivered' : 'blocked');
    if (!accept) {
      await fixture.event('ready', 'needs-synthesis');
      await fixture.deliver(reopened);
      assert.equal(fixture.calls.length, 1);
      const pending = (await operatorJobWakeStatus(reopened, fixture.job.id)).at(-1)!;
      assert.equal(pending.reason, 'operator_job_wake_parent_delivery_uncertain');
      fixture.messages.push(fixture.calls[0].id);
      fixture.state.accept = true;
      fixture.state.fail = false;
      await fixture.deliver(reopened);
      assert.equal(fixture.calls.length, 2);
    }
  }
});

test('a changed or cancelled job while checking idle supersedes old wake without inference', async context => {
  for (const status of ['cancelled', 'completed'] as const) {
    const fixture = await setup(context);
    await fixture.event('ready', 'needs-synthesis');
    fixture.state.beforeIdle = async () => fixture.event(status === 'cancelled' ? 'cancelled' : 'synthesized', status);
    await fixture.deliver();
    assert.equal(fixture.calls.length, 0);
    assert.equal((await operatorJobWakeStatus(fixture.jobs, fixture.job.id))[0].status, 'superseded');
  }
});

test('completed, cancelled and paused jobs do not loop; attempted receipt survives job completion', async context => {
  const fixture = await setup(context);
  await fixture.event('ready', 'needs-synthesis');
  fixture.state.accept = false;
  await fixture.deliver();
  await fixture.event('synthesized', 'completed');
  fixture.messages.push(fixture.calls[0].id);
  await fixture.deliver();
  assert.equal((await operatorJobWakeStatus(fixture.jobs, fixture.job.id))[0].status, 'delivered');
  await fixture.event('paused', 'paused');
  await fixture.deliver();
  await fixture.event('cancelled', 'cancelled');
  await fixture.deliver();
  assert.equal(fixture.calls.length, 1);
});

test('changed configured operator cannot receive another operators durable job wakes', async context => {
  const fixture = await setup(context);
  await fixture.event('progress');
  const other = new OperatorJobs(fixture.jobs.home, fixture.directory, 'Other operator');
  await fixture.deliver(other);
  assert.equal(fixture.calls.length, 0);
  const contents = JSON.parse(await readFile(fixture.jobs.path, 'utf8'));
  assert.equal(contents.jobs[0].origin.operator, 'Duncan');
});

test('uncertain parent delivery blocks another job in that parent but preserves both durable event histories', async context => {
  const fixture = await setup(context);
  fixture.state.accept = false;
  await fixture.event('blocked', 'blocked');
  await fixture.deliver();
  const second = await fixture.create('second');
  await fixture.jobs.transaction(async (ledger, save) => {
    const job = ledger.jobs.find(entry => entry.id === second.id)!;
    operatorJobEvent(job, 'progress', 'Second child has evidence');
    await save();
  });
  await fixture.deliver();
  assert.equal(fixture.calls.length, 1);
  assert.equal((await operatorJobWakeStatus(fixture.jobs, second.id))[0].reason, 'operator_job_wake_parent_delivery_uncertain');
  assert.equal((await fixture.jobs.get(fixture.origin, second.id)).events.at(-1)!.detail, 'Second child has evidence');
  fixture.messages.push(fixture.calls[0].id);
  fixture.state.accept = true;
  await fixture.deliver();
  assert.equal(fixture.calls.length, 2);
  assert.equal((await operatorJobWakeStatus(fixture.jobs, second.id))[0].status, 'delivered');
});

test('a later actionable event gets a new receipt while original delivered evidence stays immutable', async context => {
  const fixture = await setup(context);
  await fixture.event('progress');
  await fixture.deliver();
  const first = (await operatorJobWakeStatus(fixture.jobs, fixture.job.id))[0];
  await fixture.event('ready', 'needs-synthesis');
  await fixture.deliver();
  await fixture.deliver();
  const receipts = await operatorJobWakeStatus(fixture.jobs, fixture.job.id);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(receipts[0], first);
  assert.notEqual(receipts[1].messageID, first.messageID);
  assert.notEqual(receipts[1].digest, first.digest);
  assert.equal(receipts[1].status, 'delivered');
});

test('write review wakes the parent once to present the exact diff and request human acceptance without changing lifecycle', async context => {
  const fixture = await setup(context);
  await fixture.event('write-review', 'needs-review');
  fixture.state.idle = false;
  await fixture.deliver();
  assert.equal(fixture.calls.length, 0);
  fixture.state.idle = true;
  await fixture.deliver();
  await fixture.deliver();
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].text, /host-recorded diff, baseline head, allowed paths/);
  assert.match(fixture.calls[0].text, /native Allow once decision/);
  assert.match(fixture.calls[0].text, /Do not synthesize while required human acceptance is pending/);
  const persisted = await fixture.jobs.get(fixture.origin, fixture.job.id);
  assert.equal(persisted.status, 'needs-review');
  assert.equal(persisted.synthesis, undefined);
  assert.equal((await operatorJobWakeStatus(fixture.jobs, fixture.job.id))[0].status, 'delivered');
});
