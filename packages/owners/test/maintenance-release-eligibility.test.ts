import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { requestCanRun } from '../src/brokering.ts';
import { WorkItem } from '../src/ledger.ts';
import { inspectMaintenanceReleaseInventory, assertMaintenanceReleaseInventoryUnchanged } from '../src/maintenance-release-inventory.ts';
import { ResourceRequest, type RequestStatus } from '../src/requests.ts';

const observedAt = '2026-04-01T12:00:00.000Z';
const observedMs = Date.parse(observedAt);
const dueAt = '2026-04-01T12:01:00.000Z';
const dueMs = Date.parse(dueAt);
const proposal = { title: 'Synthetic repair', goal: 'Preserve scoped behavior', rationale: 'Fixture only',
  acceptance: ['Retain evidence without replay'], size: 'small' };

async function fixture(context: TestContext) {
  const state = await mkdtemp(join(tmpdir(), 'maintenance-eligibility-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const save = async (path: string, record: unknown) => {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), JSON.stringify(record, null, 2) + '\n');
  };
  const contents = (path: string) => readFile(join(state, path), 'utf8');
  return { state, save, contents };
}

function request(status: RequestStatus, runner?: number) {
  return ResourceRequest.parse({ id: 'request_fixture', from: 'coordinator', to: 'specialist', status,
    ask: { kind: 'work', purpose: 'Synthetic scoped request', proposal }, workItem: 'work_fixture',
    followUp: 'none', createdAt: observedAt, updatedAt: observedAt,
    approvals: [{ step: 'create', by: 'fixture-person', at: observedAt }],
    operation: { id: 'operation_fixture', stage: 'work-running', startedAt: observedAt, runner,
      checkpoint: { jobId: 17, publication: { commit: 'a'.repeat(40), previous: 'b'.repeat(40), digest: 'evidence_fixture' } } },
    recovery: [{ by: 'fixture-person', action: 'inspect', reason: 'Preserve prior unknown outcome', at: observedAt }],
  });
}

function reminder(id = 'reminder_fixture', deadline = dueAt) {
  return { id, owner: 'specialist', prompt: 'Synthetic future task', status: 'pending',
    dueAt: deadline, createdAt: observedAt, updatedAt: observedAt };
}

function work(status: 'working' | 'landed' = 'working') {
  return WorkItem.parse({ id: 'work_fixture', owner: 'specialist', workflow: 'owner-change', status, proposal,
    session: { sessionID: 'ses_fixture', directory: '/synthetic/project' }, createdAt: observedAt, updatedAt: observedAt });
}

function wake(messageID?: string) {
  return { jobID: 'job_fixture', origin: { operator: 'operator', sessionID: 'ses_parent', directory: '/synthetic/project' },
    eventID: 'event_fixture', digest: 'd'.repeat(64), revision: 1, status: messageID ? 'blocked' : 'pending',
    messageID, reason: messageID ? 'operator_job_wake_delivery_uncertain' : undefined };
}

const inertStatuses: RequestStatus[] = ['declined', 'denied', 'deleted', 'published', 'updated', 'failed', 'completed',
  'awaiting-create-approval', 'awaiting-delete-approval'];
for (const status of inertStatuses) {
  test(`${status} request retains historical operation and evidence without becoming runnable`, async context => {
    const { state, save, contents } = await fixture(context);
    const path = 'requests/request_fixture.json';
    const record = request(status);
    await save(path, record);
    const original = await contents(path);
    const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
    assert.equal(requestCanRun(record), false);
    assert.equal(inventory.eligible, true);
    assert.notEqual(inventory.decisions.find(entry => entry.resource === path)?.classification, 'blocked');
    assert.equal(await contents(path), original);
    assert.deepEqual(await readdir(join(state, 'requests')), ['request_fixture.json']);
  });
}

for (const runner of [process.pid, 2_147_483_647, 0]) {
  test(`terminal request with unresolved runner ${runner === process.pid ? 'current process' : runner} remains blocked`, async context => {
    const { state, save, contents } = await fixture(context);
    const path = 'requests/request_fixture.json';
    await save(path, request('completed', runner));
    const original = await contents(path);
    const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
    assert.equal(inventory.eligible, false);
    assert.equal(inventory.decisions[0]?.reason, 'request_runner_unresolved');
    assert.equal(await contents(path), original);
  });
}

test('interrupted request with an unresolved historical operation is not exempted as terminal', async context => {
  const { state, save, contents } = await fixture(context);
  const path = 'requests/request_fixture.json';
  await save(path, request('interrupted'));
  const original = await contents(path);
  const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  assert.equal(inventory.eligible, false);
  assert.equal(inventory.decisions[0]?.reason, 'request_continuation_gate');
  assert.equal(await contents(path), original);
});

for (const status of ['working', 'landed'] as const) {
  test(`tracking request remains blocked even when linked work is ${status} without a runner`, async context => {
    const { state, save, contents } = await fixture(context);
    await save('requests/request_fixture.json', request('work-running'));
    await save('items/work_fixture.json', work(status));
    const before = await contents('requests/request_fixture.json');
    const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
    assert.equal(inventory.eligible, false);
    assert.equal(inventory.decisions.find(entry => entry.resource === 'requests/request_fixture.json')?.reason,
      'request_continuation_gate');
    assert.equal(await contents('requests/request_fixture.json'), before);
  });
}

test('future unclaimed reminder is eligible only before its exact deadline and remains pending', async context => {
  const { state, save, contents } = await fixture(context);
  const path = 'reminders/reminder_fixture.json';
  await save(path, reminder());
  const original = await contents(path);
  const before = await inspectMaintenanceReleaseInventory(state, { now: () => dueMs - 1 });
  assert.equal(before.eligible, true);
  assert.equal(before.validUntil, dueAt);
  assert.equal(before.decisions[0]?.classification, 'time-gated');
  assert.equal(before.decisions[0]?.reason, 'reminder_not_due');
  const at = await inspectMaintenanceReleaseInventory(state, { now: () => dueMs });
  assert.equal(at.eligible, false);
  const after = await inspectMaintenanceReleaseInventory(state, { now: () => dueMs + 1 });
  assert.equal(after.eligible, false);
  assert.equal(await contents(path), original);
  assert.deepEqual(await readdir(state), ['reminders']);
});

test('future reminder deadline binds the earliest eligible reminder and does not drift with preview time', async context => {
  const { state, save } = await fixture(context);
  await save('reminders/reminder_later.json', reminder('reminder_later', '2026-04-02T12:00:00.000Z'));
  await save('reminders/reminder_fixture.json', reminder());
  const first = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  const second = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs + 1 });
  assert.equal(first.validUntil, dueAt);
  assert.equal(first.digest, second.digest);
  assert.equal((await assertMaintenanceReleaseInventoryUnchanged(state, first.digest,
    { now: () => dueMs - 1 })).digest, first.digest);
});

