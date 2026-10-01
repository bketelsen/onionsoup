import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FrictionDetail, requestFrictionFix } from '../web/src/components/FrictionView.tsx';
import { InitiativeView } from '../web/src/components/InitiativeView.tsx';
import { OrgTree } from '../web/src/components/OrgView.tsx';
import { InboxErrors } from '../web/src/components/InboxErrors.tsx';
import { AttentionAssignment } from '../web/src/components/AttentionAssignment.tsx';
import { DecisionActions } from '../web/src/components/DecisionActions.tsx';
import { WorkRecovery } from '../web/src/components/WorkRecovery.tsx';
import { ReminderCard } from '../web/src/components/ReminderCard.tsx';
import { ITEM_SECTIONS } from '../web/src/components/ItemSections.tsx';
import { OPERATOR_WRITE_PERMISSION, WorkItem } from '@onionsoup/owners';
import type { FrictionRecord, PublicInitiative } from '../web/src/types.ts';
import { applyChatEvent, orderedMessages, type Messages } from '../web/src/chat/chatState.ts';
import { addedFile, languageOf, parseUnifiedDiff } from '../web/src/chat/diff.ts';
import type { Message, OwnerActivity, OwnerSummary, Part } from '../web/src/types.ts';
import { OwnerActivityIcon } from '../web/src/components/OwnerActivityIcon.tsx';
import { RuntimeWorkRows } from '../web/src/components/RuntimeWorkRows.tsx';
import { ProviderHealthBanner } from '../web/src/components/ProviderHealthBanner.tsx';
import { BuildBadge } from '../web/src/components/Rail.tsx';
import type { ProviderHealthView } from '../web/src/types.ts';

const SESSION = 'ses_1';

test('build badge shows the installed ID and reserves red for armed deployment', () => {
  const idle = renderToStaticMarkup(createElement(BuildBadge, { deployment: { buildId: 'old-123', isPending: false } }));
  assert.match(idle, /old-123/);
  assert.doesNotMatch(idle, /text-status-error/);
  const pending = renderToStaticMarkup(createElement(BuildBadge, {
    deployment: { buildId: 'old-123', isPending: true, pending: { status: 'draining', targetBuildId: 'next-456' } },
  }));
  assert.match(pending, /old-123/);
  assert.match(pending, /text-status-error/);
  assert.match(pending, /next-456/);
  assert.equal(renderToStaticMarkup(createElement(BuildBadge, { deployment: { buildId: null, isPending: false } })), '');
});

test('the rail icon is tinted by what the owner\'s chats are doing, and says so', () => {
  const owner: OwnerSummary = { id: 'leto', name: 'Leto', title: 't', source: '', icon: 'code', color: 'primary', model: 'm', domain: 'd',
    chat: true, hasDesk: true, waiting: 0, running: 0, runtimeWork: [], activity: 'idle' };
  const render = (activity: OwnerActivity) => renderToStaticMarkup(createElement(OwnerActivityIcon, { owner: { ...owner, activity } }));
  const working = render('working');
  assert.match(working, /text-primary animate-pulse/);
  assert.match(working, /aria-label="working"/);
  const waiting = render('waiting');
  assert.match(waiting, /text-status-warning/);
  assert.match(waiting, /aria-label="waiting on you"/);
  const idle = render('idle');
  assert.doesNotMatch(idle, /text-primary|text-status-warning|aria-label/);
  assert.match(idle, /data-activity="idle"/);
});

