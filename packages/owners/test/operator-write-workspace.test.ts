import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, link, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { operatorWriterCommand, requireOperatorWriterBwrapFeatures, resolveOperatorWriterNode, runOperatorFileWriter } from '../src/operator-write-writer.ts';
import { applyOperatorFileMutation, inspectOperatorFileMutation, operatorWriteArtifact, operatorWriteSha256,
  prepareOperatorFileMutation, snapshotOperatorWriteWorkspace } from '../src/operator-write-workspace.ts';

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-write-'));
  const directory = join(workspace, 'repo');
  await mkdir(join(directory, 'docs'), { recursive: true });
  await writeFile(join(directory, 'docs/note.txt'), 'original\n');
  await writeFile(join(directory, 'other.txt'), 'untouched\n');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', directory, ...args], { encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const capture = (files = ['docs/note.txt']) => snapshotOperatorWriteWorkspace({ workspace, directory, files });
  const snapshot = await capture();
  const prepare = (content = 'updated\n', path = 'docs/note.txt') => prepareOperatorFileMutation(snapshot, [], {
    id: 'mutation-1', path, expectedBeforeSha256: operatorWriteSha256('original\n'), content,
  });
  return { workspace, directory, git, snapshot, prepare, capture };
}

test('approved existing UTF8 file is changed in the real isolated writer and produces exact diff provenance', async () => {
  const fixtureState = await fixture();
  const mutation = await fixtureState.prepare('updated π\n');
  assert.deepEqual(await inspectOperatorFileMutation(fixtureState.snapshot, [], mutation), { status: 'not-applied' });
  const receipt = await applyOperatorFileMutation(fixtureState.snapshot, [], mutation);
  assert.equal(await readFile(join(fixtureState.directory, 'docs/note.txt'), 'utf8'), 'updated π\n');
  assert.equal(await readFile(join(fixtureState.directory, 'other.txt'), 'utf8'), 'untouched\n');
  assert.deepEqual(await applyOperatorFileMutation(fixtureState.snapshot, [], mutation), receipt);
  assert.deepEqual(await inspectOperatorFileMutation(fixtureState.snapshot, [], mutation), { status: 'applied', receipt });
  const artifact = await operatorWriteArtifact(fixtureState.snapshot, [receipt]);
  assert.match(artifact.diff, /-original\n\+updated π/);
  assert.equal(artifact.diffSha256, operatorWriteSha256(artifact.diff));
  assert.equal(artifact.snapshotDigest, fixtureState.snapshot.digest);
  assert.equal(fixtureState.git('diff', '--cached'), '');
});

for (const path of ['../outside', '/tmp/outside', 'docs/../other.txt', '.git/config', 'docs\\note.txt', 'new.txt', 'other.txt']) {
  test(`write scope rejects ${JSON.stringify(path)}`, async () => {
    const fixtureState = await fixture();
    await assert.rejects(fixtureState.prepare('changed', path), /operator_write_(path_invalid|file_not_approved)/);
    assert.equal(await readFile(join(fixtureState.directory, 'docs/note.txt'), 'utf8'), 'original\n');
  });
}

for (const change of ['head', 'index', 'other', 'symlink', 'hardlink', 'parent', 'mode', 'untracked'] as const) {
  test(`prepared mutation refuses ${change} changes without modifying its file`, async () => {
    const fixtureState = await fixture();
    const mutation = await fixtureState.prepare();
    const target = join(fixtureState.directory, 'docs/note.txt');
    const actions = {
      head: async () => { fixtureState.git('commit', '--allow-empty', '-qm', 'foreign'); },
      index: async () => { await writeFile(join(fixtureState.directory, 'other.txt'), 'foreign'); fixtureState.git('add', 'other.txt'); },
      other: async () => { await writeFile(join(fixtureState.directory, 'other.txt'), 'foreign'); },
      symlink: async () => { await unlink(target); await symlink('../other.txt', target); },
      hardlink: async () => { await link(target, join(fixtureState.workspace, 'alias')); },
      parent: async () => { await rename(join(fixtureState.directory, 'docs'), join(fixtureState.directory, 'old-docs')); await mkdir(join(fixtureState.directory, 'docs')); await writeFile(target, 'original\n'); },
      mode: async () => { await chmod(target, 0o755); },
      untracked: async () => { await writeFile(join(fixtureState.directory, 'untracked'), 'foreign'); },
    };
    await actions[change]();
    await assert.rejects(applyOperatorFileMutation(fixtureState.snapshot, [], mutation));
    if (change !== 'symlink') assert.equal(await readFile(target, 'utf8'), 'original\n');
  });
}

