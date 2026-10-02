import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Runtime, rememberSession, sessionHistory } from '@onionsoup/owners';
import { SurfaceState, type OpencodeApi, surfaceServer } from '@onionsoup/surface';
import { PLAN_WORKTREE_LIMITS, removeIdlePlanWorktrees } from '../../owners/src/plan-worktrees.ts';
import { readArchivedSessionMessages } from '../src/hire-store.ts';
import { rememberObservedSessions } from '../src/session-history.ts';
import type { AddressInfo } from 'node:net';

function fixtureApi(): OpencodeApi {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected_mutation'); };
  return {
    listSessions: async () => [], createSession: unexpected, renameSession: unexpected,
    messages: async () => { throw new Error('deleted_workspace_must_not_reach_transport'); }, prompt: unexpected,
    abort: unexpected, status: async () => ({}), health: async () => ({ ok: true }), permissions: async () => [],
    replyPermission: unexpected, questions: async () => [], replyQuestion: unexpected, rejectQuestion: unexpected,
    events: async () => undefined,
  };
}

const afterRetention = () => new Date(Date.now() + (PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours + 1) * 3_600_000);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'owner-history-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  const directory = join(root, 'removed-worktree');
  const item = await runtime.ledger.create('clippy', 'owner-change', {
    title: 'Finished fix', goal: 'Fix check', rationale: 'Regression', acceptance: ['Passes'], size: 'small',
  }, { status: 'cancelled', planWorktree: directory, session: { sessionID: 'ses_history', directory } });
  const database = join(root, 'opencode.db');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);');
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_history', directory);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_1', 'ses_history', 1, JSON.stringify({ role: 'assistant' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part_1', 'ses_history', 'msg_1', 1, JSON.stringify({ type: 'text', text: 'The reviewed outcome survives.' }));
  db.close();
  const chat = join(root, 'chat');
  await mkdir(chat);
  const makeState = (engine = runtime) => new SurfaceState(engine, fixtureApi(), async () => chat, undefined, () => [], () => [],
    (id, originalDirectory) => readArchivedSessionMessages(id, originalDirectory, database));
  return { runtime, item, directory, database, makeState };
}

test('cleanup and restart preserve discoverable scoped read-only history without the worktree', async () => {
  const { runtime, item, directory, makeState } = await fixture();
  await removeIdlePlanWorktrees(runtime, { activity: async () => { throw new Error('missing_workspace_must_not_reach_transport'); } },
    (_id, error) => { throw error; }, afterRetention());
  assert.equal((await runtime.ledger.get(item.id)).planWorktree, undefined);
  assert.equal((await sessionHistory(runtime, 'clippy'))[0].directory, directory);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  const state = makeState(reopened);
  const history = await state.chatSessions('clippy');
  assert.equal(history.sessions[0].id, 'ses_history');
  assert.equal(history.sessions[0].archived, true);
  await mkdir(directory); // Reusing the path cannot revive the archived execution context.
  assert.equal((await state.chatSessions('clippy')).sessions[0].archived, true);
  assert.match(JSON.stringify(await state.sessionMessages('clippy', 'ses_history')), /reviewed outcome survives/);
  assert.match(JSON.stringify(await state.itemSessionMessages(item.id, 'ses_history')), /reviewed outcome survives/);
  await assert.rejects(state.sessionDirectory('clippy', 'ses_history'), /session_workspace_unavailable/);
  await assert.rejects(state.sessionMessages('bellonda', 'ses_history'), /session_not_owned/);
  await assert.rejects(state.sessionMessages('clippy', 'ses_unrelated'), /session_not_owned/);
});

test('legacy explicit ledger reference remains readable without a history backfill', async () => {
  const { runtime, makeState } = await fixture();
  assert.deepEqual(await sessionHistory(runtime, 'clippy'), []);
  assert.match(JSON.stringify(await makeState().sessionMessages('clippy', 'ses_history')), /reviewed outcome survives/);
  assert.deepEqual(await sessionHistory(runtime, 'clippy'), [], 'reading the fallback performs no backfill');
});

test('archive store requires exact directory and returns an honest unavailable tombstone', async () => {
  const { database, directory } = await fixture();
  assert.throws(() => readArchivedSessionMessages('ses_history', '/another-owner', database), /history_directory_mismatch/);
  assert.throws(() => readArchivedSessionMessages('ses_missing', directory, database), /history_transcript_unavailable/);
});

test('session identity cannot be reassigned by another directory or owner', async () => {
  const { runtime, directory } = await fixture();
  const session = { id: 'ses_history', owner: 'clippy', directory, title: 'Finished', time: { created: 1, updated: 1 } };
  await rememberSession(runtime, session);
  await assert.rejects(rememberSession(runtime, { ...session, owner: 'bellonda' }), /session_history_identity_conflict/);
  await assert.rejects(rememberSession(runtime, { ...session, directory: '/other' }), /session_history_identity_conflict/);
});

test('HTTP archive reads succeed while prompt, rename, abort and auto-accept fail before transport', async () => {
  const { makeState } = await fixture();
  const { server } = surfaceServer(makeState(), { webRoot: '/nonexistent', by: 'tester', buildId: null });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const path = '/api/owners/clippy/sessions/ses_history';
    assert.equal((await fetch(`${base}${path}/messages`)).status, 200);
    for (const [method, suffix] of [['POST', '/prompt'], ['PATCH', ''], ['POST', '/abort'], ['PUT', '/auto-accept']]) {
      const response = await fetch(`${base}${path}${suffix}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Continue', title: 'Rename', enabled: true }) });
      assert.equal(response.status, 409);
      assert.match(await response.text(), /session_workspace_unavailable/);
    }
    assert.equal((await fetch(`${base}/api/owners/bellonda/sessions/ses_history/messages`)).status, 404);
  } finally { server.close(); }
});


test('corrupt unrelated history and conflicting discovery do not block valid sessions or grant ownership', async t => {
  const { runtime, directory, makeState } = await fixture();
  const record = { id: 'ses_history', owner: 'clippy', directory, title: 'Recorded title', time: { created: 1, updated: 2 } };
  await rememberSession(runtime, record);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...metadata: unknown[]) => { warnings.push(metadata); });
  const badID = 'ses_corrupt';
  const badPath = join(runtime.stateDirectory, 'session-history', `${createHash('sha256').update(badID).digest('hex')}.json`);
  await writeFile(badPath, '{secret_transcript_must_not_be_logged');
  await rememberObservedSessions(runtime, 'bellonda', '/wrong-owner', [
    { ...record, directory: '/wrong-owner' }, { invalid: 'secret_transcript_must_not_be_logged' },
    { id: 'ses_valid', title: 'Valid', time: { created: 1, updated: 1 } },
  ]);
  assert.deepEqual((await sessionHistory(runtime, 'bellonda')).map(session => session.id), ['ses_valid']);
  const state = makeState();
  assert.match(JSON.stringify(await state.sessionMessages('clippy', 'ses_history')), /reviewed outcome survives/);
  await assert.rejects(state.sessionMessages('bellonda', 'ses_history'), /session_not_owned/);
  await assert.rejects(state.sessionMessages('clippy', badID), /session_not_owned/);
  assert.doesNotMatch(JSON.stringify(warnings), /secret_transcript/);
});

test('cleanup preserves observed titles for both planning origin and execution session', async () => {
  const { runtime, item, directory } = await fixture();
  const origin = { sessionID: 'ses_planning', directory: '/fixture/desk' };
  await runtime.ledger.update(item.id, current => ({ ...current, origin }));
  for (const [id, place, title] of [['ses_history', directory, 'Execution notes'], ['ses_planning', origin.directory, 'Original discussion']]) {
    await rememberSession(runtime, { id, owner: 'clippy', directory: place, title, time: { created: 1, updated: 2 } });
  }
  await removeIdlePlanWorktrees(runtime, { activity: async () => { throw new Error('missing_workspace_must_not_reach_transport'); } },
    (_id, error) => { throw error; }, afterRetention());
  const indexed = await sessionHistory(runtime, 'clippy');
  assert.equal(indexed.find(session => session.id === 'ses_planning')?.title, 'Original discussion');
  assert.equal(indexed.find(session => session.id === 'ses_history')?.title, 'Execution notes');
});

test('missing and incompatible SQLite stores report unavailable without leaking storage errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-store-unavailable-'));
  assert.throws(() => readArchivedSessionMessages('ses_history', '/fixture', join(root, 'missing.db')), /^Error: history_transcript_unavailable$/);
  const incompatible = join(root, 'empty.db');
  new DatabaseSync(incompatible).close();
  assert.throws(() => readArchivedSessionMessages('ses_history', '/fixture', incompatible), /^Error: history_transcript_unavailable$/);
});

test('an unavailable whole index returns HTTP 503 before transcript or session transport effects', async () => {
  const { runtime, makeState } = await fixture();
  await writeFile(join(runtime.stateDirectory, 'session-history'), 'not a directory');
  const state = makeState();
  let transportCalls = 0;
  state.opencode.listSessions = async () => { transportCalls++; return []; };
  state.opencode.createSession = async () => { transportCalls++; return { id: 'ses_new' }; };
  state.opencode.prompt = async () => { transportCalls++; };
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', by: 'tester', buildId: null });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [method, path] of [
      ['GET', '/api/owners/clippy/sessions'], ['POST', '/api/owners/clippy/sessions'],
      ['GET', '/api/owners/clippy/sessions/ses_history/messages'],
      ['POST', '/api/owners/clippy/sessions/ses_history/prompt'],
    ]) {
      const response = await fetch(`${base}${path}`, { method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Continue' }) } : {}),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'session_history_unavailable' });
    }
    assert.equal(transportCalls, 0);
  } finally { server.close(); }
});

test('recorded chat views sort by most recently updated', async () => {
  const { runtime, directory, makeState } = await fixture();
  for (const [id, updated] of [['ses_old', 10], ['ses_new', 20]] as const) {
    await rememberSession(runtime, { id, owner: 'clippy', directory, title: id, time: { created: 1, updated } });
  }
  const sessions = (await makeState().chatSessions('clippy')).sessions.filter(session => ['ses_old', 'ses_new'].includes(session.id));
  assert.deepEqual(sessions.map(session => session.id), ['ses_new', 'ses_old']);
});
