import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '@onionsoup/owners';
import { SurfaceState, surfaceServer, type OpencodeApi } from '@onionsoup/surface';

function fakeOpencode() {
  const calls: unknown[][] = [];
  const answeredPermissions = new Set<string>();
  const api: OpencodeApi = {
    listSessions: async directory => directory.includes('worktrees')
      ? [{ id: 'ses_impl', title: 'w-1: implement 1', directory, time: { created: 2, updated: 3 } }, { id: 'ses_x', title: 'w-2: plan', directory, time: { created: 1, updated: 1 } }]
      : [{ id: 'ses_1', title: 'hello', directory, time: { created: 0, updated: 0 } }, { id: 'ses_plan', title: 'w-1: plan', directory, time: { created: 1, updated: 1 } }],
    createSession: async (directory, title, agent) => { calls.push(['create', directory, title, agent]); return { id: 'ses_2', title }; },
    renameSession: async (_directory, sessionID, title) => ({ id: sessionID, title }),
    messages: async () => [{ info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }],
    prompt: async (directory, sessionID, agent, text) => { calls.push(['prompt', directory, sessionID, agent, text]); },
    abort: async () => {},
    status: async () => ({}),
    health: async () => ({ ok: true }),
    permissions: async directory => directory.endsWith('bellonda') ? [
      { id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['docs/x.md'], metadata: {}, always: [] },
      { id: 'per_2', sessionID: 'ses_other', permission: 'bash', patterns: ['rm -rf x'], metadata: {}, always: [] },
    ].filter(entry => !answeredPermissions.has(entry.id)) : [],
    replyPermission: async (directory, requestID, reply) => { calls.push(['permission', directory, requestID, reply]); answeredPermissions.add(requestID); },
    questions: async () => [],
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    events: async () => {},
  };
  return { api, calls };
}

test('the surface queues notebook maintenance alongside a running daemon and exposes failures', async () => {
  const { server, runtime, call } = await start();
  const { distill, memoryStatus } = await import('@onionsoup/owners');
  const unlock = await runtime.lock();
  try {
    await runtime.notebook('clippy').ensure('# Charter\nTest owner\n');
    await runtime.notebook('clippy').journal({ kind: 'chat-decision', note: 'remember this' });
    const queued = await call('POST', '/api/owners/clippy/memory', {});
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queued, true);
    assert.equal((await memoryStatus(runtime, 'clippy')).queued, true);
    runtime.hire = async () => { throw new Error('provider_unavailable'); };
    await assert.rejects(distill(runtime, 'clippy'), /provider_unavailable/);
    const status = await call('GET', '/api/owners/clippy/memory');
    assert.equal(status.body.status, 'failed');
    assert.match(String(status.body.error), /provider_unavailable/);
    assert.equal(status.body.queued, true);
    assert.equal((await call('GET', '/api/owners/nobody/memory')).status, 404);
    assert.equal((await call('POST', '/api/owners/nobody/memory', {})).status, 404);
  } finally {
    await unlock();
    server.close();
  }
});

async function start() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'surface-')) });
  const { api, calls } = fakeOpencode();
  const hireSessions = (prefix: string) => [
    { id: 'ses_plan', title: 'w-1: plan', directory: '/checkouts/clippy', time: { created: 1, updated: 1 } },
    { id: 'ses_impl', title: 'w-1: implement 1', directory: '/worktrees/clippy/w-1', time: { created: 2, updated: 3 } },
    { id: 'ses_x', title: 'w-2: plan', directory: '/checkouts/clippy', time: { created: 1, updated: 1 } },
  ].filter(session => session.title.startsWith(prefix));
  const state = new SurfaceState(runtime, api, async (_runtime, ownerId) => `/desks/${ownerId}`, undefined, sessionID => [{ info: { id: 'msg_1', sessionID, role: 'assistant' }, parts: [] }], hireSessions);
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', by: 'tester' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { runtime, server, call, calls };
}

test('the surface lists owners with what waits on the person, and chat permissions land in the inbox', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.ledger.create('clippy', 'change', { title: 'Fix it', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' }, { status: 'awaiting-plan-approval' });
    const { status, body } = await call('GET', '/api/state');
    assert.equal(status, 200);
    const inbox = body.inbox as { kind: string; owner: string; title: string }[];
    assert.deepEqual(inbox.map(entry => [entry.kind, entry.owner]).sort(), [['permission', 'bellonda'], ['permission', 'bellonda'], ['plan', 'clippy']]);
    const owners = body.owners as { id: string; chat: boolean; waiting: number }[];
    assert.equal(owners.find(owner => owner.id === 'clippy')?.chat, false);
    assert.equal(owners.find(owner => owner.id === 'bellonda')?.waiting, 2);
  } finally {
    server.close();
  }
});

