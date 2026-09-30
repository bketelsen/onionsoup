import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { continuityPreview } from '../src/continuity-preview.ts';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'continuity-preview-'));
  return { root, state: join(root, 'state'), declarations: join(root, 'config') };
}
async function save(root: string, name: string, value: unknown) {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function snapshot(root: string): Promise<unknown> {
  const files = await readdir(root, { withFileTypes: true });
  return Promise.all(files.sort((left, right) => left.name.localeCompare(right.name)).map(async file => [file.name,
    file.isDirectory() ? await snapshot(join(root, file.name)) : createHash('sha256').update(await readFile(join(root, file.name))).digest('hex')]));
}
function report(id: string, firstSeen = '2026-01-02T00:00:00.000Z') {
  return { version: 1, id, owner: 'clippy', summary: 'PRIVATE_TEXT', expected: 'PRIVATE_TEXT', actual: 'PRIVATE_TEXT',
    origin: { directory: '/PRIVATE_DIRECTORY', sessionID: 'PRIVATE_SESSION' }, firstSeen, lastSeen: firstSeen, count: 1,
    commit: 'unavailable', model: 'unavailable', failures: [], failureContext: 'unavailable', provisional: true };
}
const firstID = 'fr_aaaaaaaaaaaaaaaaaaaaaaaa';
const oldID = 'fr_bbbbbbbbbbbbbbbbbbbbbbbb';
const policy = { version: 1, owner: 'clippy', repository: 'example/clippy', enabledSince: '2026-01-01T00:00:00.000Z' };

test('preview classifies cached scopes without writing, leaking prose, or interpreting acknowledgment as authority', async () => {
  const paths = await setup();
  await save(paths.declarations, 'friction-triage.json', policy);
  const recent = report(firstID);
  const old = report(oldID, '2025-01-01T00:00:00.000Z');
  await save(paths.state, 'friction/index.json', { [firstID]: { lastSeen: recent.lastSeen }, [oldID]: { lastSeen: old.lastSeen } });
  for (const value of [recent, old]) {
    await save(paths.state, `friction/records/${value.id}.json`, value);
    await save(paths.state, `friction/wakes/${value.id}.json`, { id: value.id, at: value.firstSeen, status: 'pending' });
  }
  await save(paths.state, 'attention/index.json', { cutoff: '2026-01-01', cursors: {}, entries: {
    'a-fixture': { id: 'a-fixture', owner: 'clippy', note: 'PRIVATE_TEXT', at: recent.firstSeen, status: 'acknowledged',
      decision: { by: 'PRIVATE_PERSON', reason: 'fix this', at: recent.firstSeen } },
  } });
  const before = await snapshot(paths.root);
  const preview = await continuityPreview(paths);
  assert.equal(preview.policy.state, 'configured');
  assert.deepEqual(preview.friction.counts, { 'eligible-candidate': 1, 'excluded-before-cutoff': 1 });
  assert.equal(preview.attention.counts['acknowledged-without-assignment'], 1);
  assert.equal(preview.attention.automaticallyEligible, false);
  assert.equal(preview.deployment.readiness, 'not-certified');
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_|fix this/);
  assert.deepEqual(await snapshot(paths.root), before);
  assert.equal((await continuityPreview(paths)).selectionDigest, preview.selectionDigest);
  assert.match(preview.warning, /not approval/);
});

test('missing and invalid metadata remains unknown; no index or state directory is repaired', async () => {
  const paths = await setup();
  const missing = await continuityPreview(paths);
  assert.equal(missing.policy.state, 'disabled');
  assert.equal(missing.friction.indexedCount, null);
  assert.equal(missing.attention.acknowledgedCount, null);
  await assert.rejects(lstat(paths.state), { code: 'ENOENT' });
  await save(paths.declarations, 'friction-triage.json', { enabledSince: 'invalid', password: 'DO_NOT_PRINT' });
  const invalid = await continuityPreview(paths);
  assert.equal(invalid.policy.state, 'invalid');
  assert.ok(invalid.issues.some(issue => issue.section === 'policy' && issue.reason === 'unreadable'));
  assert.doesNotMatch(JSON.stringify(invalid), /DO_NOT_PRINT/);
});

