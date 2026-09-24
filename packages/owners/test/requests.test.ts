import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { processRequest, processRequests } from '../src/brokering.ts';
import { recoverRequests, reconcileRequest, recoverRequest } from '../src/request-recovery.ts';
import { requestWork } from '../src/delegation.ts';
import { changeAttention, listAttention } from '../src/attention.ts';
import { tick, drain, type TickLog } from '../src/daemon.ts';
import type { ResourceRequest } from '../src/requests.ts';

const proposal = { title: 'Repair domain', goal: 'Fix the problem', rationale: 'Observed failure', acceptance: ['Works'], size: 'small' as const };
const ask = { kind: 'instance' as const, image: 'images:debian/13', purpose: 'test', expectedMinutes: 5 };
const decision = { decision: 'accept' as const, reply: 'yes', remote: 'minideb', image: ask.image, nameSuffix: 'test' };

async function setup() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'request-lifecycle-')) });
  for (const owner of runtime.declarations.owners.values()) await runtime.notebook(owner.id).ensure('# Test charter');
  return runtime;
}

async function approved(runtime: Runtime, suffix = 'test') {
  const opened = await runtime.requests.open('clippy', 'homelab', ask, 'none');
  return runtime.requests.save({ ...opened, status: 'create-approved', decision: { ...decision, nameSuffix: suffix } });
}

function operation(stage: ResourceRequest['status']): NonNullable<ResourceRequest['operation']> {
  return { id: 'operation-1', stage, startedAt: new Date().toISOString(), runner: 999999 };
}

test('a launch records operation identity before the effect; recovery adopts its tagged instance without launching again', async () => {
  const runtime = await setup();
  const request = await approved(runtime);
  const calls: string[][] = [];
  runtime.incus = { run: async args => {
    calls.push([...args]);
    const recorded = await runtime.requests.get(request.id);
    if (args[0] === 'launch') {
      assert.equal(recorded.operation?.stage, 'create-approved');
      assert.equal(recorded.operation?.checkpoint?.instance?.name, 'onionsoup-test');
      assert.ok(args.includes(`user.onionsoup.request=${request.id}`));
      throw new Error('connection lost after launch');
    }
    return JSON.stringify([{ name: 'onionsoup-test', type: 'container', status: 'Running', config: { 'user.onionsoup.request': request.id } }]);
  } };
  await processRequest(runtime, request.id);
  assert.equal((await runtime.requests.get(request.id)).status, 'interrupted');
  await recoverRequests(runtime, (_context, error) => { throw error; });
  assert.equal((await runtime.requests.get(request.id)).status, 'provisioned');
  assert.equal((await runtime.managed.list('homelab'))[0]?.requestId, request.id);
  assert.equal(calls.filter(call => call[0] === 'launch').length, 1);
});

test('an unrelated same-named instance cannot be adopted; queued requests stay queued and an inspected retry is audited', async () => {
  const runtime = await setup();
  const active = await approved(runtime);
  const queued = await approved(runtime, 'queued');
  await runtime.requests.save({ ...active, operation: { ...operation('create-approved'), checkpoint: {
    instance: { remote: 'minideb', name: 'onionsoup-test', image: ask.image },
  } } });
  runtime.incus = { run: async () => JSON.stringify([{ name: 'onionsoup-test', type: 'container', status: 'Running', config: { 'user.onionsoup.request': 'other' } }]) };
  await recoverRequests(runtime, (_context, error) => { throw error; });
  assert.equal((await runtime.requests.get(active.id)).status, 'interrupted');
  assert.equal((await runtime.requests.get(queued.id)).status, 'create-approved');
  assert.deepEqual(await runtime.managed.list('homelab'), []);
  await assert.rejects(recoverRequest(runtime, active.id, 'retry', 'person', ''), /reason_required/);
  const retried = await recoverRequest(runtime, active.id, 'retry', 'person', 'Removed unrelated instance; launch is safe');
  assert.equal(retried.status, 'create-approved');
  assert.equal((await runtime.requests.get(active.id)).recovery[0]?.by, 'person');
});

test('a crash after deletion clears the managed record without issuing another delete', async () => {
  const runtime = await setup();
  const request = await approved(runtime);
  const instance = { remote: 'minideb', name: 'onionsoup-test' };
  await runtime.managed.add('homelab', { ...instance, image: ask.image, requestId: request.id, requestedBy: request.from, createdAt: request.createdAt });
  await runtime.requests.save({ ...request, instance, status: 'delete-approved', operation: operation('delete-approved') });
  runtime.incus = { run: async args => {
    assert.equal(args[0], 'list');
    return '[]';
  } };
  await recoverRequests(runtime, (_context, error) => { throw error; });
  assert.equal((await runtime.requests.get(request.id)).status, 'deleted');
  assert.deepEqual(await runtime.managed.list('homelab'), []);
});