test('an owner\'s runtime work is listed under it, each row linking to its item, and the owner works', () => {
  const owner: OwnerSummary = { id: 'homelab', name: 'Miles Teg', title: 't', source: '', icon: 'server', color: 'primary', model: 'm', domain: 'd',
    chat: true, hasDesk: true, waiting: 0, running: 0, activity: 'working',
    runtimeWork: [{ id: 'w-20260926-38d7df', title: 'Rebase <#12> onto the current base', status: 'implementing' }] };
  const rows = renderToStaticMarkup(createElement(RuntimeWorkRows, { owner, activeItem: 'w-20260926-38d7df' }));
  assert.match(rows, /href="#\/item\/w-20260926-38d7df"/);
  assert.match(rows, /Rebase &lt;#12&gt; onto the current base/);
  assert.match(rows, /aria-label="runtime work"/);
  assert.match(rows, /bg-interactive-active/, 'the item open on the page is marked');
  assert.match(renderToStaticMarkup(createElement(OwnerActivityIcon, { owner })), /data-activity="working"/);
  assert.equal(renderToStaticMarkup(createElement(RuntimeWorkRows, { owner: { ...owner, runtimeWork: [] } })), '');
});

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
  record.triage = { state: 'investigated', updatedAt: '2026-09-24T00:00:00.000Z', investigation: {
    disposition: 'propose-fix', observed: ['<script>unsafe</script>'], inferred: [], unknown: ['Freshness unknown'],
    proposedWork: { title: 'Repair evidence', goal: 'Evidence available', rationale: 'Reviewer blocked',
      repository: 'example/wiki', size: 'small', acceptance: ['Reviewer reads evidence'] },
  } };
  record.proposalDigest = 'a'.repeat(64);
  const html = renderToStaticMarkup(createElement(FrictionDetail, { record }));
  assert.match(html, /Request this fix/);
  assert.match(html, /Proposed fix: Repair evidence/);
  assert.match(html, /no work has been dispatched/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /Open originating chat/);
  record.promotion = { owner: 'bellonda', by: 'Brian', at: '2026-09-24T00:00:00.000Z', digest: record.proposalDigest,
    requestID: 'r-handoff-fixture', status: 'denied', workItem: 'w-fixture' };
  const promoted = renderToStaticMarkup(createElement(FrictionDetail, { record }));
  assert.doesNotMatch(promoted, /Request this fix|no work has been dispatched/);
  assert.match(promoted, /View linked work/);
  assert.match(promoted, /denied/);
  record.promotion.status = 'blocked';
  assert.match(renderToStaticMarkup(createElement(FrictionDetail, { record })), /Retry request routing/);
});

const FRICTION_ID = 'fr_012345678901234567890123';
const OLD_COMMIT = 'a'.repeat(40);
const NEW_COMMIT = 'b'.repeat(40);
const LATEST_COMMIT = 'c'.repeat(40);
const FRICTION_INVESTIGATION = {
  disposition: 'propose-fix' as const, observed: ['src/old.ts:10'], inferred: [], unknown: [],
  proposedWork: { title: 'Original fix', goal: 'Repair original', repository: 'example/wiki',
    rationale: 'Observed failure', size: 'small' as const, acceptance: ['Original check'] },
};
const FRICTION_RECORD: FrictionRecord = {
  version: 1, id: FRICTION_ID, owner: 'bellonda', summary: 'Failure', expected: 'A reply', actual: 'No reply',
  sessionID: 'ses_origin', count: 1, firstSeen: '2026-09-24', lastSeen: '2026-09-24',
  commit: OLD_COMMIT, model: 'unavailable', failures: [], failureContext: 'unavailable', provisional: false,
  triage: { state: 'investigated', updatedAt: '2026-09-24T00:00:00.000Z', investigation: FRICTION_INVESTIGATION },
  originalInvestigation: FRICTION_INVESTIGATION, effectiveRevision: 0, revisions: [],
};

const frictionHtml = (record: FrictionRecord) => renderToStaticMarkup(createElement(FrictionDetail, { record }));

test('stale friction shows both local commits and a revalidation command without requesting a fix', () => {
  const html = frictionHtml({ ...FRICTION_RECORD, freshness: {
    investigatedCommit: OLD_COMMIT, referenceCommit: NEW_COMMIT, stale: true,
    reason: 'source_stale', scope: 'local-checkout-not-fetched',
  } });
  assert.match(html, /Investigated at a{8} · local checkout b{8} \(not fetched\)/);
  assert.match(html, /source.*stale/i);
  assert.match(html, new RegExp(`Needs revalidation: owners friction-revalidate ${FRICTION_ID}`));
  assert.doesNotMatch(html, /Request this fix/);
});

