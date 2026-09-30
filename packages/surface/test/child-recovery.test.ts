import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Runtime, rememberSession } from '@onionsoup/owners';
import { childRecoverySnapshot, recordChildAbandonment } from '../../owners/src/child-recovery.ts';
import { SurfaceState, surfaceServer, type OpencodeApi } from '@onionsoup/surface';

function noTransport(): OpencodeApi {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected_transport'); };
  return { listSessions: unexpected, createSession: unexpected, renameSession: unexpected, messages: unexpected,
    prompt: unexpected, abort: unexpected, status: unexpected, health: unexpected, permissions: unexpected,
    replyPermission: unexpected, questions: unexpected, replyQuestion: unexpected, rejectQuestion: unexpected,
    events: async () => undefined };
}

async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'surface-child-recovery-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  const identity = { childID: 'ses_child', parentID: 'ses_parent', directory: join(root, 'removed-workspace') };
  for (const id of ['ses_parent', 'ses_other']) await rememberSession(runtime,
    { id, owner: 'clippy', directory: identity.directory, title: id, time: { created: 1, updated: 1 } });
  const database = join(root, 'opencode.db');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(identity.childID, identity.parentID, identity.directory, 1);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_user', identity.childID, 1,
    JSON.stringify({ role: 'user', format: { type: 'json_schema', schema: {} } }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part_text', identity.childID, 'msg_user', 1,
    JSON.stringify({ type: 'text', text: 'Preserved unfinished investigation.' }));
  db.close();
  const { digest } = childRecoverySnapshot(identity, database);
  await recordChildAbandonment(runtime.stateDirectory, { ...identity, version: 1, state: 'abandoned', digest,
    recordedBy: 'fixture-operator', approvedBy: 'Brian', approvedAt: '2026-09-30T00:00:00.000Z', reason: 'Explicit narrow recovery' }, database);
  return { root, database, identity, runtime };
}

test('surface reads exact approved child history without transport; changed evidence stays unavailable', async () => {
  const fixture = await recoveryFixture();
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = fixture.database;
  const original = await readFile(fixture.database);
  const state = new SurfaceState(fixture.runtime, noTransport(), async () => { throw new Error('unexpected_workspace'); });
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', by: 'tester', buildId: null });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/owners`;
  const path = `${base}/clippy/sessions/ses_parent/abandoned-children`;
  try {
    const response = await fetch(path);
    assert.equal(response.status, 200);
    const notices = await response.json() as Record<string, unknown>[];
    assert.equal(notices.length, 1);
    assert.equal(notices[0].state, 'abandoned');
    assert.equal(notices[0].approvedBy, 'Brian');
    assert.equal(notices[0].directory, undefined);
    const transcript = await fetch(`${path}/ses_child/messages`);
    assert.equal(transcript.status, 200);
    const text = await transcript.text();
    assert.match(text, /Preserved unfinished investigation/);
    assert.doesNotMatch(text, /json_schema/);
    assert.equal((await fetch(`${base}/bellonda/sessions/ses_parent/abandoned-children`)).status, 404);
    assert.equal((await fetch(`${base}/clippy/sessions/ses_other/abandoned-children/ses_child/messages`)).status, 404);
    assert.equal((await fetch(`${path}/ses_missing/messages`)).status, 404);
    assert.deepEqual(await readFile(fixture.database), original, 'reads never rewrite stored format or messages');
    const db = new DatabaseSync(fixture.database);
    db.prepare('UPDATE session SET time_updated = 2 WHERE id = ?').run('ses_child');
    db.close();
    assert.equal((await fetch(path)).status, 200, 'approval remains discoverable as historical evidence');
    assert.equal((await fetch(`${path}/ses_child/messages`)).status, 404, 'changed snapshot is never presented as recovered');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous;
    await rm(fixture.root, { recursive: true, force: true });
  }
});
