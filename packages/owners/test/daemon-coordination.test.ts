import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, rename, unlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { tick, drain, type TickLog } from '../src/daemon.ts';
import { memoryStatus, requestDistill } from '../src/memory.ts';
import { armDeployment, beginDrain, listAdmissions, releaseDrain } from '../src/deployment-admission.ts';
import { Background } from '../src/daemon.ts';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const runCli = promisify(execFile);

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function setup() {
  const runtime = await Runtime.open({
    declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'onionsoup-coordination-')),
  });
  runtime.reloadDeclarations = async () => {};
  for (const owner of runtime.declarations.owners.values()) {
    owner.duties = [];
    owner.memory.enabled = false;
    await runtime.notebook(owner.id).ensure('# Coordination fixture');
  }
  const errors: unknown[] = [];
  const log: TickLog = { duty() {}, item() {}, request() {}, error(_context, error) { errors.push(error); } };
  return { runtime, errors, log };
}

async function approved(runtime: Runtime) {
  const request = await runtime.requests.open('clippy', 'homelab', {
    kind: 'instance', image: 'images:debian/13', purpose: 'coordination', expectedMinutes: 5,
  }, 'none');
  return runtime.requests.save({ ...request, status: 'create-approved', decision: {
    decision: 'accept', reply: 'yes', remote: 'minideb', image: 'images:debian/13', nameSuffix: 'coordination',
  } });
}

test('a running request reserves both owners from queued memory maintenance', async () => {
  const { runtime, errors, log } = await setup();
  const request = await approved(runtime);
  const began = latch();
  const finish = latch();
  runtime.incus = { run: async () => { began.release(); await finish.promise; return ''; } };
  for (const owner of ['clippy', 'homelab']) await requestDistill(runtime, owner, 'person');
  try {
    await tick(runtime, log);
    await began.promise;
    await tick(runtime, log);
    for (const owner of ['clippy', 'homelab']) {
      assert.equal((await memoryStatus(runtime, owner)).queued, true);
      assert.equal((await memoryStatus(runtime, owner)).lastAttempt, undefined);
    }
  } finally {
    finish.release();
    await drain();
  }
  assert.equal((await runtime.requests.get(request.id)).status, 'provisioned');
  assert.deepEqual(errors, []);
});

test('a memory hire holds a later request until the owner is available', async () => {
  const { runtime, errors, log } = await setup();
  const began = latch();
  const finish = latch();
  runtime.hire = async (_owner, request) => {
    began.release();
    await finish.promise;
    const at = new Date().toISOString();
    return { value: request.schema.parse({ notebook: [] }), sessionID: 'memory', cost: 0, startedAt: at, finishedAt: at };
  };
  runtime.incus = { run: async () => '' };
  await runtime.notebook('clippy').journal({ kind: 'chat-decision', note: 'remember' });
  await requestDistill(runtime, 'clippy', 'person');
  await tick(runtime, log);
  await began.promise;
  const request = await approved(runtime);
  try {
    await tick(runtime, log);
    assert.equal((await runtime.requests.get(request.id)).operation, undefined);
  } finally {
    finish.release();
    await drain();
  }
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.requests.get(request.id)).status, 'provisioned');
  assert.deepEqual(errors, []);
});

test('a live external request runner reserves memory and runnable work', async () => {
  const { runtime, errors, log } = await setup();
  const request = await approved(runtime);
  await runtime.requests.save({ ...request, operation: {
    id: 'external', stage: 'create-approved', runner: process.pid, startedAt: new Date().toISOString(),
  } });
  const item = await runtime.ledger.create('clippy', 'change', {
    title: 'Wait', goal: 'Wait for owner', rationale: 'coordination', acceptance: ['serialized'], size: 'small',
  });
  await requestDistill(runtime, 'clippy', 'person');
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.ledger.get(item.id)).status, 'proposed');
  assert.equal((await memoryStatus(runtime, 'clippy')).lastAttempt, undefined);
  assert.equal((await runtime.requests.get(request.id)).operation?.runner, process.pid);
  assert.deepEqual(errors, []);
});

test('unavailable request storage does not stop later daemon ticks', async () => {
  const { runtime, errors, log } = await setup();
  const request = await approved(runtime);
  runtime.incus = { run: async () => '' };
  const directory = runtime.requests.directory;
  await rename(directory, `${directory}.unavailable`);
  await writeFile(directory, 'temporarily unavailable');
  try {
    await tick(runtime, log);
    assert.equal(errors.length, 2);
  } finally {
    await unlink(directory);
    await rename(`${directory}.unavailable`, directory);
  }
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.requests.get(request.id)).status, 'provisioned');
  assert.equal(errors.length, 2);
});