test('a revision at an older commit still needs revalidation when the local checkout advances again', () => {
  const html = frictionHtml({ ...FRICTION_RECORD,
    freshness: { investigatedCommit: NEW_COMMIT, referenceCommit: LATEST_COMMIT, stale: true,
      reason: 'source_stale', scope: 'local-checkout-not-fetched' },
    effectiveRevision: 1,
    revisions: [{ version: 1, id: FRICTION_ID, revision: 1, previousCommit: OLD_COMMIT,
      sourceCommit: NEW_COMMIT, reason: 'source_stale', state: 'revised', at: '2026-09-25T00:00:00.000Z',
      investigation: FRICTION_INVESTIGATION }],
  });
  assert.match(html, /Investigated at b{8} · local checkout c{8} \(not fetched\)/);
  assert.match(html, new RegExp(`Needs revalidation: owners friction-revalidate ${FRICTION_ID}`));
  assert.doesNotMatch(html, /<button[^>]*>Request this fix<\/button>/);
});

test('a blocked revision at the current commit shows its reason instead of asking to revalidate again', () => {
  const html = frictionHtml({ ...FRICTION_RECORD,
    freshness: { investigatedCommit: OLD_COMMIT, referenceCommit: NEW_COMMIT, stale: true,
      reason: 'source_stale', scope: 'local-checkout-not-fetched' },
    revisions: [{ version: 1, id: FRICTION_ID, revision: 1, previousCommit: OLD_COMMIT,
      sourceCommit: NEW_COMMIT, reason: 'source_stale', state: 'blocked', blockedReason: 'source changed during revalidation',
      at: '2026-09-25T00:00:00.000Z', investigation: FRICTION_INVESTIGATION }],
  });
  assert.match(html, /Revision 1.*blocked.*source changed during revalidation/s);
  assert.doesNotMatch(html, /Needs revalidation: owners friction-revalidate/);
});

test('an already-fixed revision shows the fixing commit and source citations without offering a request', () => {
  const fixed = { disposition: 'already-fixed' as const, fixedBy: NEW_COMMIT,
    observed: ['src/fix.ts:42 shows the changed path'], inferred: [], unknown: [] };
  const html = frictionHtml({ ...FRICTION_RECORD, triage: { ...FRICTION_RECORD.triage!, investigation: fixed },
    freshness: { investigatedCommit: NEW_COMMIT, referenceCommit: NEW_COMMIT, stale: false, scope: 'local-checkout-not-fetched' },
    effectiveRevision: 1, revisions: [{ version: 1, id: FRICTION_ID, revision: 1, previousCommit: OLD_COMMIT,
      sourceCommit: NEW_COMMIT, reason: 'source_stale', state: 'revised', at: '2026-09-25T00:00:00.000Z', investigation: fixed }],
  });
  assert.match(html, new RegExp(`Already fixed by ${NEW_COMMIT}`));
  assert.match(html, /src\/fix.ts:42 shows the changed path/);
  assert.match(html, /Original investigation/);
  assert.match(html, /Original fix/);
  assert.doesNotMatch(html, /Request this fix/);
});

