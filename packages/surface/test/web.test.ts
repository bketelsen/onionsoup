import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FrictionDetail } from '../web/src/components/FrictionView.tsx';
import { InitiativeView } from '../web/src/components/InitiativeView.tsx';
import { OrgTree } from '../web/src/components/OrgView.tsx';
import { InboxErrors } from '../web/src/components/InboxErrors.tsx';
import { WorkRecovery } from '../web/src/components/WorkRecovery.tsx';
import { WorkItem } from '@onionsoup/owners';
import type { FrictionRecord, PublicInitiative } from '../web/src/types.ts';
import { applyChatEvent, orderedMessages, type Messages } from '../web/src/chat/chatState.ts';
import { addedFile, languageOf, parseUnifiedDiff } from '../web/src/chat/diff.ts';
import type { Message, Part } from '../web/src/types.ts';

const SESSION = 'ses_1';

test('partial inbox failures name the affected owner and operation without hiding available gates', () => {
  const html = renderToStaticMarkup(createElement(InboxErrors, { errors: [
    { owner: '<script>owner</script>', code: 'permission_list_failed' },
    { owner: 'homelab', code: 'question_list_failed' },
    { owner: 'leto', code: 'chat_directory_failed' },
  ] }));
  assert.match(html, /role="alert"/);
  assert.match(html, /&lt;script&gt;owner&lt;\/script&gt;/);
  assert.match(html, /Pending permissions could not be loaded/);
  assert.match(html, /Pending questions could not be loaded/);
  assert.match(html, /chat directory could not be opened/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(renderToStaticMarkup(createElement(InboxErrors, { errors: [] })), '');
  const stale = renderToStaticMarkup(createElement(InboxErrors, { errors: [], refreshError: 'HTTP 500' }));
  assert.match(stale, /role="alert"/);
  assert.match(stale, /Pending approvals may be missing; displayed items may be stale/);
});

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

test('an initiative lists its assignments by dependency step with state chips, work and PR links, escalations and plan reviews', () => {
  const initiative: PublicInitiative = {
    id: 'i-20260924-abcdef', owner: 'odrade', title: 'Org change', goal: 'Change core, then the wiki', rationale: 'Asked for',
    status: 'approved', revision: 0, approval: { by: 'person', at: '2026-09-24T10:00:00.000Z', revision: 0 },
    feedback: [], createdAt: '2026-09-24T09:00:00.000Z', updatedAt: '2026-09-24T11:00:00.000Z',
    assignments: [
      { id: 'core', to: 'clippy', title: 'Core change', after: [], depth: 0, state: 'awaiting-merge', request: 'r-1',
        item: { id: 'w-request-r-1', status: 'landed', url: 'https://example.test/pr/7', prState: 'open' } },
      { id: 'wiki', to: 'bellonda', title: 'Wiki follow-up', after: ['core'], depth: 1, state: 'not-dispatched' },
    ],
    escalations: [{ id: 'e-12345678', kind: 'question', from: 'clippy', assignment: 'core', note: 'Which branch?', at: '2026-09-24T10:30:00.000Z' }],
    planReviews: [{ item: 'w-request-r-1', digest: 'abc', verdict: 'approve', note: 'Fits', by: 'owner:odrade', at: '2026-09-24T10:40:00.000Z' }],
  };
  const html = renderToStaticMarkup(createElement(InitiativeView, { initiative }));
  for (const text of ['Org change', 'Step 1', 'Step 2', 'Core change', 'waiting on you to merge', 'not dispatched', 'after core',
    'w-request-r-1', 'https://example.test/pr/7', 'Which branch?', 'Plan reviews', 'owner:odrade: Fits', 'Approved by person for revision 0']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.indexOf('Core change') < html.indexOf('Wiki follow-up'), 'dependency order');
  assert.ok(!html.includes('Approve initiative'), 'an approved initiative has no approval controls');
  const waiting = renderToStaticMarkup(createElement(InitiativeView, { initiative: { ...initiative, status: 'awaiting-approval' } }));
  assert.ok(waiting.includes('Approve initiative'));
});

test('the org tree nests reports under their manager', () => {
  const html = renderToStaticMarkup(createElement(OrgTree, { entries: [
    { id: 'clippy', name: 'clippy', title: '', icon: 'code', domain: 'd', manager: 'odrade' },
    { id: 'odrade', name: 'Odrade', title: 'Mother Superior', icon: 'shield', domain: 'd' },
    { id: 'homelab', name: 'Miles Teg', title: 'Bashar', icon: 'shield', domain: 'd' },
  ] }));
  assert.match(html, /Odrade.*<ul[^>]*>.*clippy.*<\/ul>.*Miles Teg/s);
});

test('failed work offers a retry, except work of the retired pipeline, which can only be cancelled', () => {
  const failed = (reason: string) => WorkItem.parse({
    id: 'w-1', owner: 'clippy', workflow: 'owner-change', status: 'failed', reason, createdAt: '', updatedAt: '',
    proposal: { title: 't', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' },
  });
  const render = (reason: string) => renderToStaticMarkup(createElement(WorkRecovery, { item: failed(reason), onDone: () => {} }));
  assert.match(render('desk_pr_closed'), /Retry failed stage/);
  assert.doesNotMatch(render('pipeline_removed'), /Retry failed stage/);
  assert.match(render('pipeline_removed'), /Cancel work/);
  assert.doesNotMatch(render('desk_pr_closed'), /Land over findings/);
});
