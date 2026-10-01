import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectMaintenanceReleaseInventory, assertMaintenanceReleaseInventoryUnchanged,
  MAINTENANCE_RELEASE_STORES } from '../src/maintenance-release-inventory.ts';
import { SessionOpeningStore } from '../src/session-opening-store.ts';
import { OperatorJobs } from '../src/operator-jobs.ts';

async function fixture(context: TestContext) {
  const state = await mkdtemp(join(tmpdir(), 'maintenance-inventory-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const save = async (path: string, record: unknown) => {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), JSON.stringify(record));
  };
  return { state, save };
}
const now = '2026-01-01T00:00:00.000Z';
function item(status = 'planning') {
  return { id: 'work_fixture', owner: 'specialist', workflow: 'owner-change', status,
    proposal: { title: 'Fixture', goal: 'Preserve the exact goal', rationale: 'Synthetic recovery test',
      acceptance: ['No replay'], size: 'small' }, createdAt: now, updatedAt: now };
}

test('absent stores are explicitly bound without creating directories or state', async context => {
  const { state } = await fixture(context);
  const proof = await inspectMaintenanceReleaseInventory(state);
  assert.equal(proof.eligible, true);
  assert.equal(proof.entries.length, MAINTENANCE_RELEASE_STORES.length);
  assert.ok(proof.entries.every(entry => entry.type === 'absent'));
  assert.deepEqual(await readdir(state), []);
  assert.equal((await assertMaintenanceReleaseInventoryUnchanged(state, proof.digest)).digest, proof.digest);
});

test('legacy missing opening claims block; actual ambiguous durable claims prevent a second reserve', async context => {
  const { state, save } = await fixture(context);
  await save('items/work_fixture.json', item());
  assert.equal((await inspectMaintenanceReleaseInventory(state)).decisions[0].reason, 'legacy_opening_without_single_use_claim');
  const store = new SessionOpeningStore(state);
  const key = { entity: 'owner-item' as const, id: 'work_fixture', owner: 'specialist', kind: 'planning' as const };
  const reservation = (await store.reserve(key))!;
  await store.advance(reservation, 'creating');
  await store.failed(reservation);
  const before = await readFile(store.path(key), 'utf8');
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
  assert.equal(await store.reserve(key), undefined);
  assert.equal(await readFile(store.path(key), 'utf8'), before);
  assert.equal((await store.read(key))?.phase, 'uncertain');
});

test('a proven unstarted opening is retryable and therefore remains a release blocker', async context => {
  const { state, save } = await fixture(context);
  await save('items/work_fixture.json', item());
  const store = new SessionOpeningStore(state);
  const key = { entity: 'owner-item' as const, id: 'work_fixture', owner: 'specialist', kind: 'planning' as const };
  const reservation = (await store.reserve(key))!;
  await store.failed(reservation);
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
  assert.ok(await store.reserve(key));
});

test('pending reminders are not made fired and completed records remain byte identical', async context => {
  const { state, save } = await fixture(context);
  const path = 'reminders/reminder_fixture.json';
  const reminder = { id: 'reminder_fixture', owner: 'specialist', prompt: 'Synthetic reminder', status: 'pending',
    dueAt: now, createdAt: now, updatedAt: now };
  await save(path, reminder);
  const before = await readFile(join(state, path), 'utf8');
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
  assert.equal(await readFile(join(state, path), 'utf8'), before);
  await save(path, { ...reminder, status: 'cancelled', cancelled: { by: 'fixture', note: 'Already cancelled', at: now } });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
});

test('native wake claim stays uncertain; pending wakes and exchange retries require evidence', async context => {
  const { state, save } = await fixture(context);
  const wake = { request: 'request_fixture', item: 'work_fixture', reviewer: 'coordinator', digest: 'binding',
    status: 'blocked', reason: 'direct_review_wake_delivery_uncertain', messageID: 'msg_fixture' };
  const wakePath = `direct-request-review-wakes/${createHash('sha256').update(JSON.stringify([wake.request, wake.digest])).digest('hex')}.json`;
  await save(wakePath, wake);
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
  await save(wakePath, { ...wake, messageID: undefined, status: 'pending' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
  await rm(join(state, 'direct-request-review-wakes'), { recursive: true });
  const notice = { id: 'notice_fixture', owner: 'specialist', text: 'Synthetic notice', at: now };
  await save('notices/exchanges/pending/notice_fixture.json', notice);
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
  await rm(join(state, 'notices/exchanges/pending'), { recursive: true });
  await save('notices/exchanges/delivered/notice_fixture.json', notice);
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
});

test('new work, removed stores and changed receipt bytes invalidate the prepared digest', async context => {
  const { state, save } = await fixture(context);
  const empty = await inspectMaintenanceReleaseInventory(state);
  await save('items/work_fixture.json', item('cancelled'));
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state, empty.digest), /maintenance_inventory_changed/);
  const previous = await inspectMaintenanceReleaseInventory(state);
  await save('items/work_fixture.json', { ...item('cancelled'), reason: 'New evidence' });
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state, previous.digest), /maintenance_inventory_changed/);
  const changed = await inspectMaintenanceReleaseInventory(state);
  await rm(join(state, 'items'), { recursive: true });
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state, changed.digest), /maintenance_inventory_changed/);
});