test('background admission is tracked before a job starts and releases only after it finishes', async () => {
  const { runtime } = await setup();
  const background = new Background(1, runtime.stateDirectory, 'test-job');
  const began = latch();
  const finish = latch();
  try {
    assert.equal(await background.start('one', async () => { began.release(); await finish.promise; }), true);
    await began.promise;
    const admissions = await listAdmissions(runtime.stateDirectory);
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0]?.kind, 'test-job');
    assert.equal(await background.start('one', async () => { throw new Error('duplicate'); }), false);
  } finally {
    finish.release();
    await background.drain();
  }
  assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
});

test('draining blocks a new tick and background job without effects', async () => {
  const { runtime, log } = await setup();
  const background = new Background(1, runtime.stateDirectory, 'test-job');
  await armDeployment(runtime.stateDirectory, 'build');
  await beginDrain(runtime.stateDirectory, 'build');
  try {
    assert.equal(await background.start('one', async () => { throw new Error('started'); }), false);
    runtime.ledger.markInterrupted = async () => { throw new Error('tick started'); };
    await tick(runtime, log);
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
  } finally {
    await releaseDrain(runtime.stateDirectory, 'build', 'cancelled');
  }
});

test('a tick already admitted finishes while drain blocks the next tick', async () => {
  const { runtime, log } = await setup();
  const began = latch();
  const finish = latch();
  runtime.ledger.markInterrupted = async () => { began.release(); await finish.promise; return 0; };
  const active = tick(runtime, log);
  await began.promise;
  await armDeployment(runtime.stateDirectory, 'build');
  const admitted = await beginDrain(runtime.stateDirectory, 'build');
  assert.equal(admitted.length, 1);
  try {
    await assert.rejects(releaseDrain(runtime.stateDirectory, 'build', 'completed'), /deployment_admissions_active/);
  } finally {
    finish.release();
    await active;
  }
  assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
  await releaseDrain(runtime.stateDirectory, 'build', 'completed');
});

test('direct CLI effects refuse admission while draining', async () => {
  const { runtime } = await setup();
  await armDeployment(runtime.stateDirectory, 'build');
  await beginDrain(runtime.stateDirectory, 'build');
  try {
    await assert.rejects(
      runCli(process.execPath, ['--import', 'tsx', 'packages/owners/src/cli.ts', '--state', runtime.stateDirectory, 'distill', 'clippy']),
      /deployment_draining/,
    );
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
  } finally {
    await releaseDrain(runtime.stateDirectory, 'build', 'cancelled');
  }
});

test('CLI daemon remains alive during drain and resumes startup recovery after release', async () => {
  const { runtime } = await setup();
  const proposal = { title: 'Restart recovery', goal: 'recover', rationale: 'drain', acceptance: ['no replay'], size: 'small' as const };
  const interrupted = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', activeRunner: 424242 });
  const retired = await runtime.ledger.create('clippy', 'change', proposal, { status: 'implementing' });
  await armDeployment(runtime.stateDirectory, 'build');
  await beginDrain(runtime.stateDirectory, 'build');
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'packages/owners/src/cli.ts', '--declarations', 'packages/owners/test/fixtures/owners',
    '--state', runtime.stateDirectory, 'daemon',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  async function until(condition: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await condition()) return;
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    assert.fail(`daemon did not reach expected state; exit=${child.exitCode}; output=${output}`);
  }
  try {
    await until(async () => output.includes('owners daemon:') && child.exitCode === null);
    assert.equal((await runtime.ledger.get(interrupted.id)).status, 'working');
    assert.equal((await runtime.ledger.get(retired.id)).status, 'implementing');
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
    await releaseDrain(runtime.stateDirectory, 'build', 'completed');
    await until(async () => (await runtime.ledger.get(retired.id)).status === 'failed');
    assert.equal((await runtime.ledger.get(interrupted.id)).status, 'interrupted');
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  }
  assert.doesNotMatch(output, /owners daemon: deployment_draining/);
});

test('CLI daemon stops cleanly on signal while drain remains held', async () => {
  const { runtime } = await setup();
  await requestDistill(runtime, 'clippy', 'person');
  const item = await runtime.ledger.create('clippy', 'owner-change', {
    title: 'Still running', goal: 'wait', rationale: 'drain', acceptance: ['unchanged'], size: 'small',
  }, { status: 'working', activeRunner: 424242 });
  await armDeployment(runtime.stateDirectory, 'build');
  await beginDrain(runtime.stateDirectory, 'build');
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'packages/owners/src/cli.ts', '--declarations', 'packages/owners/test/fixtures/owners',
    '--state', runtime.stateDirectory, 'daemon',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    for (let attempt = 0; attempt < 100 && !output.includes('owners daemon:'); attempt += 1) await sleep(50);
    assert.match(output, /owners daemon: \d+ owners/);
    assert.equal(child.exitCode, null);
    child.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(5_000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout');
    assert.equal((await runtime.ledger.get(item.id)).status, 'working');
    assert.equal((await memoryStatus(runtime, 'clippy')).queued, true);
    assert.equal((await memoryStatus(runtime, 'clippy')).lastAttempt, undefined);
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await releaseDrain(runtime.stateDirectory, 'build', 'cancelled');
  }
});