test('chats go to the owner\'s directory with its persona as the agent; bad input is refused', async () => {
  const { server, call, calls } = await start();
  try {
    assert.equal((await call('POST', '/api/owners/bellonda/sessions/ses_1/prompt', { text: 'publish the wiki' })).status, 200);
    assert.deepEqual(calls.at(-1), ['prompt', '/desks/bellonda', 'ses_1', 'Bellonda', 'publish the wiki']);
    assert.equal((await call('POST', '/api/owners/bellonda/permissions/per_1', { reply: 'once' })).status, 200);
    assert.deepEqual(calls.at(-1), ['permission', '/desks/bellonda', 'per_1', 'once']);
    assert.equal((await call('POST', '/api/owners/bellonda/permissions/per_1', { reply: 'sure' })).status, 400);
    assert.match(String((await call('POST', '/api/owners/clippy/sessions', {})).body.error), /no_chat: clippy/);
    assert.equal((await call('GET', '/api/owners/nobody/sessions')).status, 404);
    assert.match(String((await call('POST', '/api/decide', { action: 'launch', id: 'x' })).body.error), /unknown_decision|not found|ENOENT/);
  } finally {
    server.close();
  }
});

test('the person\'s owner order is kept by the server and new owners follow it', async () => {
  const { ordered } = await import('@onionsoup/surface');
  assert.deepEqual(ordered([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], ['c', 'a']).map(owner => owner.id), ['c', 'a', 'b', 'd']);
  const { server, call } = await start();
  try {
    assert.equal((await call('PUT', '/api/settings/owner-order', { order: 'moneo' })).status, 400);
    assert.equal((await call('PUT', '/api/settings/owner-order', { order: ['moneo', 'bellonda'] })).status, 200);
    const owners = (await call('GET', '/api/state')).body.owners as { id: string }[];
    assert.deepEqual(owners.slice(0, 2).map(owner => owner.id), ['moneo', 'bellonda']);
  } finally {
    server.close();
  }
});

test('a chat can be renamed through the surface', async () => {
  const { server, call } = await start();
  try {
    const renamed = await call('PATCH', '/api/owners/bellonda/sessions/ses_1', { title: 'Wiki publishing' });
    assert.deepEqual(renamed.body, { id: 'ses_1', title: 'Wiki publishing' });
    assert.equal((await call('PATCH', '/api/owners/bellonda/sessions/ses_1', { title: '  ' })).status, 400);
  } finally {
    server.close();
  }
});

test('auto-accept answers the prompts of that chat and no other, including ones already waiting', async () => {
  const { server, call, calls } = await start();
  try {
    assert.equal((await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: 'yes' })).status, 400);
    const enabled = await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: true });
    assert.deepEqual(enabled.body, { enabled: true, answered: 1 });
    assert.deepEqual(calls.filter(entry => entry[0] === 'permission'), [['permission', '/desks/bellonda', 'per_1', 'once']]);
    assert.deepEqual((await call('GET', '/api/owners/bellonda/sessions')).body.autoAccept, { ses_1: true });
    await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: false });
    assert.deepEqual((await call('GET', '/api/owners/bellonda/sessions')).body.autoAccept, {});
  } finally {
    server.close();
  }
});

test('a work item\'s hires are found by title in opencode\'s store, and read from it', async () => {
  const { runtime, server, call } = await start();
  try {
    const item = await runtime.ledger.create('clippy', 'change', { title: 'Fix it', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' });
    await runtime.ledger.save({ ...item, id: 'w-1' });
    const sessions = (await call('GET', '/api/items/w-1/sessions')).body as unknown as { id: string; title: string }[];
    assert.deepEqual(sessions.map(session => session.title), ['w-1: plan', 'w-1: implement 1']);
    const messages = (await call('GET', '/api/items/w-1/sessions/ses_impl/messages')).body as unknown as { info: { sessionID: string } }[];
    assert.equal(messages[0]?.info.sessionID, 'ses_impl');
    assert.equal((await call('GET', '/api/items/w-1/sessions/ses_x/messages')).status, 404, 'another item\'s session is not served');
  } finally {
    server.close();
  }
});

test('person recovery decisions resume the exact stage, retry failures and cancel a pending push', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.notebook('clippy').ensure('# Charter\n');
    const proposal = { title: 'Recover', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const item = await runtime.ledger.create('clippy', 'change', proposal, { status: 'interrupted', resumeStatus: 'reviewing' });
    assert.equal((await call('POST', '/api/decide', { action: 'resume-item', id: item.id })).status, 200);
    assert.equal((await runtime.ledger.get(item.id)).status, 'reviewing');
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'failed', resumeStatus: 'landing' }));
    assert.equal((await call('POST', '/api/decide', { action: 'retry-item', id: item.id })).status, 200);
    assert.equal((await runtime.ledger.get(item.id)).status, 'landing');
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'awaiting-push-approval' }));
    assert.equal((await call('POST', '/api/decide', { action: 'cancel-item', id: item.id, reason: 'Keep the existing head' })).status, 200);
    const cancelled = await runtime.ledger.get(item.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.humanNotes.at(-1)?.by, 'tester');
    assert.equal(cancelled.reason, 'Keep the existing head');
  } finally {
    server.close();
  }
});
