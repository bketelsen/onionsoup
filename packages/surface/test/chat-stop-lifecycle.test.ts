import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Runtime, rememberSession } from '@onionsoup/owners';
import { SurfaceState } from '../src/state.ts';
import { surfaceServer } from '../src/server.ts';
import type { OpencodeApi } from '../src/opencode.ts';

const proposal = { title: 'Original work', goal: 'Preserve approved intent', rationale: 'Regression', acceptance: ['Exact stop scope'], size: 'small' as const };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chat-stop-lifecycle-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  await runtime.notebook('clippy').ensure('# Charter\n');
  const chat = join(root, 'chat');
  const execution = join(root, 'execution');
  await mkdir(chat);
  await mkdir(execution);
  const aborted: string[][] = [];
  const mutation = async (): Promise<never> => { throw new Error('unexpected_mutation'); };
  const api: OpencodeApi = {
    listSessions: async () => [], createSession: mutation, renameSession: mutation, messages: mutation, prompt: mutation,
    abort: async (directory, id) => { aborted.push([directory, id]); },
    status: async () => ({}), health: async () => ({ ok: true }), permissions: async () => [],
    replyPermission: mutation, questions: async () => [], replyQuestion: mutation, rejectQuestion: mutation,
    events: async () => undefined,
  };
  for (const [id, directory] of [['ses_discussion', chat], ['ses_execution', execution]]) {
    await rememberSession(runtime, { id, owner: 'clippy', directory, title: id, time: { created: 1, updated: 1 } });
  }
  const state = new SurfaceState(runtime, api, async () => chat);
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', by: 'person', buildId: null });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { runtime, chat, execution, aborted, server, base, api };
}

test('Stop on a shared planning discussion stays chat-only and cannot pause work executing elsewhere', async () => {
  const { runtime, chat, execution, aborted, server, base } = await fixture();
  try {
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'working', origin: { sessionID: 'ses_discussion', directory: chat },
      session: { sessionID: 'ses_execution', directory: execution },
    });
    const response = await fetch(`${base}/api/owners/clippy/sessions/ses_discussion/abort`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: 'aborted' });
    assert.deepEqual(aborted, [[chat, 'ses_discussion']]);
    const current = await runtime.ledger.get(item.id);
    assert.equal(current.status, 'working');
    assert.deepEqual(current.pauses, []);
    assert.deepEqual(current.session, item.session);
  } finally {
    server.close();
  }
});

test('human execution Stop records pausing but never erases a busy host runner or fabricates stopped proof', async () => {
  const { runtime, execution, aborted, server, base } = await fixture();
  try {
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'working', activeRunner: process.pid, session: { sessionID: 'ses_execution', directory: execution },
    });
    const response = await fetch(`${base}/api/owners/clippy/sessions/ses_execution/abort`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'model-claimed-person', reason: 'fabricated stopped proof' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: 'pausing' });
    const current = await runtime.ledger.get(item.id);
    assert.equal(current.status, 'pausing');
    assert.equal(current.activeRunner, process.pid);
    assert.equal(current.pauses[0]?.authority, 'human');
    assert.equal(current.pauses[0]?.stoppedAt, undefined);
    assert.doesNotMatch(current.pauses[0]!.by, /model-claimed/);
    assert.deepEqual(aborted, []);
  } finally {
    server.close();
  }
});

test('a by-name foreign execution Stop fails owner membership before SDK abort or pause writes', async () => {
  const { runtime, execution, aborted, server, base } = await fixture();
  try {
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'working', session: { sessionID: 'ses_execution', directory: execution },
    });
    const response = await fetch(`${base}/api/owners/homelab/sessions/ses_execution/abort`, { method: 'POST' });
    assert.equal(response.status, 404);
    assert.equal((await runtime.ledger.get(item.id)).status, 'working');
    assert.deepEqual(aborted, []);
  } finally {
    server.close();
  }
});

test('explicit item Pause preserves intent but never probes an archived execution directory reused by another context', async () => {
  const { runtime, execution, aborted, server, base, api } = await fixture();
  try {
    await rememberSession(runtime, {
      id: 'ses_execution', owner: 'clippy', directory: execution, title: 'Retired execution',
      archived: true, time: { created: 1, updated: 1 },
    });
    api.listSessions = async () => { throw new Error('retired_directory_probed'); };
    api.status = async () => { throw new Error('retired_directory_probed'); };
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'working', session: { sessionID: 'ses_execution', directory: execution },
    });
    const response = await fetch(`${base}/api/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause-item', id: item.id, reason: 'Pause the exact original work' }),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /session_workspace_unavailable/);
    const current = await runtime.ledger.get(item.id);
    assert.equal(current.status, 'pausing');
    assert.equal(current.pauses[0]?.stoppedAt, undefined);
    assert.deepEqual(aborted, []);
  } finally {
    server.close();
  }
});