test('unknown partial disk mutation is uncertain, never overwritten or accepted as an artifact', async () => {
  const fixtureState = await fixture();
  const mutation = await fixtureState.prepare();
  await writeFile(join(fixtureState.directory, mutation.path), 'part');
  await assert.rejects(applyOperatorFileMutation(fixtureState.snapshot, [], mutation), /operator_write_mutation_uncertain/);
  await assert.rejects(inspectOperatorFileMutation(fixtureState.snapshot, [], mutation), /operator_write_mutation_uncertain/);
  await assert.rejects(operatorWriteArtifact(fixtureState.snapshot, []), /operator_write_source_changed/);
  assert.equal(await readFile(join(fixtureState.directory, mutation.path), 'utf8'), 'part');
});

test('repository clean filters cannot execute during snapshot or artifact inspection', async () => {
  const fixtureState = await fixture();
  const marker = join(fixtureState.workspace, 'filter-ran');
  await writeFile(join(fixtureState.directory, '.gitattributes'), '*.txt filter=evil\n');
  fixtureState.git('add', '.gitattributes');
  fixtureState.git('commit', '-qm', 'attributes');
  fixtureState.git('config', 'filter.evil.clean', `touch ${marker}; cat`);
  await assert.rejects(fixtureState.capture(), /operator_write_git_filters_unsupported/);
  await assert.rejects(operatorWriteArtifact(fixtureState.snapshot, []), /operator_write_git_filters_unsupported/);
  await assert.rejects(access(marker));
});

test('initial dirty, hardlinked and invalid UTF8 scopes are rejected', async () => {
  const fixtureState = await fixture();
  await writeFile(join(fixtureState.directory, 'other.txt'), 'dirty');
  await assert.rejects(fixtureState.capture(), /operator_write_workspace_dirty/);
  fixtureState.git('checkout', '--', 'other.txt');
  await link(join(fixtureState.directory, 'docs/note.txt'), join(fixtureState.workspace, 'alias'));
  await assert.rejects(fixtureState.capture(), /operator_write_scope_file_invalid/);
  await unlink(join(fixtureState.workspace, 'alias'));
  await writeFile(join(fixtureState.directory, 'docs/note.txt'), Buffer.from([0xff]));
  fixtureState.git('add', '.');
  fixtureState.git('commit', '-qm', 'binary');
  await assert.rejects(fixtureState.capture());
});

test('approved file count, byte bounds, binary contents and stale before digest fail closed', async () => {
  const fixtureState = await fixture();
  await assert.rejects(snapshotOperatorWriteWorkspace({ workspace: fixtureState.workspace, directory: fixtureState.directory,
    files: ['docs/note.txt', 'other.txt'], limits: { approvedFiles: 1 } }), /operator_write_scope_invalid/);
  await assert.rejects(snapshotOperatorWriteWorkspace({ workspace: fixtureState.workspace, directory: fixtureState.directory,
    files: ['docs/note.txt'], limits: { fileBytes: 2 } }), /operator_write_scope_file_invalid/);
  await assert.rejects(fixtureState.prepare('a'.repeat(256 * 1024 + 1)), /operator_write_text_invalid/);
  await assert.rejects(fixtureState.prepare('nul\0text'), /operator_write_text_invalid/);
  await assert.rejects(fixtureState.prepare('\ud800'), /operator_write_text_invalid/);
  await assert.rejects(prepareOperatorFileMutation(fixtureState.snapshot, [], { id: 'stale', path: 'docs/note.txt',
    expectedBeforeSha256: operatorWriteSha256('wrong'), content: 'next' }), /operator_write_before_digest_mismatch/);
});

test('tracked symlinks and parent symlink replacements never grant file authority', async () => {
  const fixtureState = await fixture();
  await symlink('other.txt', join(fixtureState.directory, 'shortcut'));
  fixtureState.git('add', 'shortcut');
  fixtureState.git('commit', '-qm', 'link');
  await assert.rejects(fixtureState.capture(['shortcut']), /operator_write_scope_file_invalid/);
  const snapshot = await fixtureState.capture();
  const intent = await prepareOperatorFileMutation(snapshot, [], { id: 'swap', path: 'docs/note.txt', expectedBeforeSha256: operatorWriteSha256('original\n'), content: 'replacement' });
  await rename(join(fixtureState.directory, 'docs'), join(fixtureState.workspace, 'outside'));
  await symlink(join(fixtureState.workspace, 'outside'), join(fixtureState.directory, 'docs'));
  await assert.rejects(applyOperatorFileMutation(snapshot, [], intent));
  assert.equal(await readFile(join(fixtureState.workspace, 'outside/note.txt'), 'utf8'), 'original\n');
});

