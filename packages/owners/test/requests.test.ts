import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { processRequest, processRequests } from '../src/brokering.ts';
import { recoverRequests, reconcileRequest, recoverRequest } from '../src/request-recovery.ts';
import { requestParticipants, requestWork } from '../src/delegation.ts';
import { noticeWorkChanges, pendingNotices } from '../src/notices.ts';
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

async function journalOf(runtime: Runtime, ownerId: string) {
  const { readdir, readFile } = await import('node:fs/promises');
  const directory = join(runtime.notebook(ownerId).directory, 'journal');
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line) as { kind: string; note?: string; outcome?: string; workItem?: string });
}

function forbidHires(runtime: Runtime) {
  runtime.hire = async () => { throw new Error('no_hire_permitted'); };
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
  assert.equal((await runtime.requests.get(broken.id)).status, 'pending-owner');
  assert.equal((await runtime.requests.get(broken.id)).retry?.attempts, 1);
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
      ? JSON.stringify([{ id: 42, state: 'SUCCESS', method: 'app.upgrade', arguments: ['wiki'] }])
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
    const checkpoint = { publication: { commit: 'built-commit', previous: '/site.previous', digest: createHash('sha256').update(expected).digest('hex'), verifiedAt: new Date().toISOString() } };
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

test('failed NAS job retry starts a new job; successful retry persists the new checkpoint', async () => {
  const { APP_UPDATE_LIMITS } = await import('../src/app-updates.ts');
  const runtime = await setup();
  const request = await runtime.requests.open('moneo', 'moneo', {
    kind: 'update-app', app: 'wiki', fromVersion: '1', toVersion: '1', imageUpdates: true, purpose: 'pull', notesRead: [],
  }, 'none');
  await runtime.requests.save({ ...request, status: 'create-approved' });
  let starts = 0;
  runtime.truenasSsh = async () => JSON.stringify(40 + ++starts);
  runtime.truenas = async (_domain, _mutate, action) => action(async tool => JSON.stringify(tool === 'truenas_jobs_list'
    ? Array.from({ length: starts }, (_entry, index) => ({
      id: 41 + index, method: 'app.pull_images', arguments: ['wiki'], state: index === 0 ? 'FAILED' : 'SUCCESS',
    }))
    : [{ name: 'wiki', state: 'RUNNING', version: '1', image_updates_available: starts < 2 }]));
  const previous = APP_UPDATE_LIMITS.pollMs;
  APP_UPDATE_LIMITS.pollMs = 1;
  try {
    await processRequest(runtime, request.id);
    assert.equal((await runtime.requests.get(request.id)).status, 'interrupted');
    assert.equal((await runtime.requests.get(request.id)).operation?.checkpoint?.jobId, 41);
    await recoverRequest(runtime, request.id, 'retry', 'person', 'Fixed NAS image access');
    await processRequest(runtime, request.id);
    const completed = await runtime.requests.get(request.id);
    assert.equal(completed.status, 'updated');
    assert.equal(completed.operation?.checkpoint?.jobId, 42);
    assert.equal(starts, 2);
  } finally {
    APP_UPDATE_LIMITS.pollMs = previous;
  }
});

test('effect-free failures back off, stop at a configured attempt limit, and do not require inspecting effects', async () => {
  const { REQUEST_LIMITS } = await import('../src/requests.ts');
  const runtime = await setup();
  runtime.incus = { run: async () => '[]' };
  let attempts = 0;
  runtime.hire = async () => {
    attempts++;
    throw new Error('provider_unavailable');
  };
  const request = await runtime.requests.open('clippy', 'homelab', ask, 'none');
  await processRequest(runtime, request.id);
  const delayed = await runtime.requests.get(request.id);
  assert.equal(delayed.status, 'pending-owner');
  assert.ok(Date.parse(delayed.retry!.nextAt) > Date.now());
  await processRequest(runtime, request.id);
  assert.equal(attempts, 1, 'backoff suppresses immediate retries');
  const previous = REQUEST_LIMITS.retryBaseMs;
  REQUEST_LIMITS.retryBaseMs = 0;
  try {
    await runtime.requests.update(request.id, current => ({ ...current, retry: { attempts: 1, nextAt: new Date(0).toISOString() } }));
    for (let attempt = 1; attempt < REQUEST_LIMITS.decisionAttempts; attempt++) await processRequest(runtime, request.id);
    assert.equal((await runtime.requests.get(request.id)).status, 'interrupted');
    await recoverRequests(runtime, (_context, error) => { throw error; });
    assert.equal((await runtime.requests.get(request.id)).status, 'interrupted', 'exhausted attempts stay for a person');
    assert.equal(attempts, REQUEST_LIMITS.decisionAttempts);
  } finally {
    REQUEST_LIMITS.retryBaseMs = previous;
  }
});

test('periodic recovery notices dead runners but preserves a live CLI claim', async () => {
  const runtime = await setup();
  const dead = await approved(runtime, 'dead');
  const live = await approved(runtime, 'live');
  await runtime.requests.save({ ...dead, operation: operation('create-approved') });
  await runtime.requests.save({ ...live, operation: { ...operation('create-approved'), id: 'live-operation', runner: process.pid } });
  const log: TickLog = { duty: () => {}, item: () => {}, request: () => {}, error: (_context, error) => { throw error; } };
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.requests.get(dead.id)).status, 'interrupted');
  assert.equal((await runtime.requests.get(live.id)).operation?.runner, process.pid);
  await processRequest(runtime, live.id);
  assert.equal((await runtime.requests.get(live.id)).operation?.id, 'live-operation');
});

