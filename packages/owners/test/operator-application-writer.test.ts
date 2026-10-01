import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cleanupOperatorApplicationStage, inspectOperatorApplicationFile, prepareOperatorApplicationFile,
  runOperatorApplicationFile, type OperatorApplicationFileIntent } from '../src/operator-application-writer.ts';
import { inspectOperatorCheckWitness, readOperatorCheckOwner, type OperatorCheckWitness } from '../src/operator-check-execution.ts';
import { operatorWriteSha256, snapshotOperatorWriteWorkspace } from '../src/operator-write-workspace.ts';
import { resolveOperatorWriterNode } from '../src/operator-write-writer.ts';

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-application-'));
  const directory = join(workspace, 'repo');
  await mkdir(join(directory, 'docs'), { recursive: true });
  await writeFile(join(directory, 'docs/old.txt'), 'original\n');
  await writeFile(join(directory, 'other.txt'), 'untouched\n');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', directory, ...args], { encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const snapshot = await snapshotOperatorWriteWorkspace({ workspace, directory, files: ['docs/old.txt'], createFiles: ['docs/new.txt'] });
  const mutation = (path: string, content = 'applied π\n') => ({ id: `file_${path.endsWith('new.txt') ? 'new' : 'old'}`, path,
    snapshotDigest: snapshot.digest, beforeSha256: path.endsWith('new.txt') ? 'absent' : operatorWriteSha256('original\n'),
    afterSha256: operatorWriteSha256(content), content });
  const prepare = (path: string, content?: string) => prepareOperatorApplicationFile(snapshot, mutation(path, content));
  return { workspace, directory, snapshot, git, prepare, mutation };
}

for (const path of ['docs/old.txt', 'docs/new.txt']) {
  test(`real publisher applies ${path}, preserves Git and cleans only its staged inode`, async () => {
    const context = await fixture();
    const intent = await context.prepare(path);
    const owner = await readOperatorCheckOwner();
    let witness: OperatorCheckWitness | undefined;
    const applied = await runOperatorApplicationFile(intent, { onWitness: async value => { witness = value; } });
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.observation.state, 'after', applied.observation.reason);
    assert.ok(witness);
    assert.equal((await inspectOperatorCheckWitness(witness)).state, 'stopped');
    assert.equal(await readFile(join(context.directory, path), 'utf8'), 'applied π\n');
    assert.equal((await stat(join(context.directory, path))).nlink, path.endsWith('new.txt') ? 2 : 1);
    await cleanupOperatorApplicationStage(intent, applied.inspection, owner);
    assert.equal((await inspectOperatorApplicationFile(intent, applied.inspection, owner)).state, 'after');
    assert.equal((await stat(join(context.directory, path))).nlink, 1);
    assert.equal((await readdir(join(context.directory, 'docs'))).some(name => name.startsWith('.onionsoup-application-')), false);
    assert.equal(context.git('rev-parse', 'HEAD').trim(), context.snapshot.head);
    assert.equal(operatorWriteSha256(await readFile(join(context.snapshot.gitDirectory, 'index'))), context.snapshot.indexSha256);
    assert.equal(context.git('diff', '--cached'), '');
    assert.equal(await readFile(join(context.directory, 'other.txt'), 'utf8'), 'untouched\n');
    await cleanupOperatorApplicationStage(intent, applied.inspection, owner);
  });
}

test('failed witness persistence permits no publication and the exact staged inode can support a new proven-before attempt', async () => {
  const context = await fixture();
  const intent = await context.prepare('docs/new.txt');
  const blocked = await runOperatorApplicationFile(intent, { onWitness: async () => { throw new Error('fixture journal failed'); } });
  assert.equal(blocked.observation.state, 'before');
  assert.equal(blocked.inspection.state, 'stopped');
  await assert.rejects(context.prepare('docs/new.txt'), /EEXIST/);
  const applied = await runOperatorApplicationFile(intent, { onWitness: async () => {} });
  assert.equal(applied.observation.state, 'after');
  assert.equal(applied.observation.target!.inode, intent.stage.inode);
});

test('an unrelated new destination appearing before permit is never overwritten', async () => {
  const context = await fixture();
  const intent = await context.prepare('docs/new.txt');
  const result = await runOperatorApplicationFile(intent, { onWitness: async () => {
    await writeFile(join(context.directory, 'docs/new.txt'), 'foreign\n', { flag: 'wx' });
  } });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.observation.state, 'foreign');
  assert.equal(await readFile(join(context.directory, 'docs/new.txt'), 'utf8'), 'foreign\n');
  await assert.rejects(cleanupOperatorApplicationStage(intent, result.inspection, await readOperatorCheckOwner()), /cleanup_unproven/);
});

test('pathname replacement cannot redirect a pinned existing-file publication', async () => {
  const context = await fixture();
  const intent = await context.prepare('docs/old.txt');
  const result = await runOperatorApplicationFile(intent, { onWitness: async () => {
    await rename(join(context.directory, 'docs/old.txt'), join(context.workspace, 'original-inode.txt'));
    await writeFile(join(context.directory, 'docs/old.txt'), 'foreign replacement\n');
  } });
  assert.equal(result.observation.state, 'foreign');
  assert.equal(await readFile(join(context.directory, 'docs/old.txt'), 'utf8'), 'foreign replacement\n');
  // bwrap can reject the renamed bind source before the publisher starts; otherwise only the pinned inode changes.
  assert.equal(await readFile(join(context.workspace, 'original-inode.txt'), 'utf8'), result.exitCode === 0 ? 'applied π\n' : 'original\n');
});

