import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Runtime } from '../src/runtime.ts';
import { reportFriction } from '../src/friction.ts';
import { investigateFriction } from '../src/friction-work.ts';
import { frictionProposalDigest, promoteFriction } from '../src/friction-promotion.ts';
import { assignAttention } from '../src/attention-assignment.ts';
import { changeAttention, listAttention, humanAttentionActor } from '../src/attention.ts';
import { saveAskHandoff } from '../src/ask-handoffs.ts';
import { beginAdmission } from '../src/deployment-admission.ts';
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


test('root and intermediate metadata symlinks block every dependent read', async () => {
  for (const named of ['friction', 'attention', 'deploy']) {
    const paths = await setup();
    await mkdir(paths.state);
    const outside = join(paths.root, 'outside');
    await save(outside, 'index.json', named === 'friction' ? { [firstID]: { lastSeen: '2026-01-01T00:00:00.000Z' } }
      : { cutoff: '2026-01-01', cursors: {}, entries: {} });
    await save(outside, 'pending.json', { status: 'draining', targetBuildId: 'PRIVATE_BUILD' });
    await symlink(outside, join(paths.state, named));
    const preview = await continuityPreview(paths);
    assert.ok(preview.issues.some(issue => issue.section.startsWith(named === 'deploy' ? 'deployment' : named) && issue.reason === 'unreadable'));
    assert.equal(preview.deployment.intent, undefined);
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_BUILD/);
  }
  const paths = await setup();
  const outside = join(paths.root, 'outside');
  await save(outside, 'friction/index.json', { [firstID]: { lastSeen: '2026-01-01T00:00:00.000Z' } });
  await symlink(outside, paths.state);
  const preview = await continuityPreview(paths);
  assert.equal(preview.stateDirectory, 'unavailable');
  assert.equal(preview.friction.indexedCount, null);
  assert.equal(preview.promotions.scope.availability, 'unavailable');
});

test('corrupt index traversal keys fail schema validation before record path construction', async () => {
  const paths = await setup();
  await save(paths.state, 'friction/index.json', { '../PRIVATE_FILE': { lastSeen: '2026-01-01T00:00:00.000Z' } });
  const preview = await continuityPreview(paths);
  assert.equal(preview.friction.indexAvailable, false);
  assert.equal(preview.friction.examined, 0);
  assert.ok(preview.issues.some(issue => issue.section === 'friction-index' && issue.reason === 'unreadable'));
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_FILE/);
});

test('actual writer records appear with matching status and preview makes no subsequent changes', async () => {
  const paths = await setup();
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: paths.state });
  runtime.declarations.root = paths.declarations;
  const source = join(paths.root, 'source');
  await mkdir(source);
  execFileSync('git', ['init', source], { stdio: 'ignore' });
  execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  runtime.declarations.owners.get('clippy')!.workspace = source;
  await runtime.notebook('clippy').ensure('# Fixture');
  await save(paths.declarations, 'friction-triage.json', { ...policy, enabledSince: '2020-01-01T00:00:00.000Z' });
  const record = await reportFriction(runtime, { owner: 'clippy', submissionID: 'actual-writer',
    origin: { sessionID: 'fixture', directory: source }, model: 'fixture/model', commit: 'a'.repeat(40), failures: [],
    input: { summary: 'Missing review evidence', expected: 'Reviewer reads source', actual: 'No evidence available' } });
  const proposal = { title: 'Repair evidence', goal: 'Expose facts', rationale: 'Review blocked', acceptance: ['Reviewer sees facts'],
    repository: 'example/clippy', size: 'small' as const };
  let hires = 0;
  runtime.hire = async (_owner, request) => {
    hires++;
    return { value: request.schema.parse({ observed: ['Source inspected'], inferred: [], unknown: [], disposition: 'propose-fix', proposedWork: proposal }),
      sessionID: 'fixture-hire', cost: 0, startedAt: record.firstSeen, finishedAt: record.firstSeen };
  };
  const triage = await investigateFriction(runtime, record.id);
  assert.ok('investigation' in triage);
  await promoteFriction(runtime, record.id, frictionProposalDigest(triage)!, 'Fixture person');
  await runtime.notebook('clippy').journal({ kind: 'attention', note: 'A distinct check is broken' });
  const attention = (await listAttention(runtime))[0];
  await changeAttention(runtime, attention.id, 'acknowledged', humanAttentionActor(), 'Seen');
  await assignAttention(runtime, attention.id, { owner: 'clippy', repository: 'example/clippy', title: proposal.title,
    goal: proposal.goal, acceptance: proposal.acceptance }, 'Fixture person');
  await saveAskHandoff(runtime, { from: 'homelab', to: 'clippy', question: 'Check evidence',
    origin: { directory: source, sessionID: 'fixture', messageID: 'fixture-message' } },
  { answer: 'Ready to inspect', observed: [], inferred: [], unknown: [] });
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { activeRunner: process.pid });
  const lease = process.platform === 'linux' ? await beginAdmission(paths.state, 'fixture-preview') : undefined;
  try {
    // Processing state remains authoritative even if the original wake disappears.
    await rm(join(paths.state, 'friction/wakes', `${record.id}.json`));
    const before = await snapshot(paths.root);
    const preview = await continuityPreview(paths);
    assert.equal(preview.friction.counts['existing-investigated'], 1);
    assert.equal(preview.investigations.counts.investigated, 1);
    assert.equal(preview.promotions.counts.routed, 1);
    assert.equal(preview.assignments.counts.routed, 1);
    assert.equal(preview.attention.counts['has-assignment'], 1);
    assert.equal(preview.handoffs.counts.pending, 1);
    assert.equal(preview.deployment.work.entries[0].id, item.id);
    if (lease) assert.equal(preview.deployment.admissions.entries[0].id, lease.id);
    assert.deepEqual(await snapshot(paths.root), before);
    assert.equal(hires, 1);
  } finally { await lease?.release(); runtime.close(); }
});