test('a failed request claim does not prevent the next CLI request from progressing', async () => {
  const runtime = await setup();
  const first = await approved(runtime, 'bad');
  const next = await approved(runtime, 'good');
  runtime.incus = { run: async () => '[]' };
  const update = runtime.requests.update.bind(runtime.requests);
  runtime.requests.update = async (id, change) => {
    if (id === first.id) throw new Error('record_unavailable');
    return update(id, change);
  };
  const errors: string[] = [];
  await processRequests(runtime, () => {}, id => errors.push(id));
  assert.deepEqual(errors, [first.id]);
  assert.equal((await runtime.requests.get(next.id)).status, 'provisioned');
});

test('instance retry reconciles its tag before launching; cancelling retains a reachable cleanup gate', async () => {
  const runtime = await setup();
  const request = await approved(runtime);
  await runtime.requests.save({ ...request, status: 'interrupted', operation: {
    ...operation('create-approved'), runner: undefined,
    checkpoint: { instance: { remote: 'minideb', name: 'onionsoup-test', image: ask.image } },
  } });
  runtime.incus = { run: async args => {
    assert.equal(args[0], 'list');
    return JSON.stringify([{ name: 'onionsoup-test', type: 'container', status: 'Running', config: { 'user.onionsoup.request': request.id } }]);
  } };
  const recovered = await recoverRequest(runtime, request.id, 'retry', 'person', 'Connection recovered');
  assert.equal(recovered.status, 'provisioned');
  assert.equal(recovered.instance?.name, 'onionsoup-test');
  for (const stage of ['provisioned', 'delete-approved'] as const) {
    await runtime.requests.save({ ...recovered, status: 'interrupted', operation: { ...operation(stage), runner: undefined } });
    const stopped = await recoverRequest(runtime, request.id, 'cancel', 'person', 'Stop the workload');
    assert.equal(stopped.status, 'awaiting-delete-approval');
    assert.equal(stopped.instance?.name, 'onionsoup-test');
  }
});

test('matching index content alone cannot prove an interrupted publication completed', async () => {
  const runtime = await setup();
  const request = await runtime.requests.open('bellonda', 'moneo', { kind: 'publish-site', site: 'homelab-wiki', purpose: 'publish' }, 'none');
  await runtime.requests.save({ ...request, status: 'interrupted', operation: {
    ...operation('create-approved'), runner: undefined,
    checkpoint: { publication: { commit: 'built', previous: '/not-created-yet', digest: 'same-index-as-live' } },
  } });
  assert.equal((await reconcileRequest(runtime, request.id)).status, 'interrupted');
  assert.equal((await runtime.requests.get(request.id)).published, undefined);
});