test('revised proposal survives a blocked old promotion and posts the effective digest', async () => {
  const revised = { ...FRICTION_INVESTIGATION, proposedWork: { ...FRICTION_INVESTIGATION.proposedWork, title: 'Revised fix' } };
  const digest = 'c'.repeat(64);
  const record: FrictionRecord = { ...FRICTION_RECORD, triage: { ...FRICTION_RECORD.triage!, investigation: revised },
    freshness: { investigatedCommit: NEW_COMMIT, referenceCommit: NEW_COMMIT, stale: false, scope: 'local-checkout-not-fetched' },
    revisions: [{ version: 1, id: FRICTION_ID, revision: 1, previousCommit: OLD_COMMIT, sourceCommit: NEW_COMMIT,
      reason: 'source_stale', state: 'blocked', blockedReason: '<blocked>', at: '2026-09-25T00:00:00.000Z', investigation: revised },
    { version: 1, id: FRICTION_ID, revision: 2, previousCommit: OLD_COMMIT, sourceCommit: NEW_COMMIT,
      reason: 'source_stale', state: 'revised', at: '2026-09-26T00:00:00.000Z', investigation: revised }],
    effectiveRevision: 2, proposalDigest: digest,
    promotion: { owner: 'bellonda', by: 'Brian', at: '2026-09-24T00:00:00.000Z', digest: 'd'.repeat(64),
      requestID: 'r-handoff-old', status: 'blocked', reason: 'friction_source_stale' },
  };
  const html = frictionHtml(record);
  assert.match(html, /Revision 1.*b{8}.*blocked.*&lt;blocked&gt;/s);
  assert.match(html, /Revision 2.*b{8}.*propose-fix/s);
  assert.match(html, /Revised fix/);
  assert.match(html, /Original fix/);
  assert.match(html, /Request this fix/);
  const previousFetch = globalThis.fetch;
  let posted: { path: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (path, init) => {
    posted = { path: String(path), init };
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await requestFrictionFix(record);
    assert.equal(posted?.path, '/api/decide');
    assert.equal(posted?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(posted?.init?.body)),
      { action: 'promote-friction', id: FRICTION_ID, proposalDigest: digest });
  } finally {
    globalThis.fetch = previousFetch;
  }
  const routed = frictionHtml({ ...record, promotion: { ...record.promotion!, status: 'pending-owner' } });
  assert.doesNotMatch(routed, /Request this fix/);
  assert.match(routed, /bellonda: awaiting owner acceptance/);
  assert.match(routed, /r-handoff-old/);
  const blockedCurrent = frictionHtml({ ...record, promotion: { ...record.promotion!, digest } });
  assert.doesNotMatch(blockedCurrent, /Request this fix/);
  assert.match(blockedCurrent, /Retry request routing/);
});