test('crossing a future reminder deadline while collecting evidence rejects the torn time snapshot', async context => {
  const { state, save, contents } = await fixture(context);
  await save('reminders/reminder_fixture.json', reminder());
  const original = await contents('reminders/reminder_fixture.json');
  let clock = dueMs - 1;
  await assert.rejects(inspectMaintenanceReleaseInventory(state, { now: () => clock,
    afterSnapshot: async () => { clock = dueMs; } }), /maintenance_inventory_expired/);
  assert.equal(await contents('reminders/reminder_fixture.json'), original);
});

test('unchanged bytes do not make an expired reminder approval digest valid', async context => {
  const { state, save } = await fixture(context);
  await save('reminders/reminder_fixture.json', reminder());
  const prepared = await inspectMaintenanceReleaseInventory(state, { now: () => dueMs - 1 });
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state, prepared.digest,
    { now: () => dueMs }), /maintenance_inventory_(changed|expired|blocked)/);
});

test('concurrent terminal-to-tracking transition invalidates the snapshot instead of using historical exemption', async context => {
  const { state, save } = await fixture(context);
  await save('requests/request_fixture.json', request('completed'));
  await assert.rejects(inspectMaintenanceReleaseInventory(state, { now: () => observedMs,
    afterSnapshot: () => save('requests/request_fixture.json', request('work-running')) }), /maintenance_inventory_changed/);
  assert.equal((await inspectMaintenanceReleaseInventory(state, { now: () => observedMs })).eligible, false);
});

