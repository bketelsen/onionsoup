import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, link, mkdir, mkdtemp, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { operatorWriterCommand, requireOperatorWriterBwrapFeatures, resolveOperatorWriterNode, runOperatorFileWriter } from '../src/operator-write-writer.ts';
import { applyOperatorFileMutation, inspectOperatorFileMutation, operatorWriteArtifact, operatorWriteSha256,
  prepareOperatorFileMutation, readOperatorWriteSourceFiles, snapshotOperatorWriteWorkspace, validateOperatorWriteWorkspace } from '../src/operator-write-workspace.ts';

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
  for (const name of ['operator-write-workspace.ts', 'operator-write-writer.ts', 'operator-write-file.mjs',
    'operator-check-source.ts', 'cgroup-budget.ts']) {
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

test('approved colon-magic filenames remain literal and visible in the host review diff', async () => {
  const fixtureState = await fixture();
  const path = ':(exclude)*';
  await writeFile(join(fixtureState.directory, path), 'literal original\n');
  fixtureState.git('add', '.');
  fixtureState.git('commit', '-qm', 'literal filename fixture');
  const snapshot = await fixtureState.capture([path]);
  const mutation = await prepareOperatorFileMutation(snapshot, [], { id: 'literal-path', path,
    expectedBeforeSha256: operatorWriteSha256('literal original\n'), content: 'literal changed\n' });
  const receipt = await applyOperatorFileMutation(snapshot, [], mutation);
  const artifact = await operatorWriteArtifact(snapshot, [receipt]);
  assert.ok(artifact.diff.includes('a/:(exclude)*'));
  assert.match(artifact.diff, /-literal original\n\+literal changed/);
  assert.equal(artifact.diffSha256, operatorWriteSha256(artifact.diff));
  assert.deepEqual(artifact.files.map(file => file.path), [path]);
  assert.equal(await readFile(join(fixtureState.directory, 'other.txt'), 'utf8'), 'untouched\n');
  // Without literal pathspec handling this exact approved filename excludes every diff entry.
  assert.equal(fixtureState.git('diff', '--no-ext-diff', '--no-textconv', '--', path), '');
});

async function creationFixture(path = 'docs/new.txt') {
  const original = await fixture();
  const snapshot = await snapshotOperatorWriteWorkspace({ workspace: original.workspace, directory: original.directory, files: [], createFiles: [path] });
  const prepare = (content = 'created π\n') => prepareOperatorFileMutation(snapshot, [], {
    id: 'create-1', path, expectedBeforeSha256: 'absent', content,
  });
  return { ...original, snapshot, prepare, path };
}

test('explicit absent-file creation records its exact identity and untracked new-file review diff', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  assert.equal(intent.beforeSha256, 'absent');
  const receipt = await applyOperatorFileMutation(current.snapshot, [], intent);
  const actual = await stat(join(current.directory, current.path));
  assert.equal(receipt.created?.inode, actual.ino);
  assert.equal(receipt.created?.device, actual.dev);
  assert.equal(receipt.created?.mode, 0o100600);
  assert.equal(receipt.created?.birthtimeNs, (await stat(join(current.directory, current.path), { bigint: true })).birthtimeNs.toString());
  assert.equal(await readFile(join(current.directory, current.path), 'utf8'), 'created π\n');
  assert.equal(current.git('diff', '--cached'), '');
  assert.equal(current.git('ls-files', '--', current.path), '');
  const artifact = await operatorWriteArtifact(current.snapshot, [receipt]);
  assert.match(artifact.diff, /new file mode 100644/);
  assert.match(artifact.diff, /--- \/dev\/null/);
  assert.match(artifact.diff, /\+created π/);
  assert.deepEqual(artifact.files, [{ path: current.path, beforeSha256: 'absent', afterSha256: intent.afterSha256 }]);
  assert.equal(artifact.diffSha256, operatorWriteSha256(artifact.diff));
});

test('a receipted new file can be updated without replacing its created inode', async () => {
  const current = await creationFixture();
  const first = await current.prepare();
  const created = await applyOperatorFileMutation(current.snapshot, [], first);
  const next = await prepareOperatorFileMutation(current.snapshot, [created], { id: 'update-2', path: current.path,
    expectedBeforeSha256: first.afterSha256, content: 'updated new file\n' });
  const updated = await applyOperatorFileMutation(current.snapshot, [created], next);
  assert.equal(Object.hasOwn(updated, 'created'), false);
  assert.equal((await stat(join(current.directory, current.path))).ino, created.created!.inode);
  const artifact = await operatorWriteArtifact(current.snapshot, [created, updated]);
  assert.match(artifact.diff, /\+updated new file/);
  assert.doesNotMatch(artifact.diff, /created π/);
});

