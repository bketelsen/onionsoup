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
  const api: OpencodeApi = {
    listSessions: async directory => [{ id: 'ses_1', title: 'hello', directory }],
    createSession: async (directory, title, agent) => { calls.push(['create', directory, title, agent]); return { id: 'ses_2', title }; },
    renameSession: async (_directory, sessionID, title) => ({ id: sessionID, title }),
    messages: async () => [{ info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }],
    prompt: async (directory, sessionID, agent, text) => { calls.push(['prompt', directory, sessionID, agent, text]); },
    abort: async () => {},
    status: async () => ({}),
    permissions: async directory => directory.endsWith('bellonda') ? [{ id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['docs/x.md'], metadata: {}, always: [] }] : [],
    replyPermission: async (directory, requestID, reply) => { calls.push(['permission', directory, requestID, reply]); },
    questions: async () => [],
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    events: async () => {},
  };
  return { api, calls };
}

async function start() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'surface-')) });
  const { api, calls } = fakeOpencode();
  const state = new SurfaceState(runtime, api, async (_runtime, ownerId) => `/desks/${ownerId}`);
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
    assert.deepEqual(inbox.map(entry => [entry.kind, entry.owner]).sort(), [['permission', 'bellonda'], ['plan', 'clippy']]);
    const owners = body.owners as { id: string; chat: boolean; waiting: number }[];
    assert.equal(owners.find(owner => owner.id === 'clippy')?.chat, false);
    assert.equal(owners.find(owner => owner.id === 'bellonda')?.waiting, 1);
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