test('moving a reminder deadline or changing retained recovery evidence invalidates the prepared digest', async context => {
  const { state, save } = await fixture(context);
  await save('reminders/reminder_fixture.json', reminder());
  await save('requests/request_fixture.json', request('completed'));
  const prepared = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  await save('reminders/reminder_fixture.json', reminder('reminder_fixture', '2026-04-02T12:00:00.000Z'));
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state, prepared.digest,
    { now: () => observedMs }), /maintenance_inventory_changed/);
  const revised = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  const changed = request('completed');
  changed.recovery.push({ by: 'fixture-person', action: 'inspect', reason: 'New evidence', at: observedAt });
  await save('requests/request_fixture.json', changed);
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state, revised.digest,
    { now: () => observedMs }), /maintenance_inventory_changed/);
});

for (const kept of ['kept-uncommitted', 'kept-unpublished', 'failed'] as const) {
  test(`finished worktree marked ${kept} remains protected pending independent workspace proof`, async context => {
    const { state, save, contents } = await fixture(context);
    const path = 'items/work_fixture.json';
    await save(path, { ...work('landed'), planWorktree: '/synthetic/protected-worktree', planWorktreeKept: kept,
      publication: { url: 'https://example.invalid/pull/7', branch: 'fixture', by: 'fixture-person',
        at: observedAt, state: 'merged' } });
    const original = await contents(path);
    const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
    assert.equal(inventory.eligible, false);
    assert.equal(inventory.decisions[0]?.reason, 'plan_cleanup_requires_separate_evidence');
    assert.equal(await contents(path), original);
  });
}

test('pending operator wake without message identity stays pending and blocks release', async context => {
  const { state, save, contents } = await fixture(context);
  const path = 'operator-job-wakes/wakes.json';
  await save(path, [wake()]);
  const original = await contents(path);
  const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  assert.equal(inventory.eligible, false);
  assert.equal(inventory.decisions[0]?.reason, 'job_wake_unsubmitted');
  assert.equal(await contents(path), original);
});

test('uncertain claimed operator wake retains its exact native message claim without claiming completion', async context => {
  const { state, save, contents } = await fixture(context);
  const path = 'operator-job-wakes/wakes.json';
  await save(path, [wake('msg_unknown')]);
  const original = await contents(path);
  const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  assert.equal(inventory.eligible, true);
  assert.equal(inventory.decisions[0]?.classification, 'single-use-protected');
  assert.equal(inventory.decisions[0]?.reason, 'job_wake_submission_claim_retained');
  assert.equal(await contents(path), original);
});

test('mixed production-shaped inventory resolves inert history and future reminders while keeping independent blockers', async context => {
  const { state, save, contents } = await fixture(context);
  const updated = ResourceRequest.parse({ ...request('updated'), id: 'request_update',
    ask: { kind: 'update-app', app: 'fixture-app', fromVersion: '1', toVersion: '2', purpose: 'Fixture update' } });
  const deleted = ResourceRequest.parse({ ...request('deleted'), id: 'request_delete',
    ask: { kind: 'instance', image: 'fixture-image', purpose: 'Fixture instance', expectedMinutes: 5 } });
  const records: Record<string, unknown> = {
    'requests/request_fixture.json': request('completed'),
    'requests/request_update.json': updated,
    'requests/request_delete.json': deleted,
    'requests/request_tracking.json': { ...request('work-running'), id: 'request_tracking' },
    'reminders/reminder_fixture.json': reminder(),
    'items/work_fixture.json': { ...work('landed'), planWorktree: '/synthetic/protected-worktree',
      planWorktreeKept: 'kept-unpublished', publication: { url: 'https://example.invalid/pull/7',
        branch: 'fixture', by: 'fixture-person', at: observedAt, state: 'merged' } },
    'operator-job-wakes/wakes.json': [wake()],
  };
  for (const [path, record] of Object.entries(records)) await save(path, record);
  const original = await Promise.all(Object.keys(records).map(contents));
  const inventory = await inspectMaintenanceReleaseInventory(state, { now: () => observedMs });
  assert.equal(inventory.eligible, false);
  assert.equal(inventory.validUntil, dueAt);
  assert.deepEqual(inventory.decisions.filter(entry => entry.classification === 'blocked').map(entry => entry.reason).sort(),
    ['job_wake_unsubmitted', 'plan_cleanup_requires_separate_evidence', 'request_continuation_gate']);
  assert.equal(inventory.decisions.filter(entry => entry.classification === 'time-gated').length, 1);
  assert.equal(inventory.decisions.filter(entry => entry.classification === 'terminal').length, 3);
  assert.deepEqual(await Promise.all(Object.keys(records).map(contents)), original);
});