test('a normal existing Git worktree is supported and retains its index and branch', async () => {
  const fixtureState = await fixture();
  const worktree = join(fixtureState.workspace, 'worktree');
  fixtureState.git('worktree', 'add', '-q', '-b', 'write-fixture', worktree);
  const snapshot = await snapshotOperatorWriteWorkspace({ workspace: fixtureState.workspace, directory: worktree, files: ['other.txt'] });
  assert.notEqual(snapshot.gitDirectory, join(worktree, '.git'));
  const mutation = await prepareOperatorFileMutation(snapshot, [], { id: 'worktree', path: 'other.txt',
    expectedBeforeSha256: operatorWriteSha256('untouched\n'), content: 'worktree change\n' });
  const receipt = await applyOperatorFileMutation(snapshot, [], mutation);
  assert.equal((await operatorWriteArtifact(snapshot, [receipt])).files[0]!.afterSha256, mutation.afterSha256);
  assert.equal(await readFile(join(fixtureState.directory, 'other.txt'), 'utf8'), 'untouched\n');
});

test('assume-unchanged index flags cannot hide a dirty baseline', async () => {
  const fixtureState = await fixture();
  fixtureState.git('update-index', '--assume-unchanged', 'docs/note.txt');
  await writeFile(join(fixtureState.directory, 'docs/note.txt'), 'hidden dirty');
  await assert.rejects(fixtureState.capture(), /operator_write_index_flags_unsupported/);
});

test('snapshot and receipt provenance reject tampering', async () => {
  const fixtureState = await fixture();
  const mutation = await fixtureState.prepare();
  const forged = structuredClone(fixtureState.snapshot);
  forged.head = 'forged';
  await assert.rejects(applyOperatorFileMutation(forged, [], mutation), /operator_write_snapshot_invalid/);
  const receipt = await applyOperatorFileMutation(fixtureState.snapshot, [], mutation);
  await assert.rejects(operatorWriteArtifact(fixtureState.snapshot, [{ ...receipt, afterSha256: operatorWriteSha256('forged') }]), /operator_write_receipt_invalid/);
  await assert.rejects(operatorWriteArtifact(fixtureState.snapshot, [receipt, receipt]), /operator_write_receipt_invalid/);
});

test('fixed writer failure returns no success receipt and leaves the original file intact', async () => {
  const fixtureState = await fixture();
  const mutation = await fixtureState.prepare();
  const identity = fixtureState.snapshot.files.find(file => file.path === mutation.path)!;
  await assert.rejects(runOperatorFileWriter(fixtureState.snapshot, mutation, { ...identity, inode: identity.inode + 1 }), /operator_write_writer_uncertain/);
  assert.equal(await readFile(join(fixtureState.directory, mutation.path), 'utf8'), 'original\n');
  assert.deepEqual(await inspectOperatorFileMutation(fixtureState.snapshot, [], mutation), { status: 'not-applied' });
});

test('sequential named-file mutations preserve receipt order and exact before digests', async () => {
  const fixtureState = await fixture();
  const first = await fixtureState.prepare('first\n');
  const firstReceipt = await applyOperatorFileMutation(fixtureState.snapshot, [], first);
  const second = await prepareOperatorFileMutation(fixtureState.snapshot, [firstReceipt], { id: 'mutation-2',
    path: first.path, expectedBeforeSha256: first.afterSha256, content: 'second\n' });
  const secondReceipt = await applyOperatorFileMutation(fixtureState.snapshot, [firstReceipt], second);
  const artifact = await operatorWriteArtifact(fixtureState.snapshot, [firstReceipt, secondReceipt]);
  assert.match(artifact.diff, /-original\n\+second/);
  await assert.rejects(operatorWriteArtifact(fixtureState.snapshot, [secondReceipt, firstReceipt]), /operator_write_receipt_invalid/);
});

test('partial-clone lazy fetch configuration is refused before workspace inspection', async () => {
  const fixtureState = await fixture();
  fixtureState.git('config', 'remote.origin.promisor', 'true');
  await assert.rejects(fixtureState.capture(), /operator_write_partial_clone_unsupported/);
});