test('legacy serialized snapshots, mutation receipts and artifacts retain their original digest bodies', async () => {
  const current = await fixture();
  const snapshot = JSON.parse(JSON.stringify(current.snapshot));
  assert.equal(Object.hasOwn(snapshot, 'createFiles'), false);
  const explicitEmpty = await snapshotOperatorWriteWorkspace({ workspace: current.workspace, directory: current.directory,
    files: ['docs/note.txt'], createFiles: [] });
  assert.deepEqual(explicitEmpty, snapshot);
  const intent = await current.prepare();
  const receipt = await applyOperatorFileMutation(snapshot, [], intent);
  const artifact = await operatorWriteArtifact(snapshot, [JSON.parse(JSON.stringify(receipt))]);
  assert.equal(Object.hasOwn(receipt, 'created'), false);
  for (const record of [snapshot, receipt, artifact]) {
    const { digest, ...body } = record;
    assert.equal(digest, operatorWriteSha256(JSON.stringify(body)));
  }
});

for (const path of ['../escape', '/tmp/escape', '.git/new', 'docs/.git/new', 'missing/new.txt', 'docs/../new.txt', 'other.txt']) {
  test(`new-file scope refuses ${JSON.stringify(path)} before any creation`, async () => {
    const current = await fixture();
    await assert.rejects(snapshotOperatorWriteWorkspace({ workspace: current.workspace, directory: current.directory, files: [], createFiles: [path] }));
    assert.equal(await readFile(join(current.directory, 'other.txt'), 'utf8'), 'untouched\n');
  });
}

test('new files must not be ignored, duplicated or overlap the existing-file scope', async () => {
  const current = await fixture();
  await writeFile(join(current.directory, '.gitignore'), 'docs/ignored*\n');
  current.git('add', '.');
  current.git('commit', '-qm', 'ignore fixture');
  const input = { workspace: current.workspace, directory: current.directory, files: [] };
  await assert.rejects(snapshotOperatorWriteWorkspace({ ...input, createFiles: ['docs/ignored.txt'] }), /creation_ignored/);
  await assert.rejects(snapshotOperatorWriteWorkspace({ ...input, createFiles: ['new.txt', 'new.txt'] }), /scope_invalid/);
  await assert.rejects(snapshotOperatorWriteWorkspace({ ...input, files: ['other.txt'], createFiles: ['other.txt'] }), /scope_invalid/);
});

test('an ignored-path rule added after approval blocks creation without touching the index', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  await writeFile(join(current.directory, '.git/info/exclude'), 'docs/new.txt\n');
  await assert.rejects(applyOperatorFileMutation(current.snapshot, [], intent), /creation_ignored/);
  await assert.rejects(access(join(current.directory, current.path)));
});

for (const content of ['foreign bytes', 'created π\n']) {
  test(`unreceipted existing ${content === 'foreign bytes' ? 'foreign' : 'matching'} bytes cannot be adopted or overwritten as a creation`, async () => {
    const current = await creationFixture();
    const intent = await current.prepare();
    await writeFile(join(current.directory, current.path), content);
    await assert.rejects(applyOperatorFileMutation(current.snapshot, [], intent), /mutation_uncertain/);
    await assert.rejects(inspectOperatorFileMutation(current.snapshot, [], intent), /mutation_uncertain/);
    await assert.rejects(operatorWriteArtifact(current.snapshot, []), /creation_exists/);
    assert.equal(await readFile(join(current.directory, current.path), 'utf8'), content);
  });
}

test('O_EXCL at the fixed helper refuses a file appearing after preparation', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  await writeFile(join(current.directory, current.path), 'raced foreign file');
  await assert.rejects(runOperatorFileWriter(current.snapshot, intent), /writer_uncertain/);
  assert.equal(await readFile(join(current.directory, current.path), 'utf8'), 'raced foreign file');
});