test('queued and uncertain operator children cannot be treated as completed by release', async context => {
  const { state } = await fixture(context);
  const jobs = new OperatorJobs(state, state, 'Duncan');
  const origin = { operator: 'Duncan', sessionID: 'ses_fixture', directory: state };
  await jobs.create(origin, { messageID: 'msg_fixture', text: 'Inspect synthetic files' },
    { key: 'fixture', goal: 'Inspect files', constraints: [], tasks: [
      { id: 'child', goal: 'Read source', directory: state, access: 'read-only', dependsOn: [] }] });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
  await jobs.transaction(async (ledger, save) => {
    ledger.jobs[0].status = 'completed';
    ledger.jobs[0].children[0].status = 'completed';
    await save();
  });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
  await jobs.transaction(async (ledger, save) => {
    ledger.jobs[0].children[0].attempts.push({ id: 'attempt', messageID: 'msg_unknown', createdAt: now });
    await save();
  });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
});

test('malformed records, symlinks and unknown continuation files fail closed', async context => {
  const { state, save } = await fixture(context);
  await save('operator-jobs/future-format.json', { meaning: 'unknown' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).decisions[0].reason, 'unrecognized_continuation_file');
  await rm(join(state, 'operator-jobs'), { recursive: true });
  await save('items/broken.json', { status: 'completed' });
  await assert.rejects(inspectMaintenanceReleaseInventory(state));
  await rm(join(state, 'items'), { recursive: true });
  await symlink(state, join(state, 'items'));
  await assert.rejects(inspectMaintenanceReleaseInventory(state), /maintenance_inventory_unsupported_file/);
});

test('new human work between inventory reads is rejected rather than given the old classification', async context => {
  const { state, save } = await fixture(context);
  await assert.rejects(inspectMaintenanceReleaseInventory(state, {
    afterSnapshot: () => save('items/work_fixture.json', item()),
  }), /maintenance_inventory_changed/);
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
});

test('mismatched resource filenames and symlinked nested store parents cannot hide continuations', async context => {
  const { state, save } = await fixture(context);
  await save('items/other.json', item('cancelled'));
  await assert.rejects(inspectMaintenanceReleaseInventory(state), /maintenance_inventory_identity/);
  await rm(join(state, 'items'), { recursive: true });
  await symlink(state, join(state, 'attention'));
  await assert.rejects(inspectMaintenanceReleaseInventory(state), /maintenance_inventory_parent_invalid/);
});

test('terminal revision history is preserved while unsent delivery cannot silently resume', async context => {
  const { state, save } = await fixture(context);
  const revision = { id: 'revision_fixture', item: 'work_fixture', owner: 'specialist', expected: 'binding', plan: 'plan',
    feedback: 'Synthetic narrower approach', note: { kind: 'plan-feedback', by: 'fixture', at: now, note: 'Synthetic' },
    status: 'suppressed', journaled: true };
  const path = `plan-revisions/${createHash('sha256').update(revision.item).digest('hex')}.json`;
  await save(path, revision);
  const contents = await readFile(join(state, path), 'utf8');
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
  assert.equal(await readFile(join(state, path), 'utf8'), contents);
  await save(path, { ...revision, status: 'pending' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
  await save(path, { ...revision, status: 'blocked', submitted: true, messageID: 'msg_bound', reason: 'plan_revision_delivery_uncertain' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
});

test('stale seen maps cannot regenerate a delivered work notice or its manager copy', async context => {
  const { state, save } = await fixture(context);
  const work = { ...item('failed'), assignment: { initiative: 'initiative_fixture', assignment: 'assignment_fixture' } };
  await save('items/work_fixture.json', work);
  await save('notices/seen.json', { work_fixture: 'working|' });
  await save('notices/delivered/work_fixture-failed.json', { id: 'work_fixture-failed', owner: 'specialist',
    workItem: 'work_fixture', change: 'failed', text: 'Synthetic already delivered notice', at: now });
  const inventory = await inspectMaintenanceReleaseInventory(state);
  assert.equal(inventory.eligible, false);
  assert.equal(inventory.decisions.find(entry => entry.resource === 'notices/seen.json')?.reason,
    'work_notice_regeneration_requires_evidence');
  await save('notices/seen.json', { work_fixture: 'failed|' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
});

test('request progress history uses its existing schema and unresolved pending cursor remains blocked', async context => {
  const { state, save } = await fixture(context);
  await save('notices/request-progress/baseline.json', { version: 1, observedAt: now, fingerprints: { request: 'fingerprint' } });
  const path = `notices/request-progress/${'a'.repeat(64)}.json`;
  await save(path, { sequence: 1, fingerprint: 'fingerprint' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
  await save(path, { sequence: 1, fingerprint: 'fingerprint', pending: {
    id: 'msg_progress', owner: 'coordinator', text: 'Synthetic progress', at: now,
  } });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, false);
});

test('finished cleanup candidates require workspace evidence; failed work keeps its existing workspace', async context => {
  const { state, save } = await fixture(context);
  await save('items/work_fixture.json', { ...item('cancelled'), planWorktree: '/synthetic/worktree' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).decisions[0].reason, 'worktree_proof_read_failed');
  await save('items/work_fixture.json', { ...item('failed'), planWorktree: '/synthetic/worktree' });
  assert.equal((await inspectMaintenanceReleaseInventory(state)).eligible, true);
});
