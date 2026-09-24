import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FrictionDetail } from '../web/src/components/FrictionView.tsx';
import type { FrictionRecord } from '../web/src/types.ts';
import { applyChatEvent, orderedMessages, type Messages } from '../web/src/chat/chatState.ts';
import { addedFile, languageOf, parseUnifiedDiff } from '../web/src/chat/diff.ts';
import type { Message, Part } from '../web/src/types.ts';

const SESSION = 'ses_1';

test('friction details render persisted HTML as inert text and link to the saved chat', () => {
  const record: FrictionRecord = { version: 1, id: 'fr_012345678901234567890123', owner: 'bellonda',
    summary: '<script>alert(1)</script>', expected: 'A reply', actual: '<img src=x onerror=alert(1)>',
    sessionID: 'ses_origin', count: 1, firstSeen: '2026-09-24', lastSeen: '2026-09-24',
    commit: 'unavailable', model: 'unavailable', failures: [], failureContext: 'unavailable', provisional: true };
  const html = renderToStaticMarkup(createElement(FrictionDetail, { record }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /Open originating chat/);
});

function info(id: string, created: number, role: 'user' | 'assistant' = 'assistant') {
  return { id, sessionID: SESSION, role, time: { created } };
}

function text(id: string, messageID: string, value: string): Part {
  return { id, messageID, sessionID: SESSION, type: 'text', text: value };
}

test('a chat follows opencode: messages arrive, parts stream in, and other chats are ignored', () => {
  const messages: Messages = new Map();
  assert.deepEqual(applyChatEvent(messages, SESSION, 'message.updated', { sessionID: SESSION, info: info('msg_2', 20) }), { messages: true });
  assert.deepEqual(applyChatEvent(messages, SESSION, 'message.updated', { sessionID: SESSION, info: info('msg_1', 10, 'user') }), { messages: true });
  // A part can arrive before its message's info; the message is made for it.
  applyChatEvent(messages, SESSION, 'message.part.updated', { sessionID: SESSION, part: text('prt_1', 'msg_3', 'Hel') });
  assert.equal(messages.get('msg_3')?.parts[0]?.text, 'Hel');
  applyChatEvent(messages, SESSION, 'message.part.delta', { sessionID: SESSION, messageID: 'msg_3', partID: 'prt_1', field: 'text', delta: 'lo' });
  assert.equal(messages.get('msg_3')?.parts[0]?.text, 'Hello');
  // Info arriving later keeps the streamed parts.
  applyChatEvent(messages, SESSION, 'message.updated', { sessionID: SESSION, info: info('msg_3', 30) });
  assert.equal(messages.get('msg_3')?.parts[0]?.text, 'Hello');
  // An updated part replaces the streamed one rather than adding a second.
  applyChatEvent(messages, SESSION, 'message.part.updated', { sessionID: SESSION, part: text('prt_1', 'msg_3', 'Hello, world') });
  assert.equal(messages.get('msg_3')?.parts.length, 1);
  assert.deepEqual(orderedMessages(messages).map((message: Message) => message.info.id), ['msg_1', 'msg_2', 'msg_3']);

  assert.deepEqual(applyChatEvent(messages, SESSION, 'message.updated', { sessionID: 'ses_other', info: { ...info('msg_9', 5), sessionID: 'ses_other' } }), { messages: false });
  assert.equal(messages.has('msg_9'), false);
  assert.deepEqual(applyChatEvent(messages, SESSION, 'message.part.delta', { sessionID: SESSION, messageID: 'msg_3', partID: 'missing', field: 'text', delta: 'x' }), { messages: false });

  applyChatEvent(messages, SESSION, 'message.part.removed', { sessionID: SESSION, messageID: 'msg_3', partID: 'prt_1' });
  assert.equal(messages.get('msg_3')?.parts.length, 0);
  assert.deepEqual(applyChatEvent(messages, SESSION, 'message.removed', { sessionID: SESSION, messageID: 'msg_2' }), { messages: true });
  assert.equal(messages.has('msg_2'), false);
});

test('a chat knows when it is working, and shows errors other than a stop', () => {
  const messages: Messages = new Map();
  assert.equal(applyChatEvent(messages, SESSION, 'session.status', { sessionID: SESSION, status: { type: 'busy' } }).busy, true);
  assert.equal(applyChatEvent(messages, SESSION, 'session.status', { sessionID: SESSION, status: { type: 'retry' } }).busy, true);
  assert.equal(applyChatEvent(messages, SESSION, 'session.status', { sessionID: SESSION, status: { type: 'idle' } }).busy, false);
  assert.equal(applyChatEvent(messages, SESSION, 'session.idle', { sessionID: SESSION }).busy, false);
  assert.equal(applyChatEvent(messages, SESSION, 'session.error', { sessionID: SESSION, error: { name: 'MessageAbortedError' } }).error, undefined);
  assert.equal(applyChatEvent(messages, SESSION, 'session.error', { sessionID: SESSION, error: { name: 'APIError', data: { message: 'rate limited' } } }).error, 'rate limited');
});

test('unified diffs parse into files with line numbers, and new files are all additions', () => {
  const diff = [
    'Index: /repo/src/app.ts',
    '===================================================================',
    '--- /repo/src/app.ts',
    '+++ /repo/src/app.ts',
    '@@ -10,4 +10,5 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' export { a };',
    '\\ No newline at end of file',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-# Old',
    '+# New',
  ].join('\n');
  const [app, readme] = parseUnifiedDiff(diff);
  assert.equal(app?.path, '/repo/src/app.ts');
  assert.deepEqual([app?.additions, app?.deletions], [2, 1]);
  assert.deepEqual(app?.rows.map(row => [row.kind, row.old ?? null, row.new ?? null]), [
    ['hunk', null, null], ['context', 10, 10], ['remove', 11, null], ['add', null, 11], ['add', null, 12], ['context', 12, 13],
  ]);
  assert.equal(readme?.path, 'README.md');
  assert.deepEqual(readme?.rows.slice(1).map(row => `${row.kind}:${row.text}`), ['remove:# Old', 'add:# New']);
  assert.deepEqual(parseUnifiedDiff('no diff here'), []);

  const created = addedFile('/repo/new.py', 'print(1)\nprint(2)\n');
  assert.deepEqual([created.additions, created.deletions, created.rows.map(row => row.new)], [2, 0, [1, 2]]);
  assert.deepEqual(['a.ts', 'Dockerfile', 'x/vscode.chroot', 'notes.txt'].map(languageOf), ['typescript', 'docker', 'bash', '']);
});
