import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { buildOperatorHandoff, operatorHandoffArtifactDigest, operatorHandoffSourceDigest } from '../src/operator-handoff-artifact.ts';
import { OperatorHandoffArtifact } from '../src/operator-handoff-types.ts';
import type { OperatorJob } from '../src/operator-jobs-types.ts';
import { operatorWriteSha256 } from '../src/operator-write-workspace.ts';
import { acceptHandoffChildren, handoffFixture, setupHandoffFixture } from './operator-handoff-fixture.ts';

const execute = promisify(execFile);
const git = (directory: string, args: string[]) => execute('/usr/bin/git', ['--no-optional-locks', '-C', directory,
  '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args]);

async function states(context: Awaited<ReturnType<typeof handoffFixture>>) {
  return { job: await context.jobs.get(context.origin, context.id),
    left: (await git(context.directory, ['status', '--porcelain=v1'])).stdout,
    right: (await git(context.second, ['status', '--porcelain=v1'])).stdout,
    head: (await git(context.directory, ['rev-parse', 'HEAD'])).stdout };
}

test('accepted sibling worktrees combine disjoint changes and exact check provenance without any mutation', async () => {
  const context = await handoffFixture();
  const before = await states(context);
  const { artifact, source } = await buildOperatorHandoff(before.job);
  assert.equal(artifact.digest, operatorHandoffArtifactDigest(OperatorHandoffArtifact.parse(artifact)));
  assert.equal(artifact.sourceDigest, operatorHandoffSourceDigest(source));
  assert.equal(artifact.base.commonDirectory, await realpath(join(context.directory, '.git')));
  assert.equal(artifact.base.head, context.head);
  assert.deepEqual(artifact.origin, before.job.origin);
  assert.deepEqual(artifact.intake, before.job.intake);
  assert.equal(artifact.goal, before.job.goal);
  assert.deepEqual(artifact.constraints, before.job.constraints);
  assert.equal(artifact.diff, before.job.children.map(child => child.write!.artifact!.diff).join(''));
  assert.equal(artifact.diffSha256, operatorWriteSha256(artifact.diff));
  assert.deepEqual(artifact.files.map(file => [file.childID, file.path]), [['left', 'a.mjs'], ['right', 'b.mjs']]);
  assert.equal(source.find(file => file.path === 'a.mjs')!.content.toString(), 'export default 1;\n');
  assert.equal(source.find(file => file.path === 'b.mjs')!.content.toString(), 'export default 2;\n');
  for (const child of before.job.children) {
    const provenance = artifact.children.find(candidate => candidate.id === child.id)!;
    assert.deepEqual(provenance.approval, child.write!.approval);
    assert.deepEqual(provenance.acceptance, child.write!.acceptance);
    assert.deepEqual(provenance.evidence, child.evidence);
    for (const file of child.write!.baseline.files) assert.equal(source.find(candidate => candidate.path === file.path)!.mode, file.mode);
  }
  assert.equal(artifact.checks.length, 1);
  assert.deepEqual(artifact.checks[0]!.command, ['node', '--test', 'combined.test.mjs']);
  assert.deepEqual(artifact.checks[0]!.provenance, [{ childID: 'left', checkID: 'unit' }, { childID: 'right', checkID: 'unit' }]);
  assert.deepEqual(await states(context), before);
  assert.equal(await readFile(join(context.directory, 'b.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await readFile(join(context.second, 'a.mjs'), 'utf8'), 'export default 0;\n');
  source.find(file => file.path === 'a.mjs')!.content.fill(0);
  assert.equal(await readFile(join(context.directory, 'a.mjs'), 'utf8'), 'export default 1;\n');
  assert.equal((await buildOperatorHandoff(before.job)).artifact.digest, artifact.digest);
});

test('overlapping approved paths are rejected even when independently accepted edits are identical', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  setup.input.tasks[1]!.files = ['a.mjs'];
  const context = await acceptHandoffChildren(setup, { left: { 'a.mjs': 'export default 1;\n' }, right: { 'a.mjs': 'export default 1;\n' } });
  const job = await context.jobs.get(context.origin, context.id);
  await assert.rejects(buildOperatorHandoff(job), /operator_handoff_paths_overlap/);
});

test('a different repository with the exact same HEAD and source is not a sibling worktree', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  const clone = join(setup.workspace, 'separate-repository');
  await git(setup.workspace, ['clone', '--quiet', '--local', '--no-hardlinks', setup.directory, clone]);
  setup.input.tasks[1]!.directory = clone;
  const context = await acceptHandoffChildren(setup);
  const job = await context.jobs.get(context.origin, context.id);
  assert.equal(job.children[0]!.write!.baseline.head, job.children[1]!.write!.baseline.head);
  await assert.rejects(buildOperatorHandoff(job), /operator_handoff_repository_mismatch/);
});

test('different accepted bases within one Git repository cannot combine', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  await writeFile(join(setup.second, 'README.md'), '# Different accepted base\n');
  await git(setup.second, ['commit', '-qam', 'second worktree base']);
  const context = await acceptHandoffChildren(setup);
  const job = await context.jobs.get(context.origin, context.id);
  await assert.rejects(buildOperatorHandoff(job), /operator_handoff_base_mismatch/);
});

test('accepted artifacts cannot conceal later worktree changes', async () => {
  const context = await handoffFixture({ checks: false });
  const job = await context.jobs.get(context.origin, context.id);
  await writeFile(join(context.second, 'b.mjs'), 'export default 99;\n');
  await assert.rejects(buildOperatorHandoff(job), /operator_write_source_changed|operator_handoff_artifact_stale/);
  assert.equal(await readFile(join(context.second, 'b.mjs'), 'utf8'), 'export default 99;\n');
  assert.deepEqual(await context.jobs.get(context.origin, context.id), job);
});

test('unknown effects, foreign work and mismatched approval or acceptance cannot enter a handoff', async () => {
  const context = await handoffFixture();
  const job = await context.jobs.get(context.origin, context.id);
  const mutations: Record<string, (job: OperatorJob) => void> = {
    incomplete: candidate => { candidate.children[0]!.status = 'blocked'; },
    foreign: candidate => { candidate.children[0]!.blocker = 'operator_child_foreign_work'; },
    pending: candidate => { candidate.children[0]!.write!.operations[0]!.status = 'prepared'; },
    pendingCheck: candidate => { candidate.children[0]!.write!.checks![0]!.status = 'prepared'; },
    noAcceptance: candidate => { delete candidate.children[0]!.write!.acceptance; },
    wrongApproval: candidate => { candidate.children[0]!.write!.approval.scopeDigest = '0'.repeat(64); },
    wrongAcceptance: candidate => { candidate.children[0]!.write!.acceptance!.digest = '0'.repeat(64); },
    changedGoal: candidate => { candidate.goal = 'Unapproved broader goal'; },
    wrongSession: candidate => { candidate.children[0]!.evidence!.sessionID = 'ses_foreign'; },
    activeAttempt: candidate => { delete candidate.children[0]!.attempts[0]!.endedAt; },
    activeClaim: candidate => { candidate.children[0]!.operation = { token: 'token_observe', kind: 'observe',
      startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const candidate = structuredClone(job);
    mutate(candidate);
    await assert.rejects(buildOperatorHandoff(candidate), /operator_handoff_|operator_write_/, name);
  }
  assert.deepEqual(await context.jobs.get(context.origin, context.id), job);
});

test('new files join the private source copy with their exact creation receipt and mode', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  for (const [index, path] of ['new-left.mjs', 'new-right.mjs'].entries()) {
    setup.input.tasks[index]!.files = [];
    setup.input.tasks[index]!.createFiles = [path];
  }
  const context = await acceptHandoffChildren(setup, { left: { 'new-left.mjs': 'export default 1;\n' }, right: { 'new-right.mjs': 'export default 2;\n' } });
  const { artifact, source } = await buildOperatorHandoff(await context.jobs.get(context.origin, context.id));
  assert.deepEqual(artifact.files.map(file => [file.path, file.beforeSha256, file.mode]),
    [['new-left.mjs', 'absent', 0o100600], ['new-right.mjs', 'absent', 0o100600]]);
  assert(source.some(file => file.path === 'new-left.mjs'));
  assert(source.some(file => file.path === 'new-right.mjs'));
  assert.match(artifact.diff, /new file mode/);
});

test('mixed completed read-only evidence is retained without inventing write acceptance', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  const observer = setup.input.tasks[1]!;
  observer.access = 'read-only';
  observer.goal = 'Inspect the unchanged second worktree';
  delete observer.files;
  delete observer.checks;
  const context = await acceptHandoffChildren(setup, { left: { 'a.mjs': 'export default 1;\n' }, right: {} });
  const job = await context.jobs.get(context.origin, context.id);
  const { artifact } = await buildOperatorHandoff(job);
  const provenance = artifact.children.find(child => child.id === 'right')!;
  assert.equal(provenance.access, 'read-only');
  assert.deepEqual(provenance.evidence, job.children.find(child => child.id === 'right')!.evidence);
  assert.equal(provenance.acceptance, undefined);
  assert.equal(provenance.approval, undefined);
  assert.deepEqual(artifact.files.map(file => file.childID), ['left']);
});

test('more than four distinct approved commands refuses handoff rather than silently omitting checks', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  const commands = Array.from({ length: 5 }, (_entry, index) => ({ id: `check_${index}`,
    command: ['node', '--test', ...Array.from({ length: index + 1 }, () => 'combined.test.mjs')] }));
  setup.input.tasks[0]!.checks = commands.slice(0, 4);
  setup.input.tasks[1]!.checks = commands.slice(4);
  const context = await acceptHandoffChildren(setup);
  const job = await context.jobs.get(context.origin, context.id);
  assert.equal(job.children[0]!.write!.checks!.length + job.children[1]!.write!.checks!.length, 5);
  await assert.rejects(buildOperatorHandoff(job), /operator_handoff_check_limit/);
  assert.deepEqual(await context.jobs.get(context.origin, context.id), job);
});


test('matching Git HEAD and tree still reject differing clean baseline file modes', async () => {
  const setup = await setupHandoffFixture({ checks: false });
  await git(setup.second, ['config', 'core.filemode', 'false']);
  await chmod(join(setup.second, 'README.md'), 0o755);
  assert.equal((await git(setup.second, ['status', '--porcelain=v1'])).stdout, '');
  const context = await acceptHandoffChildren(setup);
  const job = await context.jobs.get(context.origin, context.id);
  assert.equal(job.children[0]!.write!.baseline.head, job.children[1]!.write!.baseline.head);
  assert.equal(job.children[0]!.write!.baseline.tree, job.children[1]!.write!.baseline.tree);
  await assert.rejects(buildOperatorHandoff(job), /operator_handoff_base_mismatch/);
});
