import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime, rememberSession } from '@onionsoup/owners';
import { SurfaceState } from '../src/state.ts';
import type { OpencodeApi } from '../src/opencode.ts';

const proposal = { title: 'Scoped work', goal: 'Safe history', rationale: 'Regression', acceptance: ['No retired probes'], size: 'small' as const };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'surface-directory-seam-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  const chat = join(root, 'chat');
  await mkdir(chat);
  const probes: string[] = [];
  const mutation = async (): Promise<never> => { throw new Error('unexpected_mutation'); };
  const probe = async (directory: string) => { probes.push(directory); return []; };
  const api: OpencodeApi = {
    listSessions: probe, createSession: mutation, renameSession: mutation, messages: mutation,
    prompt: mutation, abort: mutation, status: async directory => { probes.push(directory); return {}; },
    health: async () => ({ ok: true }), permissions: probe, questions: probe,
    replyPermission: mutation, replyQuestion: mutation, rejectQuestion: mutation, events: async () => undefined,
  };
  const archivedReads: string[][] = [];
  const state = new SurfaceState(runtime, api, async () => chat, undefined, () => [], () => [],
    (id, directory) => { archivedReads.push([id, directory]); return [{ retained: id }]; });
  return { root, runtime, chat, probes, state, archivedReads };
}

test('terminal explicit execution history never probes or addresses the retired path even when it still exists', async () => {
  const { root, runtime, chat, probes, state, archivedReads } = await fixture();
  const retired = join(root, 'retired');
  await mkdir(retired);
  await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'cancelled', session: { sessionID: 'ses_terminal', directory: retired },
  });
  await rememberSession(runtime, {
    id: 'ses_terminal', owner: 'clippy', directory: retired, title: 'Original execution title', time: { created: 1, updated: 2 },
  });
  assert.deepEqual(await state.ownerDirectories('clippy'), [chat]);
  const chats = await state.chatSessions('clippy');
  assert.deepEqual(chats.directories, [chat]);
  assert.equal(chats.sessions[0]?.archived, true);
  assert.equal(chats.sessions[0]?.title, 'Original execution title');
  assert.deepEqual(await state.sessionMessages('clippy', 'ses_terminal'), [{ retained: 'ses_terminal' }]);
  await assert.rejects(state.sessionDirectory('clippy', 'ses_terminal'), /session_workspace_unavailable/);
  assert.deepEqual(archivedReads, [['ses_terminal', retired]]);
  assert.ok(probes.every(directory => directory === chat));
});

test('archived metadata never probes a reused directory still recorded on a terminal plan', async () => {
  const { root, runtime, chat, probes, state } = await fixture();
  const retired = join(root, 'reused');
  await mkdir(retired);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'landed', planWorktree: retired, session: { sessionID: 'ses_archived', directory: retired },
  });
  await rememberSession(runtime, {
    id: 'ses_archived', owner: 'clippy', directory: retired, archived: true, item: item.id,
    title: 'Archived execution', time: { created: 1, updated: 2 },
  });
  assert.deepEqual(await state.ownerDirectories('clippy'), [chat]);
  await state.chatSessions('clippy');
  assert.ok(probes.every(directory => directory === chat));
});

test('a retained terminal rollout is still observed until retirement, while a missing active directory is not initialized', async () => {
  const { root, runtime, chat, probes, state } = await fixture();
  const rollout = join(root, 'retained-rollout');
  await mkdir(rollout);
  await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'landed', planWorktree: rollout, session: { sessionID: 'ses_rollout', directory: rollout },
  });
  const missing = join(root, 'missing-active');
  await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', planWorktree: missing, session: { sessionID: 'ses_missing', directory: missing },
  });
  assert.deepEqual(await state.ownerDirectories('clippy'), [chat, rollout]);
  const chats = await state.chatSessions('clippy');
  assert.equal(chats.sessions.find(session => session.id === 'ses_missing')?.archived, true);
  assert.ok(probes.includes(rollout));
  assert.ok(!probes.includes(missing));
});