test('two racing fixed creators produce one effect and never overwrite the winning inode', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  const outcomes = await Promise.allSettled([runOperatorFileWriter(current.snapshot, intent), runOperatorFileWriter(current.snapshot, intent)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  assert.equal(await readFile(join(current.directory, current.path), 'utf8'), 'created π\n');
  await assert.rejects(applyOperatorFileMutation(current.snapshot, [], intent), /mutation_uncertain/);
});

test('lost creation acknowledgement remains uncertain despite exact final bytes', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  await runOperatorFileWriter(current.snapshot, intent); // Simulate losing the host receipt after the fixed helper exited.
  await assert.rejects(inspectOperatorFileMutation(current.snapshot, [], intent), /mutation_uncertain/);
  await assert.rejects(applyOperatorFileMutation(current.snapshot, [], intent), /mutation_uncertain/);
  assert.equal(await readFile(join(current.directory, current.path), 'utf8'), 'created π\n');
});

for (const change of ['parent', 'symlink', 'hardlink'] as const) {
  test(`new-file authority rejects a ${change} swap before creation`, async () => {
    const current = await creationFixture();
    const intent = await current.prepare();
    const actions = {
      parent: async () => { await rename(join(current.directory, 'docs'), join(current.directory, 'old-docs')); await mkdir(join(current.directory, 'docs')); },
      symlink: async () => { await symlink('../other.txt', join(current.directory, current.path)); },
      hardlink: async () => { await link(join(current.directory, 'other.txt'), join(current.directory, current.path)); },
    };
    await actions[change]();
    await assert.rejects(applyOperatorFileMutation(current.snapshot, [], intent));
    assert.equal(await readFile(join(current.directory, 'other.txt'), 'utf8'), 'untouched\n');
  });
}

test('a replaced created inode and forged receipt identity cannot authorize later writes', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  const receipt = await applyOperatorFileMutation(current.snapshot, [], intent);
  const { digest: _digest, ...body } = receipt;
  const forgedBody = { ...body, created: { ...receipt.created!, inode: receipt.created!.inode + 1 } };
  await assert.rejects(validateOperatorWriteWorkspace(current.snapshot, [{ ...forgedBody, digest: operatorWriteSha256(JSON.stringify(forgedBody)) }]), /source_changed/);
  const forgedBirth = { ...body, created: { ...receipt.created!, birthtimeNs: String(BigInt(receipt.created!.birthtimeNs!) + 1n) } };
  await assert.rejects(validateOperatorWriteWorkspace(current.snapshot, [{ ...forgedBirth, digest: operatorWriteSha256(JSON.stringify(forgedBirth)) }]), /source_changed/);
  const missingBody = { ...body };
  delete missingBody.created;
  await assert.rejects(validateOperatorWriteWorkspace(current.snapshot, [{ ...missingBody, digest: operatorWriteSha256(JSON.stringify(missingBody)) }]), /receipt_invalid/);
  await rename(join(current.directory, current.path), join(current.workspace, 'original-created'));
  await writeFile(join(current.directory, current.path), intent.content);
  await assert.rejects(prepareOperatorFileMutation(current.snapshot, [receipt], { id: 'later', path: current.path,
    expectedBeforeSha256: intent.afterSha256, content: 'must not write' }), /source_changed/);
});

test('a new literal pathspec-like filename and empty file both remain visible in review', async () => {
  for (const content of ['literal content\n', '']) {
    const current = await creationFixture(':(exclude)*');
    const intent = await current.prepare(content);
    const receipt = await applyOperatorFileMutation(current.snapshot, [], intent);
    const artifact = await operatorWriteArtifact(current.snapshot, [receipt]);
    assert.ok(artifact.diff.includes(':(exclude)*'));
    assert.match(artifact.diff, /new file mode/);
    assert.equal(artifact.files[0]?.beforeSha256, 'absent');
  }
});