test('partial bytes, changed staged provenance, and unproved owners remain fenced', async () => {
  const context = await fixture();
  const intent = await context.prepare('docs/old.txt');
  const owner = await readOperatorCheckOwner();
  const applied = await runOperatorApplicationFile(intent, { onWitness: async () => {} });
  await writeFile(join(context.directory, 'docs/old.txt'), 'partial');
  assert.equal((await inspectOperatorApplicationFile(intent, applied.inspection, owner)).state, 'partial');
  await assert.rejects(cleanupOperatorApplicationStage(intent, applied.inspection, owner), /cleanup_unproven/);
  await assert.rejects(inspectOperatorApplicationFile(intent, { state: 'running', reason: 'fixture' }, owner), /process_unproven/);
  await assert.rejects(inspectOperatorApplicationFile(intent, applied.inspection, { ...owner, started: '0' }), /process_unproven/);
  await unlink(join(context.directory, intent.stage.path));
  await writeFile(join(context.directory, intent.stage.path), 'unrelated stage');
  assert.equal((await inspectOperatorApplicationFile(intent, applied.inspection, owner)).state, 'foreign');
  await assert.rejects(cleanupOperatorApplicationStage(intent, applied.inspection, owner), /cleanup_unproven/);
  assert.equal(await readFile(join(context.directory, intent.stage.path), 'utf8'), 'unrelated stage');
});

test('unapproved paths, symlink parents and occupied staging never become publication authority', async () => {
  const context = await fixture();
  await assert.rejects(prepareOperatorApplicationFile(context.snapshot, context.mutation('../outside.txt')), /path_invalid/);
  await assert.rejects(prepareOperatorApplicationFile(context.snapshot, context.mutation('other.txt')), /mutation_invalid/);
  await context.prepare('docs/new.txt');
  await assert.rejects(context.prepare('docs/new.txt'), /EEXIST/);
  await rename(join(context.directory, 'docs'), join(context.workspace, 'moved-docs'));
  await symlink(join(context.workspace, 'moved-docs'), join(context.directory, 'docs'));
  await assert.rejects(context.prepare('docs/old.txt'));
  assert.equal(await readFile(join(context.workspace, 'moved-docs/old.txt'), 'utf8'), 'original\n');
});

async function eventually<T>(observe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed !== undefined) return observed;
    await delay(20);
  }
  assert.fail('fixture process did not reach the expected boundary');
}

async function crashOwner(context: Awaited<ReturnType<typeof fixture>>, intent: OperatorApplicationFileIntent, afterPublish: boolean) {
  const script = join(context.workspace, 'crash-owner.mjs');
  const intentPath = join(context.workspace, 'intent.json');
  const witnessPath = join(context.workspace, 'witness.json');
  await writeFile(intentPath, JSON.stringify(intent));
  await writeFile(script, `import childProcess from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.spawn;
childProcess.spawn=(command,args,options)=>{const child=original(command,args,options);
  child.stdout?.on('data',chunk=>{if(${afterPublish} && String(chunk).includes('operator_application_published')) process.kill(process.pid,'SIGKILL');});return child;};
syncBuiltinESMExports();
const {runOperatorApplicationFile}=await import(${JSON.stringify(new URL('../src/operator-application-writer.ts', import.meta.url).href)});
await runOperatorApplicationFile(JSON.parse(await readFile(${JSON.stringify(intentPath)},'utf8')),
  {onWitness:async witness=>{await writeFile(${JSON.stringify(witnessPath)},JSON.stringify(witness));
    if(!${afterPublish}) process.kill(process.pid,'SIGKILL');}});
`);
  const owner = spawn(await resolveOperatorWriterNode(), ['--conditions=onionsoup-source', '--import',
    fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)), script], { stdio: 'ignore' });
  try {
    const witness = await eventually(async () => {
      try { return JSON.parse(await readFile(witnessPath, 'utf8')) as OperatorCheckWitness; } catch { return undefined; }
    });
    if (owner.exitCode === null && owner.signalCode === null) await once(owner, 'close');
    assert.equal(owner.signalCode, 'SIGKILL');
    const inspection = await eventually(async () => {
      const value = await inspectOperatorCheckWitness(witness);
      return value.state === 'stopped' ? value : undefined;
    });
    return { witness, inspection };
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); }
}

for (const path of ['docs/old.txt', 'docs/new.txt']) {
  for (const afterPublish of [false, true]) {
    test(`actual owner crash ${afterPublish ? 'after publication before host receipt' : 'before permit'} reconciles ${path} without guessing`, async () => {
      const context = await fixture();
      const intent = await context.prepare(path);
      const stopped = await crashOwner(context, intent, afterPublish);
      const observed = await inspectOperatorApplicationFile(intent, stopped.inspection, stopped.witness.owner);
      assert.equal(observed.state, afterPublish ? 'after' : 'before', observed.reason);
      assert.equal(context.git('rev-parse', 'HEAD').trim(), context.snapshot.head);
      assert.equal(operatorWriteSha256(await readFile(join(context.snapshot.gitDirectory, 'index'))), context.snapshot.indexSha256);
      if (afterPublish) {
        await cleanupOperatorApplicationStage(intent, stopped.inspection, stopped.witness.owner);
        assert.equal((await inspectOperatorApplicationFile(intent, stopped.inspection, stopped.witness.owner)).state, 'after');
      } else {
        const retry = await runOperatorApplicationFile(intent, { onWitness: async () => {} });
        assert.equal(retry.observation.state, 'after');
      }
    });
  }
}