test('one failed owner decision does not starve subsequent requests', async () => {
  const runtime = await setup();
  runtime.hire = async () => { throw new Error('provider_unavailable'); };
  runtime.incus = { run: async () => '[]' };
  const broken = await runtime.requests.open('clippy', 'homelab', ask, 'none');
  const next = await approved(runtime);
  await processRequests(runtime);
  assert.equal((await runtime.requests.get(broken.id)).status, 'interrupted');
  assert.match((await runtime.requests.get(broken.id)).reason!, /provider_unavailable/);
  assert.equal((await runtime.requests.get(next.id)).status, 'provisioned');
});

test('a blocked request leaves ticks free and serializes requests sharing an owner', async () => {
  const runtime = await setup();
  const first = await approved(runtime, 'first');
  const second = await approved(runtime, 'second');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const calls: string[][] = [];
  runtime.incus = { run: async args => {
    calls.push([...args]);
    started();
    await gate;
    return '';
  } };
  const log: TickLog = { duty: () => {}, item: () => {}, request: () => {}, error: (_context, error) => { throw error; } };
  try {
    await tick(runtime, log);
    await began;
    await tick(runtime, log);
    assert.equal(calls.length, 1);
    const recorded = await runtime.requests.list();
    assert.equal(recorded.filter(request => request.operation?.runner).length, 1);
    assert.equal(recorded.filter(request => !request.operation).length, 1);
  } finally {
    release();
    await drain();
  }
  assert.equal((await runtime.requests.list()).filter(request => request.status === 'provisioned').length, 1);
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.requests.get(first.id)).status, 'provisioned');
  assert.equal((await runtime.requests.get(second.id)).status, 'provisioned');
});