test('unreadable revision and promotion history warn beside the preserved investigation', () => {
  const html = frictionHtml({ ...FRICTION_RECORD,
    unreadable: ['friction_revisions_unreadable', 'friction_promotion_history_unreadable'] });
  assert.match(html, /friction_revisions_unreadable/);
  assert.match(html, /friction_promotion_history_unreadable/);
  assert.match(html, /Original investigation.*Original fix/s);
  assert.match(html, /role="alert"/);
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

test('a reminder card shows the prompt as inert text, its work item and a cancel with an optional note', () => {
  const reminder = { id: 'm-20260925-1a2b3c', prompt: 'Verify <b>backups</b> keep 14 days', item: 'w-20260925-f8b59e', dueAt: '2026-10-10T12:00:00.000Z', createdAt: '2026-09-25T12:00:00.000Z' };
  const html = renderToStaticMarkup(createElement(ReminderCard, { reminder, onDone: () => {} }));
  assert.match(html, /Verify &lt;b&gt;backups&lt;\/b&gt; keep 14 days/);
  assert.match(html, /w-20260925-f8b59e/);
  assert.match(html, /placeholder="Note \(optional\)"/);
  assert.match(html, /<button[^>]*>Cancel<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Cancel/, 'the note is optional');
  const withoutItem = renderToStaticMarkup(createElement(ReminderCard, { reminder: { ...reminder, item: undefined }, onDone: () => {} }));
  assert.doesNotMatch(withoutItem, /w-20260925/);
});

test('an owner plan\'s page shows the plan, its approval, the session doing it, then how it was verified, reviewed and published', () => {
  const item = WorkItem.parse({
    id: 'w-1', owner: 'homelab', workflow: 'owner-change', status: 'landed', createdAt: '', updatedAt: '',
    proposal: { title: 'Rotate logs', goal: 'Keep the disk free', rationale: 'r', acceptance: ['a'], size: 'medium' },
    planDocument: { markdown: '## Tasks\n\n1. Add a weekly logrotate config', digest: 'd' },
    planApproval: { by: 'bjk', at: new Date().toISOString() },
    session: { sessionID: 'ses_work', directory: '/desks/homelab' },
    implementations: [{ report: { summary: 's', filesChanged: [], deviationsFromPlan: [] }, diffStat: 'x', verification: [{ command: 'pytest', exitCode: 0, output: 'ok' }] }],
    verdicts: [{ decision: 'approve', summary: 'Does what the plan says', findings: [{ severity: 'nit', file: 'logrotate.conf', issue: 'Terse', suggestion: 'Fine' }] }],
    deskPublication: { stage: 'complete', reviewer: 'openai/gpt-5.6-sol', reviewedHead: 'h', reviewedTree: 't' },
    publication: { url: 'https://github.com/example/fleet/pull/7', branch: 'owners/w-1', by: 'homelab', at: '', state: 'open' },
  });
  // The plan renders through the chat's Markdown, which needs a browser DOM to sanitize; the rest renders here.
  assert.deepEqual(ITEM_SECTIONS.map(Section => Section.name), ['WorkSession', 'Proposal', 'Plan', 'Notes', 'RequestAcceptance', 'Publication', 'Verification', 'Reviews', 'Hires']);
  const html = ITEM_SECTIONS.filter(Section => Section.name !== 'Plan').map(Section => renderToStaticMarkup(createElement(Section, { item }))).join('');
  assert.match(html, /Open the work session/);
  assert.match(html, /published<\/span>.*reviewed by .*openai\/gpt-5\.6-sol/s);
  assert.match(html, /pytest/);
  assert.match(html, /\[nit\] logrotate\.conf: Terse/);
  assert.doesNotMatch(html, /Hires/, 'no hire table for work the owner did itself');
});

test('a pending plan approval gets the plan card: approve or send back with a note, never an "always" answer', async () => {
  const { PendingCard, PlanApprovalActions, pendingCardKind } = await import('../web/src/chat/cards.tsx');
  const permission = { id: 'per_plan', sessionID: SESSION, permission: 'onionsoup_plan_approval', patterns: ['w-7'], metadata: {}, always: [] };
  const entry = {
    kind: 'permission' as const, id: 'per_plan', owner: 'homelab', title: 'Approve plan w-7: Coder package', detail: '', sessionID: SESSION,
    permission, planApproval: { item: 'w-7', title: 'Coder package', plan: '1. Pin the deb' },
  };
  assert.equal(pendingCardKind(entry), 'plan');
  const actions = renderToStaticMarkup(createElement(PlanApprovalActions, { entry, onDone: () => {} }));
  assert.match(actions, /Approve plan<\/button>/);
  assert.match(actions, /Revise approach<\/button>/);
  assert.match(actions, /What should change\?/);
  assert.doesNotMatch(actions, /Always/);
  const generic = { ...entry, planApproval: undefined, permission: { ...permission, permission: 'bash', metadata: { command: 'ls' } } };
  assert.equal(pendingCardKind(generic), 'permission');
  const html = renderToStaticMarkup(createElement(PendingCard, { entry: generic, onDone: () => {} }));
  assert.match(html, /Permission Required/);
  assert.match(html, /Always Allow/);
});

test('operator write gate cards expose only Allow once and denial for both approval stages', async () => {
  const { PendingCard } = await import('../web/src/chat/cards.tsx');
  for (const mode of ['create-write', 'accept-write']) {
    const entry = { kind: 'permission' as const, id: `per_${mode}`, owner: 'operator', title: mode, detail: '', sessionID: SESSION,
      permission: { id: `per_${mode}`, sessionID: SESSION, permission: OPERATOR_WRITE_PERMISSION,
        patterns: [`${mode}/exact-digest`], always: [],
        metadata: { mode, approvalScope: 'once', action: 'Approve only this exact scope', warning: 'No persistent grant.' } } };
    const card = renderToStaticMarkup(createElement(PendingCard, { entry, onDone: () => {} }));
    const inbox = renderToStaticMarkup(createElement(DecisionActions, { entry, busy: false, text: '', withDelete: false,
      setWithDelete: () => {}, decide: async () => {}, permission: async () => {} }));
    assert.match(card, /Allow Once/);
    assert.match(card, /Deny/);
    assert.match(card, /No persistent grant/);
    assert.doesNotMatch(card, /Always/);
    assert.match(inbox, /Allow once/);
    assert.match(inbox, /Reject/);
    assert.doesNotMatch(inbox, /Always/);
  }
});

test('scoped write cards present the original goal and full host diff as inert reviewable text', async () => {
  const { PendingCard } = await import('../web/src/chat/cards.tsx');
  const { Decision } = await import('../web/src/components/Decision.tsx');
  const { operatorWriteApprovalOf } = await import('../src/operator-write-approval.ts');
  const common = { originalIntake: { text: 'Fix only the requested title <script>unchanged</script>' },
    goal: 'Use the requested title', constraints: ['Only README.md', 'No commit or push'] };
  const diff = ['diff --git a/README.md b/README.md', '-old title', '+requested title', ...Array.from({ length: 150 }, (_, index) => ` context ${index}`), '+last reviewable line'].join('\n');
  const metadata = [
    { mode: 'create-write', approvalScope: 'once', intake: common.originalIntake, input: { ...common, tasks: [{ id: 'child_one', goal: 'Change only the title line' }] },
      workspaces: [{ id: 'child_one', directory: '/isolated/task', head: 'head_fixture', files: ['README.md'] }] },
    { mode: 'accept-write', approvalScope: 'once', ...common, directory: '/isolated/task',
      artifact: { head: 'head_fixture', diff, files: [{ path: 'README.md' }] },
      evidence: { sessionID: 'ses_child', messageID: 'msg_evidence' } },
  ];
  for (const details of metadata) {
    const permission = { id: 'per_write', sessionID: SESSION, permission: OPERATOR_WRITE_PERMISSION,
      patterns: ['exact-scope-digest'], metadata: details, always: [] };
    const operatorWriteApproval = operatorWriteApprovalOf(permission);
    assert(operatorWriteApproval);
    const entry = { kind: 'permission' as const, id: 'per_write', owner: 'operator', title: 'Scoped change', detail: '', sessionID: SESSION,
      permission, operatorWriteApproval };
    for (const html of [renderToStaticMarkup(createElement(PendingCard, { entry, onDone: () => {} })),
      renderToStaticMarkup(createElement(Decision, { entry, onDone: () => {} }))]) {
      assert.match(html, /Original request/);
      assert.match(html, /Use the requested title/);
      assert.match(html, /Only README\.md/);
      assert.match(html, /No commit or push/);
      assert.match(html, /head_fixture/);
      assert.match(html, /\/isolated\/task/);
      assert.match(html, /&lt;script&gt;unchanged&lt;\/script&gt;/);
      assert.doesNotMatch(html, /<script>/);
      assert.doesNotMatch(html, /Always/);
      if (details.mode === 'create-write') assert.match(html, /Change only the title line/);
      if (details.mode === 'accept-write') {
        assert.match(html, /Exact host-recorded diff/);
        assert.match(html, /last reviewable line/);
        assert.match(html, /Child conclusions are model claims/);
        assert.match(html, /msg_evidence/);
      }
    }
  }
  assert.equal(operatorWriteApprovalOf({ permission: 'read', metadata: metadata[0] }), undefined);
  assert.equal(operatorWriteApprovalOf({ permission: OPERATOR_WRITE_PERMISSION, metadata: { mode: 'accept-write', artifact: { diff } } }), undefined);
});

test('the provider banner shows failing providers with their fix, a recovered one in green, and nothing when all is well', () => {
  const failing: ProviderHealthView = {
    provider: 'openai', name: 'OpenAI', status: 'failing', since: new Date().toISOString(), lastFailureAt: new Date().toISOString(), failures: 3,
    affected: [{ kind: 'hire', what: 'w-1: review', at: '' }, { kind: 'watcher', what: 'homelab', at: '' }, { kind: 'hire', what: 'w-2: review', at: '' }],
    lastError: 'APIError: Incorrect API key provided: [masked].', fix: 'Run `opencode auth login` and choose OpenAI.',
  };
  const html = renderToStaticMarkup(createElement(ProviderHealthBanner, { providerHealth: [failing] }));
  assert.match(html, /role="alert"/);
  assert.match(html, /status-error/);
  assert.match(html, /OpenAI authentication failing/);
  assert.match(html, /3 failures/);
  assert.match(html, /affected: hire, watcher/);
  assert.match(html, /choose OpenAI/);
  const recovered = renderToStaticMarkup(createElement(ProviderHealthBanner, { providerHealth: [{ ...failing, status: 'ok', recoveredAt: new Date().toISOString() }] }));
  assert.doesNotMatch(recovered, /role="alert"/);
  assert.match(recovered, /status-success/);
  assert.match(recovered, /OpenAI authentication recovered/);
  assert.equal(renderToStaticMarkup(createElement(ProviderHealthBanner, { providerHealth: [] })), '');
});

const PHONE_OWNER: OwnerSummary = { id: 'sheeana', name: 'Sheeana', title: 'Keeper of the installer', source: '', icon: 'flask', color: 'primary',
  model: 'm', domain: 'd', chat: true, hasDesk: true, waiting: 2, running: 0, runtimeWork: [], activity: 'idle' };

test('a drawer sits beside the page from lg up and slides over it below, closed until opened, with a backdrop that closes it', async () => {
  const { Drawer } = await import('../web/src/components/Drawer.tsx');
  const render = (isOpen: boolean) => renderToStaticMarkup(createElement(Drawer,
    { side: 'right', isOpen, onClose: () => {}, label: 'Desk', className: 'w-80', children: createElement('p', null, 'inside') }));
  const closed = render(false);
  assert.match(closed, /data-drawer="right"/);
  assert.match(closed, /data-open="false"/);
  assert.match(closed, /translate-x-full invisible/, 'closed: off screen and out of the tab order');
  assert.match(closed, /lg:static[^"]*lg:translate-x-0 lg:visible/, 'from lg up it is an ordinary panel');
  assert.doesNotMatch(closed, /data-drawer-backdrop/);
  assert.match(closed, /<div class="flex-1 min-h-0 w-80"><p>inside<\/p><\/div>/, 'the panel keeps its own width');
  const open = render(true);
  assert.match(open, /data-open="true"/);
  assert.doesNotMatch(open, /invisible/);
  assert.match(open, /data-drawer-backdrop[^>]*class="[^"]*lg:hidden/, 'the backdrop only covers a narrow screen');
});

test('the rail is a drawer on narrow screens, and its rows are thumb-sized on touch screens without blocking a scroll', async () => {
  const { Rail } = await import('../web/src/components/Rail.tsx');
  const state = { owners: [PHONE_OWNER], inbox: [], frictionCount: 0 };
  const html = renderToStaticMarkup(createElement(Rail, { state, route: ['inbox'], onReorder: () => {} }));
  assert.match(html, /data-drawer="left"/);
  assert.match(html, /aria-label="Navigation"/);
  assert.match(html, /pointer-coarse:min-h-11[^"]*pointer-fine:touch-none/, 'only a mouse drag re-orders; a finger scrolls the rail');
  assert.doesNotMatch(html, /[" ]touch-none/);
  const { MobileBar } = await import('../web/src/components/Drawer.tsx');
  const bar = renderToStaticMarkup(createElement(MobileBar, { title: 'Inbox' }));
  assert.match(bar, /<header class="lg:hidden/);
  assert.match(bar, /aria-label="Open navigation"[^>]*class="lg:hidden[^"]*size-11/);
  assert.match(bar, />Inbox<\/span>/);
});

test('an owner page opens its desk from the header on narrow screens, and the chat keeps the width', async () => {
  const { OwnerView } = await import('../web/src/components/OwnerView.tsx');
  const html = renderToStaticMarkup(createElement(OwnerView, { owner: PHONE_OWNER, inbox: [], refresh: () => {} }));
  assert.match(html, /aria-label="Open navigation"/);
  assert.match(html, /aria-label="Open the desk"[^>]*class="lg:hidden/);
  assert.match(html, /data-drawer="right"[^>]*aria-label="Sheeana&#x27;s desk"/);
});

test('the composer clears the home indicator, labels its buttons, and on a touch screen Return is a new line', async () => {
  const { Composer, sendsOnEnter } = await import('../web/src/chat/Composer.tsx');
  const html = renderToStaticMarkup(createElement(Composer,
    { agent: 'Sheeana', busy: true, onSend: async () => {}, onStop: () => {}, autoAccept: false, onToggleAutoAccept: () => {} }));
  assert.match(html, /<form class="[^"]*pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]"/);
  assert.match(html, /aria-label="Message Sheeana"/);
  assert.match(html, /aria-label="Send"/);
  assert.match(html, /aria-label="Stop"/);
  assert.equal(sendsOnEnter(), true, 'without a media query (a keyboard), Enter sends');
  const original = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({ matches: query === '(pointer: coarse)' })) as unknown as typeof matchMedia;
  try {
    assert.equal(sendsOnEnter(), false);
  } finally {
    globalThis.matchMedia = original;
  }
});

test('attention renders Seen separately from assignment and does not equate acceptance with resolution', () => {
  const entry = { kind: 'attention' as const, id: 'a-fixture', owner: 'homelab', title: 'Fix check', detail: '', attentionStatus: 'open' };
  const actions = renderToStaticMarkup(createElement(DecisionActions, { entry, busy: false, text: '', withDelete: false,
    setWithDelete: () => undefined, decide: async () => undefined, permission: async () => undefined }));
  assert.match(actions, />Seen</);
  assert.doesNotMatch(actions, />Acknowledge</);
  const assigned = renderToStaticMarkup(createElement(AttentionAssignment, { entry: { ...entry,
    attentionAssignment: { by: 'Brian', owner: 'clippy', requestID: 'r-fixture', status: 'pending-owner' } },
    busy: false, decide: async () => undefined }));
  assert.match(assigned, /awaiting owner acceptance/);
  assert.match(assigned, /remains unresolved/);
  assert.match(assigned, /r-fixture/);
});

test('approved child recovery displays attribution and inert text without execution controls', async () => {
  const { ChildRecoveryEvidence, PreservedChildTranscript } = await import('../web/src/components/ChildRecoveryHistory.tsx');
  const evidence = renderToStaticMarkup(createElement(ChildRecoveryEvidence, { notice: {
    state: 'abandoned', childID: 'ses_child', parentID: 'ses_parent', reason: 'Explicit narrow recovery',
    approvedBy: 'Brian', approvedAt: '2026-09-30T00:00:00.000Z', digest: 'a'.repeat(64),
  } }));
  assert.match(evidence, /Abandoned child/);
  assert.match(evidence, /Approved by Brian/);
  assert.match(evidence, /does not resume the child or establish that its work completed/);
  const transcript = renderToStaticMarkup(createElement(PreservedChildTranscript, { messages: [
    { parts: [{ type: 'text', text: '<script>resume child</script>' }, { type: 'tool', text: 'hidden tool instruction' }] },
    { parts: [{ type: 'file', url: 'https://example.invalid/attachment' }] },
  ] }));
  assert.match(transcript, /&lt;script&gt;resume child&lt;\/script&gt;/);
  assert.doesNotMatch(transcript, /<script>|hidden tool instruction|example.invalid|<button|<form|<textarea/);
  assert.match(transcript, /Tool records and other non-text parts are not displayed/);
  const empty = renderToStaticMarkup(createElement(PreservedChildTranscript, { messages: [] }));
  assert.match(empty, /No text messages are present/);
});
