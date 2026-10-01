import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { WorkItem } from '../src/ledger.ts';
import { inspectWorktreePreservation, WORKTREE_PROOF_LIMITS } from '../src/maintenance-worktree-proof.ts';

const execute = promisify(execFile);
const now = Date.parse('2026-04-01T12:00:00Z');
const updatedAt = '2026-04-01T11:00:00Z';
const old = '2026-03-01T00:00:00Z';
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'worktree-proof-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  const path = join(root, 'worktree');
  await mkdir(repository);
  const git = async (directory: string, args: string[]) => (await execute('git', ['-C', directory, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
  await git(repository, ['init', '-q']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repository, 'source.txt'), 'original\n');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-qm', 'initial']);
  const head = await git(repository, ['rev-parse', 'HEAD']);
  await git(repository, ['update-ref', 'refs/remotes/origin/main', head]);
  await git(repository, ['worktree', 'add', '-q', '-b', 'plan/fixture', path]);
  const item = WorkItem.parse({ id: 'fixture', owner: 'specialist', workflow: 'owner-change', status: 'cancelled',
    proposal: { title: 'Fixture', goal: 'Preserve original work', rationale: 'Test', acceptance: ['Keep work'], size: 'small' },
    planWorktree: path, landedCommit: head, createdAt: old, updatedAt,
    session: { sessionID: 'ses_fixture', directory: path } });
  const activity = { sessionID: 'ses_fixture', directory: path, updatedAt: Date.parse(updatedAt), sessionDigest: 'a'.repeat(64) };
  return { root, repository, path, head, git, item, activity };
}

test('recent exact session retains clean worktree until the ordinary 24 hour boundary', async context => {
  const { item, activity, path } = await fixture(context);
  const before = await readFile(join(path, '.git'));
  const proof = await inspectWorktreePreservation(item, activity, now);
  assert.equal(proof.classification, 'time-gated');
  assert.equal(proof.validUntil, '2026-04-02T11:00:00.000Z');
  assert.deepEqual(await inspectWorktreePreservation(item, activity, now + 1000), proof);
  assert.equal((await inspectWorktreePreservation(item, activity, Date.parse(proof.validUntil!))).classification, 'blocked');
  assert.deepEqual(await readFile(join(path, '.git')), before);
});

test('missing, mismatched and future activity cannot manufacture retention', async context => {
  const { item, activity } = await fixture(context);
  for (const invalid of [undefined, { ...activity, sessionID: 'ses_other' }, { ...activity, directory: '/other' },
    { ...activity, updatedAt: now + 1 }, { ...activity, sessionDigest: '' }]) {
    assert.equal((await inspectWorktreePreservation(item, invalid, now)).classification, 'blocked');
  }
  const noSession = { ...item, session: undefined };
  assert.equal((await inspectWorktreePreservation(noSession, undefined, now)).classification, 'time-gated');
  assert.equal((await inspectWorktreePreservation({ ...noSession, updatedAt: old }, undefined, now)).classification, 'blocked');
});

test('expired unpublished work survives without trusting the persisted kept marker', async context => {
  const { item, path, git, activity } = await fixture(context);
  await writeFile(join(path, 'source.txt'), 'unpublished\n');
  await git(path, ['commit', '-qam', 'unpublished']);
  const expired = { ...activity, updatedAt: Date.parse(old) };
  const proof = await inspectWorktreePreservation(item, expired, now);
  assert.equal(proof.reason, 'worktree_kept_unpublished');
  assert.equal(proof.classification, 'single-use-protected');
  await git(path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const changed = await inspectWorktreePreservation({ ...item, planWorktreeKept: 'kept-unpublished' }, expired, now);
  assert.equal(changed.classification, 'blocked');
  assert.notEqual(changed.proofDigest, proof.proofDigest);
});

test('dirty contents, index, refs and symlink target changes invalidate the exact proof', async context => {
  const { item, activity, path, git } = await fixture(context);
  const expired = { ...activity, updatedAt: Date.parse(old) };
  await writeFile(join(path, 'source.txt'), 'dirty one\n');
  const first = await inspectWorktreePreservation(item, expired, now);
  assert.equal(first.reason, 'worktree_kept_uncommitted');
  await writeFile(join(path, 'source.txt'), 'dirty two\n');
  const second = await inspectWorktreePreservation(item, expired, now);
  assert.notEqual(second.proofDigest, first.proofDigest);
  await git(path, ['add', 'source.txt']);
  const staged = await inspectWorktreePreservation(item, expired, now);
  assert.notEqual(staged.proofDigest, second.proofDigest);
  await symlink('/unread/private-target', join(path, 'reference'));
  const linked = await inspectWorktreePreservation(item, expired, now);
  assert.equal(linked.reason, 'worktree_kept_uncommitted');
  assert.notEqual(linked.proofDigest, staged.proofDigest);
});

test('absent, foreign, unfinished and symlinked worktrees fail closed', async context => {
  const { item, activity, root, path } = await fixture(context);
  const alias = join(root, 'alias');
  await symlink(path, alias);
  for (const invalid of [{ ...item, planWorktree: join(root, 'absent') }, { ...item, planWorktree: root },
    { ...item, planWorktree: alias }, { ...item, status: 'working' as const }, { ...item, landedCommit: '--all' }]) {
    assert.equal((await inspectWorktreePreservation(invalid, activity, now)).classification, 'blocked');
  }
});

test('bounded proof refuses oversized contents without changing work', async context => {
  const { item, activity, path } = await fixture(context);
  const originalLimit = WORKTREE_PROOF_LIMITS.bytes;
  WORKTREE_PROOF_LIMITS.bytes = 1;
  try { assert.equal((await inspectWorktreePreservation(item, activity, now)).classification, 'blocked'); }
  finally { WORKTREE_PROOF_LIMITS.bytes = originalLimit; }
  assert.equal(await readFile(join(path, 'source.txt'), 'utf8'), 'original\n');
});


test('changes between repeated Git observations fail closed', async context => {
  const { item, activity, root, path } = await fixture(context);
  const gitExecutable = (await execute('/bin/sh', ['-c', 'command -v git'])).stdout.trim();
  const shims = join(root, 'shims');
  const counter = join(root, 'counter');
  await mkdir(shims);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(shims, 'git'), `#!/bin/sh
case "$*" in
  *"status --porcelain -z"*)
    if [ -f ${quote(counter)} ]; then
      printf 'changed during observation\\n' > ${quote(join(path, 'source.txt'))}
    else
      touch ${quote(counter)}
    fi
    ;;
esac
exec ${quote(gitExecutable)} "$@"
`);
  await chmod(join(shims, 'git'), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = shims + ':' + originalPath;
  try {
    const proof = await inspectWorktreePreservation(item, activity, now);
    assert.equal(proof.classification, 'blocked');
    assert.equal(proof.reason, 'worktree_proof_changed');
  } finally { process.env.PATH = originalPath; }
});


test('global ignore configuration agrees with the ordinary cleanup guard', async context => {
  const { item, activity, root, path } = await fixture(context);
  const excludes = join(root, 'global-ignore');
  const config = join(root, 'global-config');
  await writeFile(excludes, '*.scratch\n');
  await writeFile(config, '[core]\n  excludesfile = ' + excludes + '\n');
  await writeFile(join(path, 'left.scratch'), 'ignored, not a cleanup protection\n');
  const expired = { ...activity, updatedAt: Date.parse(old) };
  const before = await inspectWorktreePreservation(item, expired, now);
  assert.equal(before.reason, 'worktree_kept_uncommitted');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    const ordinary = await execute('git', ['-C', path, 'status', '--porcelain']);
    assert.equal(ordinary.stdout.trim(), '');
    const after = await inspectWorktreePreservation(item, expired, now);
    assert.equal(after.classification, 'blocked');
    assert.notEqual(after.proofDigest, before.proofDigest);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});