test('delegation accepts into one linked work item, preserves plan gates, and reports merged outcomes', async () => {
  const runtime = await setup();
  runtime.hire = async (_owner, request) => ({ value: request.schema.parse({ decision: 'accept', reply: 'I own this' }), sessionID: 'scripted', cost: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const request = await requestWork(runtime, 'homelab', 'clippy', proposal);
  await processRequest(runtime, request.id);
  const accepted = await runtime.requests.get(request.id);
  assert.equal(accepted.status, 'work-running');
  const item = await runtime.ledger.get(accepted.workItem!);
  assert.equal(item.owner, 'clippy');
  assert.equal(item.status, 'proposed');
  assert.equal(item.planApproval, undefined);
  await runtime.requests.save({ ...accepted, status: 'interrupted', workItem: undefined, operation: operation('pending-owner') });
  await reconcileRequest(runtime, request.id);
  assert.equal((await runtime.requests.get(request.id)).workItem, item.id);
  assert.equal((await runtime.ledger.list()).length, 1);
  await runtime.ledger.save({ ...item, status: 'landed', publication: { url: 'https://example.test/pr/1', branch: 'owners/work', at: item.createdAt, by: 'person', state: 'merged' } });
  await processRequest(runtime, request.id);
  assert.equal((await runtime.requests.get(request.id)).status, 'completed');
});

test('declined work and failed delegated work escalate to durable actionable attention', async () => {
  const runtime = await setup();
  runtime.hire = async (_owner, request) => ({ value: request.schema.parse({ decision: 'decline', reply: 'Wrong priority' }), sessionID: 'scripted', cost: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const request = await requestWork(runtime, 'homelab', 'clippy', proposal);
  await processRequest(runtime, request.id);
  assert.equal((await runtime.requests.get(request.id)).status, 'declined');
  const entries = await listAttention(runtime);
  assert.deepEqual(entries.map(entry => entry.owner).sort(), ['clippy', 'homelab']);
  const entry = entries[0]!;
  await changeAttention(runtime, entry.id, 'acknowledged', 'person', 'Discussing priority');
  assert.equal((await listAttention(runtime)).find(candidate => candidate.id === entry.id)?.status, 'acknowledged');
  await changeAttention(runtime, entry.id, 'resolved', 'person', 'Deferred until next month');
  assert.equal((await listAttention(runtime)).find(candidate => candidate.id === entry.id)?.decision?.reason, 'Deferred until next month');
  await changeAttention(runtime, entry.id, 'open', 'person', 'Priority changed');
  assert.equal((await listAttention(runtime)).find(candidate => candidate.id === entry.id)?.status, 'open');
  await assert.rejects(requestWork(runtime, 'homelab', 'moneo', proposal), /owner_has_no_workflow/);
});

test('a completed recorded NAS job reconciles without an update; missing job evidence stays interrupted', async () => {
  const runtime = await setup();
  const request = await runtime.requests.open('moneo', 'moneo', {
    kind: 'update-app', app: 'wiki', fromVersion: '1', toVersion: '2', purpose: 'upgrade', notesRead: [],
  }, 'none');
  await runtime.requests.save({ ...request, status: 'create-approved', operation: {
    ...operation('create-approved'), checkpoint: { jobId: 42 },
  } });
  runtime.truenas = async (_domain, mutate, action) => {
    assert.equal(mutate, false);
    return action(async tool => tool === 'truenas_jobs_list'
      ? JSON.stringify([{ id: 42, state: 'SUCCESS', arguments: ['wiki'] }])
      : JSON.stringify([{ name: 'wiki', state: 'RUNNING', version: '2', image_updates_available: false }]));
  };
  await recoverRequests(runtime, (_context, error) => { throw error; });
  assert.equal((await runtime.requests.get(request.id)).status, 'updated');
  const unknown = await runtime.requests.open('moneo', 'moneo', request.ask, 'none');
  await runtime.requests.save({ ...unknown, status: 'create-approved', operation: operation('create-approved') });
  await recoverRequests(runtime, (_context, error) => { throw error; });
  assert.equal((await runtime.requests.get(unknown.id)).status, 'interrupted');
});

test('publication recovery verifies the recorded build digest and never republishes mismatched content', async () => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const runtime = await setup();
  const expected = '<html>deployed</html>';
  let served = expected;
  const server = createServer((_request, response) => response.end(served));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    runtime.truenasOwner('moneo').domain.sites[0]!.url = `http://127.0.0.1:${address.port}/`;
    const request = await runtime.requests.open('bellonda', 'moneo', { kind: 'publish-site', site: 'homelab-wiki', purpose: 'publish' }, 'none');
    const checkpoint = { publication: { commit: 'built-commit', previous: '/site.previous', digest: createHash('sha256').update(expected).digest('hex') } };
    await runtime.requests.save({ ...request, status: 'create-approved', operation: { ...operation('create-approved'), checkpoint } });
    await recoverRequests(runtime, (_context, error) => { throw error; });
    assert.equal((await runtime.requests.get(request.id)).published?.commit, 'built-commit');
    const unmatched = await runtime.requests.open('bellonda', 'moneo', request.ask, 'none');
    await runtime.requests.save({ ...unmatched, status: 'create-approved', operation: { ...operation('create-approved'), checkpoint } });
    served = 'old content';
    await recoverRequests(runtime, (_context, error) => { throw error; });
    assert.equal((await runtime.requests.get(unmatched.id)).status, 'interrupted');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('failed receiver work escalates both owners with the linked failure reason', async () => {
  const runtime = await setup();
  const request = await requestWork(runtime, 'homelab', 'clippy', proposal);
  const item = await runtime.ledger.create('clippy', 'change', proposal, { status: 'failed', reason: 'verification_failed' });
  await runtime.requests.save({ ...request, status: 'work-running', workItem: item.id });
  await processRequest(runtime, request.id);
  assert.equal((await runtime.requests.get(request.id)).status, 'failed');
  const attention = await listAttention(runtime);
  assert.equal(attention.length, 2);
  assert.ok(attention.every(entry => entry.note.includes(item.id) && entry.note.includes('verification_failed')));
});

test('finishing an owner decision preserves an approval recorded as its gate becomes visible', async () => {
  const { approveCreate } = await import('../src/brokering.ts');
  const runtime = await setup();
  runtime.incus = { run: async () => '[]' };
  runtime.hire = async (_owner, request) => ({
    value: request.schema.parse(decision), sessionID: 'scripted', cost: 0,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  });
  const opened = await runtime.requests.open('clippy', 'homelab', ask, 'none');
  const save = runtime.requests.save.bind(runtime.requests);
  runtime.requests.save = async request => {
    const saved = await save(request);
    if (saved.status === 'awaiting-create-approval') await approveCreate(runtime, request.id, 'person', false);
    return saved;
  };
  await processRequest(runtime, opened.id);
  const settled = await runtime.requests.get(opened.id);
  assert.equal(settled.status, 'provisioned');
  assert.equal(settled.approvals[0]?.by, 'person');
  assert.equal(settled.operation?.runner, undefined);
});