test('host-pinned Node selection ignores OpenCode execPath and rejects relative/PATH candidates', async () => {
  const executable = process.execPath;
  const originalHost = process.env.ONIONSOUP_HOST_NODE;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  try {
    Object.defineProperty(process, 'execPath', { ...descriptor, value: '/fixture/opencode' });
    process.env.ONIONSOUP_HOST_NODE = executable;
    const resolved = await resolveOperatorWriterNode();
    const command = await operatorWriterCommand();
    assert.equal(command.node, resolved);
    assert.equal(command.args[command.args.indexOf('--max-old-space-size=128') - 1], '/tmp/operator-node');
    assert.notEqual(resolved, process.execPath);
    process.env.ONIONSOUP_HOST_NODE = 'node';
    await assert.rejects(resolveOperatorWriterNode(), /operator_write_node_unavailable/);
    process.env.ONIONSOUP_HOST_NODE = '/usr/bin/true';
    await assert.rejects(resolveOperatorWriterNode(), /operator_write_node_invalid/);
  } finally {
    Object.defineProperty(process, 'execPath', descriptor);
    if (originalHost === undefined) delete process.env.ONIONSOUP_HOST_NODE;
    else process.env.ONIONSOUP_HOST_NODE = originalHost;
  }
});

test('Bun without an explicit host Node path fails closed instead of invoking its compiled executable', async () => {
  const originalHost = process.env.ONIONSOUP_HOST_NODE;
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
  try {
    delete process.env.ONIONSOUP_HOST_NODE;
    Object.defineProperty(process.versions, 'bun', { configurable: true, value: 'fixture' });
    await assert.rejects(resolveOperatorWriterNode(), /operator_write_node_unavailable/);
  } finally {
    if (descriptor) Object.defineProperty(process.versions, 'bun', descriptor);
    else delete process.versions.bun;
    if (originalHost === undefined) delete process.env.ONIONSOUP_HOST_NODE;
    else process.env.ONIONSOUP_HOST_NODE = originalHost;
  }
});

test('a staged helper and trusted Node under temporary paths survive the writer tmpfs without exposing that directory', async () => {
  const fixtureState = await fixture();
  const source = await mkdtemp(join(tmpdir(), 'operator-write-staged-'));
  for (const name of ['operator-write-workspace.ts', 'operator-write-writer.ts', 'operator-write-file.mjs']) {
    await cp(new URL(`../src/${name}`, import.meta.url), join(source, name));
  }
  await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(source, 'node_modules'));
  const node = join(source, 'node');
  await copyFile(await resolveOperatorWriterNode(), node, constants.COPYFILE_FICLONE);
  await chmod(node, 0o755);
  const api = await import(pathToFileURL(join(source, 'operator-write-workspace.ts')).href);
  const intent = await fixtureState.prepare('staged successfully\n');
  const originalNode = process.env.ONIONSOUP_HOST_NODE;
  try {
    process.env.ONIONSOUP_HOST_NODE = node;
    const receipt = await api.applyOperatorFileMutation(fixtureState.snapshot, [], intent);
    assert.equal(receipt.afterSha256, operatorWriteSha256('staged successfully\n'));
    assert.equal(await readFile(join(fixtureState.directory, intent.path), 'utf8'), 'staged successfully\n');
    const command = await operatorWriterCommand();
    const mask = command.args.indexOf('--tmpfs');
    assert.equal(command.args[mask + 1], '/tmp');
    assert.ok(command.args.indexOf('--ro-bind-fd') > mask);
    assert.equal(command.args.filter(arg => arg === '--bind-fd').length, 1);
    assert.equal(command.args.filter(arg => arg === '--ro-bind-fd').length, 2);
    assert.ok(!command.args.includes(source));
  } finally {
    if (originalNode === undefined) delete process.env.ONIONSOUP_HOST_NODE;
    else process.env.ONIONSOUP_HOST_NODE = originalNode;
  }
});

test('missing descriptor-bind support is an explicit preflight error, never a pathname fallback', async () => {
  assert.throws(() => requireOperatorWriterBwrapFeatures('    --bind SRC DEST\n    --ro-bind SRC DEST\n'), /operator_write_bwrap_unsupported/);
  assert.throws(() => requireOperatorWriterBwrapFeatures('    --bind-fd FD DEST\n'), /operator_write_bwrap_unsupported/);
  assert.doesNotThrow(() => requireOperatorWriterBwrapFeatures('    --bind-fd FD DEST\n    --ro-bind-fd FD DEST\n'));
});
