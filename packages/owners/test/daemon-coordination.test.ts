import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { tick, drain, type TickLog } from '../src/daemon.ts';
import { memoryStatus, requestDistill } from '../src/memory.ts';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function setup() {
  const runtime = await Runtime.open({
    declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp('/tmp/onionsoup-coordination-'),
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
