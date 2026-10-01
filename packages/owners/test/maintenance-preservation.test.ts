import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectMaintenanceReleaseInventory, assertMaintenanceReleaseInventoryUnchanged } from '../src/maintenance-release-inventory.ts';

const execute = promisify(execFile);
const time = Date.parse('2026-01-01T12:00:00.000Z');
const at = new Date(time).toISOString();
const proposal = { title: 'Synthetic task', goal: 'Keep original request intent', rationale: 'Fixture',
  acceptance: ['Retain all work'], size: 'small' };
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-preservation-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const workspace = join(root, 'repository');
  await mkdir(state);
  await mkdir(workspace);
  const save = async (path: string, value: unknown) => {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), JSON.stringify(value));
  };
  const git = async (...args: string[]) => (await execute('git', ['-C', workspace, ...args])).stdout.trim();
  await git('init', '--quiet');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(workspace, 'source.txt'), 'retained\n');
  await git('add', 'source.txt');
  await git('commit', '--quiet', '-m', 'fixture');
  const head = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/remotes/origin/main', head);
  const session = { owner: 'specialist', sessionID: 'ses_fixture', directory: workspace };
  const item = { id: 'work_fixture', owner: 'specialist', workflow: 'owner-change', status: 'cancelled', proposal,
    session, planWorktree: workspace, createdAt: at, updatedAt: at };
  const sessions = [{ sessionID: session.sessionID, directory: workspace, updatedAt: time, sessionDigest: 'a'.repeat(64) }];
  return { state, workspace, save, git, item, sessions };
}

test('retention binds real Git and authenticated metadata; no preview changes a retained item or workspace', async context => {
  const state = await fixture(context);
  await state.save('items/work_fixture.json', state.item);
  const bytes = await readFile(join(state.state, 'items/work_fixture.json'), 'utf8');
  const effects = { now: () => time, sessions: state.sessions };
  const proof = await inspectMaintenanceReleaseInventory(state.state, effects);
  assert.equal(proof.eligible, true);
  assert.equal(proof.validUntil, '2026-01-02T12:00:00.000Z');
  assert.equal((await assertMaintenanceReleaseInventoryUnchanged(state.state, proof.digest, effects)).digest, proof.digest);
  assert.equal(await readFile(join(state.state, 'items/work_fixture.json'), 'utf8'), bytes);
  assert.equal(await readFile(join(state.workspace, 'source.txt'), 'utf8'), 'retained\n');
  assert.equal((await inspectMaintenanceReleaseInventory(state.state, { now: () => time })).eligible, false);
  assert.equal((await inspectMaintenanceReleaseInventory(state.state, { ...effects, now: () => time + 86_400_000 })).eligible, false);
  await assert.rejects(assertMaintenanceReleaseInventoryUnchanged(state.state, proof.digest,
    { ...effects, sessions: [{ ...state.sessions[0]!, sessionDigest: 'b'.repeat(64) }] }), /maintenance_inventory_changed/);
});

test('Git changes between inventory snapshots invalidate preservation even when another keep guard would retain the work', async context => {
  const state = await fixture(context);
  await state.save('items/work_fixture.json', state.item);
  await assert.rejects(inspectMaintenanceReleaseInventory(state.state, { now: () => time, sessions: state.sessions,
    afterSnapshot: () => writeFile(join(state.workspace, 'source.txt'), 'new genuine work\n') }), /maintenance_inventory_changed/);
  assert.equal(await readFile(join(state.workspace, 'source.txt'), 'utf8'), 'new genuine work\n');
});

test('an exact tracked request is preserved but a concurrent terminal outcome invalidates its proof', async context => {
  const state = await fixture(context);
  const item = { ...state.item, status: 'working', request: 'request_fixture',
    planDocument: { markdown: 'Narrower approved plan wording', digest: 'plan_fixture' } };
  const stored = item;
  const request = { id: 'request_fixture', from: 'coordinator', to: 'specialist', status: 'work-running',
    workItem: item.id, followUp: 'none', ask: { kind: 'work', purpose: 'Delegate original goal', proposal }, createdAt: at, updatedAt: at };
  await state.save('items/work_fixture.json', stored);
  await state.save('requests/request_fixture.json', request);
  const proof = await inspectMaintenanceReleaseInventory(state.state, { now: () => time });
  assert.equal(proof.eligible, true);
  assert.equal(proof.decisions.find(entry => entry.resource.startsWith('requests/'))?.reason, 'request_tracking_without_transition');
  await assert.rejects(inspectMaintenanceReleaseInventory(state.state, { now: () => time,
    afterSnapshot: () => state.save('items/work_fixture.json', { ...stored, status: 'failed' }) }), /maintenance_inventory_changed/);
  assert.equal((await inspectMaintenanceReleaseInventory(state.state, { now: () => time })).eligible, false);
  assert.deepEqual(JSON.parse(await readFile(join(state.state, 'requests/request_fixture.json'), 'utf8')), request);
});