test('attention ingests appended records incrementally, skips malformed lines, and limits historical import', async context => {
  const { appendFile, readFile, stat } = await import('node:fs/promises');
  const { deskState } = await import('../src/desk.ts');
  const runtime = await setup();
  const journal = join(runtime.notebook('clippy').directory, 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const old = { at: new Date(Date.now() - 30 * 86_400_000).toISOString(), kind: 'attention', note: 'Historical item' };
  const recent = { at: new Date().toISOString(), kind: 'attention', note: 'Current item' };
  const completed = JSON.stringify({ ...recent, note: 'Completed trailing record' });
  const warnings = context.mock.method(console, 'warn', () => {});
  await appendFile(journal, `${JSON.stringify(old)}\nmalformed\n${JSON.stringify(recent)}\n${completed.slice(0, -2)}`);
  assert.equal((await listAttention(runtime)).length, 1);
  assert.equal(warnings.mock.callCount(), 1);
  const indexPath = join(runtime.stateDirectory, 'attention', 'index.json');
  const first = await stat(indexPath);
  assert.equal((await listAttention(runtime)).length, 1);
  assert.equal((await stat(indexPath)).mtimeMs, first.mtimeMs, 'unchanged journal does not rewrite its index');
  assert.equal(warnings.mock.callCount(), 1, 'malformed complete line is not reparsed');
  assert.equal((await deskState(runtime, { owner: 'clippy' })).notes?.some(note => note.note === recent.note), true);
  await appendFile(journal, completed.slice(-2) + '\n');
  const entries = await listAttention(runtime);
  assert.equal(entries.length, 2);
  const cursorIndex = JSON.parse(await readFile(indexPath, 'utf8')) as { cursors: Record<string, { offset: number }> };
  assert.equal(cursorIndex.cursors[`clippy/${new Date().toISOString().slice(0, 10)}.jsonl`]?.offset, (await stat(journal)).size);
  await changeAttention(runtime, entries[0]!.id, 'resolved', 'person', 'Handled');
  const reopenedRuntime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  assert.equal((await listAttention(reopenedRuntime)).find(entry => entry.id === entries[0]!.id)?.status, 'resolved');
});

test('ambiguous reconciliation backs off so an older request cannot starve a newer same-owner request', async () => {
  const runtime = await setup();
  const older = await approved(runtime, 'old');
  await runtime.requests.save({ ...older, createdAt: '2020-01-01T00:00:00.000Z', status: 'interrupted',
    operation: { ...operation('create-approved'), runner: undefined },
  });
  const newer = await approved(runtime, 'new');
  runtime.incus = { run: async () => '[]' };
  const log: TickLog = { duty: () => {}, item: () => {}, request: () => {}, error: (_context, error) => { throw error; } };
  await tick(runtime, log);
  await drain();
  assert.ok((await runtime.requests.get(older.id)).reconcileAfter);
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.requests.get(newer.id)).status, 'provisioned');
});

test('dead runner cleanup preserves a gate or result that the completed step already saved', async () => {
  const runtime = await setup();
  const gated = await runtime.requests.open('clippy', 'homelab', ask, 'none');
  await runtime.requests.save({ ...gated, status: 'awaiting-create-approval', decision,
    operation: operation('pending-owner'),
  });
  const provisioned = await approved(runtime, 'persisted');
  await runtime.requests.save({ ...provisioned, status: 'provisioned',
    instance: { remote: 'minideb', name: 'onionsoup-persisted' }, operation: operation('create-approved'),
  });
  await runtime.requests.markInterrupted();
  const waiting = await runtime.requests.get(gated.id);
  const finished = await runtime.requests.get(provisioned.id);
  assert.equal(waiting.status, 'awaiting-create-approval');
  assert.equal(waiting.operation?.runner, undefined);
  assert.deepEqual(waiting.decision, decision);
  assert.equal(finished.status, 'provisioned');
  assert.equal(finished.instance?.name, 'onionsoup-persisted');
  assert.equal(finished.operation?.runner, undefined);
});

test('attention discovers late same-day appends on the first scan after UTC rollover', async context => {
  const runtime = await setup();
  const morning = Date.parse('2026-09-24T10:00:00.000Z');
  context.mock.timers.enable({ apis: ['Date'], now: morning });
  const notebook = runtime.notebook('clippy');
  await notebook.journal({ kind: 'attention', note: 'Morning attention' });
  assert.equal((await listAttention(runtime)).length, 1);
  context.mock.timers.setTime(morning + 5 * 60 * 60_000);
  await notebook.journal({ kind: 'attention', note: 'Late attention without another scan today' });
  context.mock.timers.setTime(morning + 24 * 60 * 60_000);
  assert.deepEqual((await listAttention(runtime)).map(entry => entry.note), ['Morning attention', 'Late attention without another scan today']);
  assert.equal((await listAttention(runtime)).length, 2);
});