test('bounded scans honestly report truncation, oversized records and conservative admissions', async () => {
  const paths = await setup();
  await save(paths.state, 'deploy/leases/11111111-1111-4111-8111-111111111111.json', {
    id: '11111111-1111-4111-8111-111111111111', pid: 1, startTime: '1', kind: 'PRIVATE_KIND',
  });
  for (const id of [firstID, oldID]) await save(paths.state, `friction/promotions/${id}.json`, { oversized: 'x'.repeat(1000) });
  const preview = await continuityPreview(paths, { files: 1, fileBytes: 512 });
  assert.equal(preview.promotions.scope.truncated, true);
  assert.equal(preview.promotions.scope.complete, false);
  assert.equal(preview.promotions.scope.valid, 0);
  assert.ok(preview.issues.some(issue => issue.section === 'promotions' && issue.reason === 'too_large'));
  assert.equal(preview.deployment.admissions.counts['persisted-lease-liveness-unknown'], 1);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_KIND/);
});

test('metadata symlinks are not followed', async () => {
  const paths = await setup();
  await mkdir(paths.declarations);
  await save(paths.root, 'private.json', policy);
  await symlink(join(paths.root, 'private.json'), join(paths.declarations, 'friction-triage.json'));
  const preview = await continuityPreview(paths);
  assert.equal(preview.policy.state, 'invalid');
});

test('CLI preview bypasses admission, runtime creation and model configuration', async () => {
  const paths = await setup();
  const stdout = execFileSync(process.execPath, ['--conditions=onionsoup-source', '--import', 'tsx', 'packages/owners/src/cli.ts',
    'continuity-preview', '--state', paths.state, '--declarations', paths.declarations], { encoding: 'utf8' });
  const preview = JSON.parse(stdout);
  assert.equal(preview.policy.state, 'disabled');
  assert.match(preview.selectionDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(paths.root), []);
});


test('FIFO metadata cannot block preview; directories are not accepted as JSON files', async () => {
  const paths = await setup();
  await mkdir(paths.declarations);
  const policyPath = join(paths.declarations, 'friction-triage.json');
  execFileSync('mkfifo', [policyPath]);
  const stdout = execFileSync(process.execPath, ['--conditions=onionsoup-source', '--import', 'tsx', 'packages/owners/src/cli.ts',
    'continuity-preview', '--state', paths.state, '--declarations', paths.declarations], { encoding: 'utf8', timeout: 5000 });
  assert.equal(JSON.parse(stdout).policy.state, 'invalid');
  await rm(policyPath);
  await mkdir(policyPath);
  const preview = await continuityPreview(paths);
  assert.equal(preview.policy.state, 'invalid');
  assert.ok(preview.issues.some(issue => issue.section === 'policy' && issue.reason === 'unreadable'));
});

test('named queue symlinks are unavailable, and absent queues are not asserted exhaustively empty', async () => {
  const paths = await setup();
  await mkdir(paths.state);
  await save(paths.root, `private/${firstID}.json`, { token: 'PRIVATE' });
  await mkdir(join(paths.state, 'friction'));
  await symlink(join(paths.root, 'private'), join(paths.state, 'friction/promotions'));
  const preview = await continuityPreview(paths);
  assert.equal(preview.stateDirectory, 'present');
  assert.equal(preview.promotions.scope.availability, 'unavailable');
  assert.equal(preview.promotions.scope.complete, false);
  assert.equal(preview.promotions.scope.examined, 0);
  assert.equal(preview.handoffs.scope.availability, 'absent');
  assert.equal(preview.handoffs.scope.complete, false);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE/);
  const absent = await continuityPreview({ ...paths, state: join(paths.root, 'missing') });
  assert.equal(absent.stateDirectory, 'absent');
});

test('selection digest ordering does not depend on locale collation', async () => {
  const paths = await setup();
  const baseline = await continuityPreview(paths);
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = () => { throw new Error('locale-sensitive sorting called'); };
  try {
    assert.equal((await continuityPreview(paths)).selectionDigest, baseline.selectionDigest);
  } finally { String.prototype.localeCompare = original; }
});