test('source-copy reader returns exact tracked binary/text and receipted new bytes while excluding ignored data', async () => {
  const current = await fixture();
  await writeFile(join(current.directory, '.gitignore'), '.private-cache\n');
  await writeFile(join(current.directory, 'binary.bin'), Buffer.from([0, 255, 13]));
  current.git('add', '.');
  current.git('commit', '-qm', 'source fixture');
  const snapshot = await snapshotOperatorWriteWorkspace({ workspace: current.workspace, directory: current.directory,
    files: [], createFiles: ['docs/new.txt'] });
  const intent = await prepareOperatorFileMutation(snapshot, [], { id: 'source-new', path: 'docs/new.txt',
    expectedBeforeSha256: 'absent', content: 'new source\n' });
  const receipt = await applyOperatorFileMutation(snapshot, [], intent);
  await writeFile(join(current.directory, '.private-cache'), 'must not copy');
  const source = await readOperatorWriteSourceFiles(snapshot, [receipt]);
  assert.deepEqual(source.find(file => file.path === 'binary.bin')?.content, Buffer.from([0, 255, 13]));
  assert.equal(source.find(file => file.path === 'docs/new.txt')?.content.toString('utf8'), 'new source\n');
  assert.equal(source.some(file => file.path.startsWith('.git/') || file.path === '.private-cache'), false);
  await writeFile(join(current.directory, 'unrelated.txt'), 'foreign');
  await assert.rejects(readOperatorWriteSourceFiles(snapshot, [receipt]), /untracked_files/);
});

test('source-copy reader never follows a tracked symlink', async () => {
  const current = await fixture();
  await symlink('/etc/passwd', join(current.directory, 'external-link'));
  current.git('add', '.');
  current.git('commit', '-qm', 'symlink fixture');
  const snapshot = await current.capture();
  await assert.rejects(readOperatorWriteSourceFiles(snapshot, []), /operator_check_source_invalid/);
});

test('new-file bounds reject oversized/nontext content and cap the combined scope', async () => {
  const current = await creationFixture();
  await assert.rejects(current.prepare('x'.repeat(256 * 1024 + 1)), /text_invalid/);
  await assert.rejects(current.prepare('nul\0content'), /text_invalid/);
  await assert.rejects(current.prepare('\ud800'), /text_invalid/);
  await assert.rejects(snapshotOperatorWriteWorkspace({ workspace: current.workspace, directory: current.directory,
    files: ['other.txt'], createFiles: ['new.txt'], limits: { approvedFiles: 1 } }), /scope_invalid/);
  await assert.rejects(access(join(current.directory, current.path)));
});

test('a clean existing repository with an empty commit can receive its first explicit file', async () => {
  const current = await fixture();
  current.git('rm', '-q', '-r', '.');
  current.git('commit', '-qm', 'empty tree');
  const snapshot = await snapshotOperatorWriteWorkspace({ workspace: current.workspace, directory: current.directory,
    files: [], createFiles: ['first.txt'] });
  const intent = await prepareOperatorFileMutation(snapshot, [], { id: 'first', path: 'first.txt', expectedBeforeSha256: 'absent', content: 'first\n' });
  const receipt = await applyOperatorFileMutation(snapshot, [], intent);
  assert.match((await operatorWriteArtifact(snapshot, [receipt])).diff, /\+first/);
});

test('literal ignored-path checks do not expand wildcard filenames and new text diff ignores binary attributes', async () => {
  const current = await fixture();
  await writeFile(join(current.directory, '.gitignore'), 'docs/specific.txt\n');
  await writeFile(join(current.directory, '.gitattributes'), '*.txt binary\n');
  current.git('add', '.');
  current.git('commit', '-qm', 'literal ignore and attribute fixture');
  const path = 'docs/*.txt';
  const snapshot = await snapshotOperatorWriteWorkspace({ workspace: current.workspace, directory: current.directory, files: [], createFiles: [path] });
  const intent = await prepareOperatorFileMutation(snapshot, [], { id: 'wildcard', path, expectedBeforeSha256: 'absent', content: 'must be visible\n' });
  const receipt = await applyOperatorFileMutation(snapshot, [], intent);
  const artifact = await operatorWriteArtifact(snapshot, [receipt]);
  assert.ok(artifact.diff.includes('b/docs/*.txt'));
  assert.match(artifact.diff, /\+must be visible/);
  assert.doesNotMatch(artifact.diff, /Binary files/);
});

test('source-copy reader rejects a changed created hardlink before returning any bytes', async () => {
  const current = await creationFixture();
  const intent = await current.prepare();
  const receipt = await applyOperatorFileMutation(current.snapshot, [], intent);
  await link(join(current.directory, current.path), join(current.workspace, 'outside-alias'));
  await assert.rejects(readOperatorWriteSourceFiles(current.snapshot, [receipt]), /source_changed/);
});