test('a journal failure after a persisted owner decision does not reopen that decision', async () => {
  const runtime = await setup();
  let hires = 0;
  runtime.hire = async (_owner, request) => {
    hires++;
    return { value: request.schema.parse({ decision: 'decline', reply: 'Outside current priorities' }),
      sessionID: 'scripted', cost: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  };
  const request = await requestWork(runtime, 'homelab', 'clippy', proposal);
  const notebookFor = runtime.notebook.bind(runtime);
  runtime.notebook = owner => {
    const notebook = notebookFor(owner);
    const journal = notebook.journal.bind(notebook);
    notebook.journal = async entry => {
      if (entry.kind === 'attention') throw new Error('journal_disk_unavailable');
      return journal(entry);
    };
    return notebook;
  };
  await processRequest(runtime, request.id);
  const declined = await runtime.requests.get(request.id);
  assert.equal(declined.status, 'declined');
  assert.equal(declined.reason, 'Outside current priorities');
  assert.equal(declined.retry, undefined);
  assert.equal(declined.operation?.runner, undefined);
  await processRequest(runtime, request.id);
  assert.equal(hires, 1);
});

test('work from a declared manager is accepted without a hire, carries its assignment, and reserves only the report', async () => {
  const runtime = await setup();
  forbidHires(runtime);
  const assignment = { initiative: 'i-20260924-abcdef', assignment: 'a1' };
  const request = await requestWork(runtime, 'odrade', 'clippy', proposal, assignment);
  assert.deepEqual([...requestParticipants(runtime, request)], ['clippy']);
  const peer = await requestWork(runtime, 'homelab', 'clippy', proposal);
  assert.deepEqual([...requestParticipants(runtime, peer)].sort(), ['clippy', 'homelab']);
  await processRequest(runtime, request.id);
  const accepted = await runtime.requests.get(request.id);
  assert.equal(accepted.status, 'work-running');
  assert.match(accepted.publishDecision!.reply, /odrade, clippy's manager; accepted automatically/);
  const item = await runtime.ledger.get(accepted.workItem!);
  assert.deepEqual(item.assignment, assignment);
  assert.equal(item.status, 'proposed');
  for (const owner of ['odrade', 'clippy']) {
    assert.ok((await journalOf(runtime, owner)).some(entry => entry.kind === 'request-accepted' && entry.note?.includes('accepted automatically')));
  }
  await processRequest(runtime, peer.id);
  assert.equal((await runtime.requests.get(peer.id)).status, 'pending-owner', 'a peer request still needs the receiver to decide');
});

test('a manager hears how assigned work went in the chat its initiative was drafted in', async () => {
  const runtime = await setup();
  forbidHires(runtime);
  const origin = { sessionID: 'ses_odrade', directory: '/evidence/odrade' };
  const initiative = await runtime.initiatives.open('odrade', { title: 'Org change', goal: 'g', rationale: 'r', assignments: [] }, origin);
  const item = await runtime.ledger.create('clippy', 'change', proposal, { assignment: { initiative: initiative.id, assignment: 'a1' } });
  const chatDirectory = async (ownerId: string) => `/desks/${ownerId}`;
  assert.deepEqual(await noticeWorkChanges(runtime, chatDirectory), []);
  await runtime.ledger.save({ ...item, status: 'failed', reason: 'verification_failed' });
  const raised = await noticeWorkChanges(runtime, chatDirectory);
  assert.deepEqual(raised.map(notice => notice.owner).sort(), ['clippy', 'odrade']);
  const pending = await pendingNotices(runtime);
  assert.equal(pending.length, 1, 'the report has no chat for this work; only the manager is woken');
  assert.equal(pending[0]?.id, `${item.id}-failed-manager`);
  assert.deepEqual(pending[0]?.origin, origin);
  assert.ok(pending[0]!.text.includes(`clippy's work ${item.id} "Repair domain" (assignment a1 of initiative ${initiative.id}) failed: verification_failed`));
  assert.ok((await journalOf(runtime, 'odrade')).some(entry => entry.kind === 'work-status' && entry.workItem === item.id && entry.outcome === 'failed'));
});
