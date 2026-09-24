import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { askOwner } from '../src/ask.ts';
import { recentActivityContext, recentChatDecisions, recentJournal } from '../src/chat-context.ts';
import { OwnerDeclaration } from '../src/declarations.ts';
import { exchangeClient } from '../src/exchange-client.ts';
import { deliverExchangeNotices, ExchangeNotice, queueExchangeNotice, type ExchangeClient, type NoticeChat, type NoticeMessage } from '../src/exchange-notices.ts';
import { NOTICE_PREFIX } from '../src/notices.ts';
import type { HireRequest } from '../src/opencode.ts';
import { withActiveHooks } from './active-hooks.ts';
import { Runtime } from '../src/runtime.ts';

const declarations = 'packages/owners/test/fixtures/owners';
async function fixture() {
  const state = await mkdtemp('/tmp/onionsoup-context-test-');
  const runtime = await Runtime.open({ declarations, state });
  const notebook = runtime.notebook('homelab');
  await notebook.ensure('# Test charter');
  return { runtime, notebook, state };
}

function journalPath(runtime: Runtime, date = new Date().toISOString().slice(0, 10)) {
  return join(runtime.notebook('homelab').directory, 'journal', `${date}.jsonl`);
}

function message(id: string, created: number, text: string, agent = 'Miles Teg'): NoticeMessage {
  return { info: { id, role: 'user', agent, time: { created } }, parts: [{ type: 'text', text }] };
}

function transport() {
  const sessions: NoticeChat[] = [];
  const messages = new Map<string, NoticeMessage[]>();
  const posted: { target: Parameters<ExchangeClient['post']>[0]; body: Parameters<ExchangeClient['post']>[1] }[] = [];
  const state = { isIdle: true, failBefore: false, failAfter: false };
  const client: ExchangeClient = {
    sessions: async () => sessions,
    messages: async target => messages.get(target.sessionID) ?? [],
    idle: async () => state.isIdle,
    async post(target, body) {
      if (state.failBefore) throw new Error('transport_unavailable');
      posted.push({ target, body });
      messages.set(target.sessionID, [...messages.get(target.sessionID) ?? [], message(body.messageID, Date.now(), body.parts[0]!.text)]);
      if (state.failAfter) throw new Error('acceptance_acknowledgement_lost');
    },
  };
  function chat(id: string, personAt: number, updated = personAt, parentID?: string, agent?: string) {
    sessions.push({ id, directory: '/test/owner-desk', time: { updated }, parentID });
    messages.set(id, [message(`${id}-person`, personAt, 'hello', agent)]);
  }
  return { client, state, sessions, messages, posted, chat };
}

async function records(runtime: Runtime, status: 'pending' | 'delivered' | 'undeliverable') {
  const directory = join(runtime.stateDirectory, 'notices', 'exchanges', status);
  const files = (await readdir(directory).catch(() => [])).filter(file => file.endsWith('.json'));
  return Promise.all(files.map(async file => ExchangeNotice.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))));
}

test('recent activity includes autonomous work and fresh decisions, honors retractions, and ignores old or malformed records', async () => {
  const { runtime, notebook } = await fixture();
  for (const kind of ['asked', 'answered', 'work-status', 'ci-triage', 'attention', 'owner-created', 'owner-updated', 'owner-retired']) {
    await notebook.journal({ kind, note: `${kind} context` });
  }
  await notebook.journal({ kind: 'chat-decision', note: 'cancelled choice', quote: 'original words' });
  await notebook.journal({ kind: 'retracted', note: 'cancelled choice' });
  await notebook.journal({ kind: 'chat-decision', note: 'keep the new choice', quote: 'fresh person words' });
  await notebook.journal({ kind: 'unrelated-tool-noise', note: 'exclude this' });
  await appendFile(journalPath(runtime), 'broken json\n{"kind":"unfinished');
  await writeFile(journalPath(runtime, '2000-01-01'), JSON.stringify({ at: '2000-01-01T00:00:00Z', kind: 'answered', note: 'ancient' }) + '\n');
  const activity = await recentActivityContext(runtime, 'homelab');
  assert.match(activity, /answered context/);
  assert.match(activity, /owner-retired context/);
  assert.match(activity, /fresh person words/);
  assert.doesNotMatch(activity, /ancient|exclude this|original words/);
  const decisions = await recentChatDecisions(runtime, 'homelab');
  assert.match(decisions, /keep the new choice/);
  assert.match(decisions, /"kind":"retracted"/);
  assert.doesNotMatch(decisions, /original words|answered context/);
});

test('context caps entries and characters deterministically and scans only complete records inside the byte budget', async () => {
  const { runtime, notebook } = await fixture();
  const policy = runtime.declarations.owners.get('homelab')!.chatContext;
  Object.assign(policy, { maxEntries: 2, maxChars: 300, entryChars: 150 });
  for (const note of ['oldest', 'middle', 'newest']) await notebook.journal({ kind: 'answered', note: `${note} ${'x'.repeat(500)}` });
  const first = await recentActivityContext(runtime, 'homelab');
  assert.equal(first, await recentActivityContext(runtime, 'homelab'));
  assert.ok(first.length <= 300);
  assert.equal(first.split('\n').length, 2);
  assert.doesNotMatch(first, /oldest/);
  assert.ok(first.indexOf('middle') < first.indexOf('newest'));
  policy.maxChars = 1;
  assert.equal((await recentActivityContext(runtime, 'homelab')).length, 1);
  policy.scanBytes = 10;
  assert.deepEqual(await recentJournal(runtime, 'homelab'), []);
  policy.scanBytes = 200;
  await notebook.journal({ kind: 'answered', note: 'complete small tail' });
  assert.deepEqual((await recentJournal(runtime, 'homelab')).map(entry => entry.note), ['complete small tail']);
});

test('askOwner gives the answering hire undistilled person choices and durably records its exchange', async () => {
  const { runtime, notebook } = await fixture();
  await runtime.notebook('clippy').ensure('# Asking owner');
  const owner = runtime.declarations.owners.get('homelab')!;
  owner.domain = { kind: 'incus', ...owner.incus! };
  owner.incus = undefined;
  runtime.incus = { run: async () => '[]' };
  await notebook.journal({ kind: 'chat-decision', note: 'Use the smaller server', quote: 'Choose the small one' });
  runtime.hire = async <Output>(_owner: string, request: HireRequest<Output>) => {
    assert.match(request.brief, /recent-person-decisions/);
    assert.match(request.brief, /Use the smaller server/);
    const value = request.schema.parse({ answer: 'The person chose the smaller server.', observed: ['Recent person decision: Choose the small one'], inferred: [], unknown: [] });
    const at = new Date().toISOString();
    return { value, sessionID: 'scripted-answer', cost: 0, startedAt: at, finishedAt: at };
  };
  const answer = await askOwner(runtime, 'clippy', 'Miles Teg', 'Which server should we use?');
  assert.match(answer.answer.answer, /smaller server/);
  assert.doesNotMatch(await notebook.orientation(), /Use the smaller server/);
  const [notice] = await records(runtime, 'pending');
  assert.match(notice!.text, /Which server should we use/);
  assert.match(notice!.text, /Observed:[\s\S]*Choose the small one/);
  assert.ok((await recentJournal(runtime, 'homelab')).some(entry => entry.kind === 'answered'));
});

test('durable notices discover pre-feature person chats and choose latest person activity without waking a model', async () => {
  const { runtime } = await fixture();
  const fake = transport();
  fake.chat('old', 10, 100);
  fake.messages.get('old')!.push(message('old-runtime', 100, `${NOTICE_PREFIX} work finished`));
  fake.chat('latest-person', 20, 20);
  fake.chat('watcher', 200, 200, 'latest-person');
  fake.chat('unrelated-agent', 300, 300, undefined, 'someone-else');
  await queueExchangeNotice(runtime, 'homelab', 'Question and answer');
  await deliverExchangeNotices(runtime, fake.client);
  assert.equal(fake.posted.length, 1);
  assert.equal(fake.posted[0]!.target.sessionID, 'latest-person');
  assert.equal(fake.posted[0]!.body.noReply, true);
  assert.equal(fake.posted[0]!.body.agent, 'Miles Teg');
  assert.match(fake.posted[0]!.body.parts[0]!.text, /^\[onionsoup notice\]/);
  assert.equal((await records(runtime, 'pending')).length, 0);
  assert.equal((await records(runtime, 'delivered'))[0]!.target!.sessionID, 'latest-person');
});

test('notices wait for a real idle person chat, retry transport failures, and reconcile accepted posts after restart', async () => {
  const { runtime, state } = await fixture();
  const fake = transport();
  const errors: unknown[] = [];
  const deliver = () => deliverExchangeNotices(runtime, fake.client, (_id, error) => errors.push(error));
  await queueExchangeNotice(runtime, 'homelab', 'A durable exchange');
  await deliver();
  assert.equal((await records(runtime, 'pending')).length, 1);
  fake.chat('person', 1);
  fake.state.isIdle = false;
  await deliver();
  assert.equal(fake.posted.length, 0);
  fake.state.isIdle = true;
  fake.state.failBefore = true;
  await deliver();
  assert.equal(errors.length, 1);
  fake.state.failBefore = false;
  fake.state.failAfter = true;
  await deliver();
  assert.equal(fake.posted.length, 1);
  assert.equal((await records(runtime, 'pending')).length, 1);
  fake.chat('newer-person', 2);
  const reopened = await Runtime.open({ declarations, state });
  await Promise.all([deliverExchangeNotices(reopened, fake.client), deliverExchangeNotices(runtime, fake.client)]);
  assert.equal(fake.posted.length, 1);
  assert.equal((await records(runtime, 'delivered')).length, 1);
});

test('notice excerpts stay bounded while durable records preserve the complete answer and evidence', async () => {
  const { runtime } = await fixture();
  runtime.declarations.owners.get('homelab')!.chatContext.noticeChars = 20;
  const fake = transport();
  fake.chat('person', 1);
  const full = `Question\n${'long answer '.repeat(100)}\nObserved: full evidence`;
  const notice = await queueExchangeNotice(runtime, 'homelab', full);
  await deliverExchangeNotices(runtime, fake.client);
  const displayed = fake.posted[0]!.body.parts[0]!.text;
  assert.match(displayed, /Full exchange record:/);
  assert.ok(displayed.includes(notice.id));
  assert.doesNotMatch(displayed, /Observed: full evidence/);
  assert.equal((await records(runtime, 'delivered'))[0]!.text, full);
});

test('production exchange adapter uses the synchronous noReply endpoint', async () => {
  let sent: unknown;
  const client = { session: { prompt: async (request: unknown) => { sent = request; return { data: {} }; } } };
  await exchangeClient(client as unknown as Parameters<Plugin>[0]['client']).post({ sessionID: 'person', directory: '/desk' }, {
    agent: 'Miles Teg', noReply: true, messageID: 'msg_stable', parts: [{ type: 'text', text: `${NOTICE_PREFIX} exchange` }],
  });
  assert.equal((sent as { body: { noReply: boolean } }).body.noReply, true);
});

test('plugin rereads recent activity on every system transform and its watcher never hires for runtime notices', async () => {
  const { runtime, notebook, state } = await fixture();
  let watcherCreates = 0;
  const fake = transport();
  fake.chat('person', 1);
  const client = { session: {
    messages: async () => ({ data: fake.messages.get('person') }),
    create: async () => { watcherCreates += 1; throw new Error('watcher_must_not_wake'); },
  } };
  const originalSandbox = process.env.ONIONSOUP_SANDBOX;
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  assert.equal(process.env.ONIONSOUP_SANDBOX, originalSandbox);
  await hooks['chat.message']!({ sessionID: 'person', agent: 'Miles Teg' }, {} as never);
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'person' } } });
  assert.equal(watcherCreates, 1, 'ordinary person messages reach the watcher hire seam');
  await queueExchangeNotice(runtime, 'homelab', 'Question and answer from another owner');
  await deliverExchangeNotices(runtime, fake.client);
  await notebook.journal({ kind: 'answered', note: 'An exchange outside this chat' });
  const first = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']!({ sessionID: 'person' } as never, first);
  assert.match(first.system.join('\n'), /An exchange outside this chat/);
  await notebook.journal({ kind: 'work-status', note: 'New work finished between turns' });
  const next = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']!({ sessionID: 'person' } as never, next);
  assert.match(next.system.join('\n'), /New work finished between turns/);
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'person' } } });
  assert.equal(watcherCreates, 1, 'a delivered runtime notice must not hire the watcher');
  assert.ok(!(await recentJournal(runtime, 'homelab')).some(entry => entry.kind === 'chat-decision'));
});

test('unreadable structured-output hire sessions do not prevent delivery to a real person chat', async () => {
  const { runtime } = await fixture();
  const fake = transport();
  fake.chat('person', 10);
  fake.chat('structured-answer-hire', 20);
  const original = fake.client.messages;
  fake.client.messages = async target => {
    if (target.sessionID === 'structured-answer-hire') throw new Error('BadRequest: Expected OutputFormatJsonSchema');
    return original(target);
  };
  const errors: string[] = [];
  await queueExchangeNotice(runtime, 'homelab', 'A new owner answer');
  await deliverExchangeNotices(runtime, fake.client, id => errors.push(id));
  assert.deepEqual(errors, ['session:structured-answer-hire']);
  assert.equal(fake.posted[0]!.target.sessionID, 'person');
  assert.equal((await records(runtime, 'delivered')).length, 1);
});

test('configured session search limits defer notices until a person chat is inside the lookup window', async () => {
  const { runtime } = await fixture();
  const policy = runtime.declarations.owners.get('homelab')!.chatContext;
  policy.noticeSessions = 1;
  const fake = transport();
  fake.chat('person', 1);
  fake.chat('another-agent', 2, 2, undefined, 'other');
  await queueExchangeNotice(runtime, 'homelab', 'Bounded search');
  await deliverExchangeNotices(runtime, fake.client);
  assert.equal(fake.posted.length, 0);
  assert.equal((await records(runtime, 'pending')).length, 1);
  policy.noticeSessions = 2;
  await deliverExchangeNotices(runtime, fake.client);
  assert.equal(fake.posted[0]!.target.sessionID, 'person');
});

test('a later explicit decision can reaffirm a retracted statement without reviving its earlier quote', async () => {
  const { runtime, notebook } = await fixture();
  await notebook.journal({ kind: 'chat-decision', note: 'Choose option A', quote: 'original choice' });
  await notebook.journal({ kind: 'retracted', note: 'Choose option A' });
  await notebook.journal({ kind: 'chat-decision', note: 'Choose option A', quote: 'I reaffirm option A now' });
  const decisions = await recentChatDecisions(runtime, 'homelab');
  assert.match(decisions, /I reaffirm option A now/);
  assert.doesNotMatch(decisions, /original choice/);
});

test('retired and personless owners archive pending notices with a reason instead of retrying forever', async () => {
  const { runtime } = await fixture();
  const fake = transport();
  runtime.declarations.owners.set('retired-owner', { ...runtime.declarations.owners.get('homelab')!, id: 'retired-owner' });
  await queueExchangeNotice(runtime, 'retired-owner', 'No longer deliverable');
  runtime.declarations.owners.delete('retired-owner');
  await deliverExchangeNotices(runtime, fake.client);
  assert.equal((await records(runtime, 'pending')).length, 0);
  assert.equal((await records(runtime, 'undeliverable'))[0]!.undeliverableReason, 'owner_retired');
  await queueExchangeNotice(runtime, 'clippy', 'Legacy personless notice');
  await deliverExchangeNotices(runtime, fake.client);
  assert.ok((await records(runtime, 'undeliverable')).some(notice => notice.undeliverableReason === 'owner_has_no_persona'));
  assert.equal(fake.posted.length, 0);
});

test('unreadable optional journal context is diagnosed without breaking a chat turn', async context => {
  const { runtime, notebook } = await fixture();
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  await rm(join(notebook.directory, 'journal'), { recursive: true });
  await writeFile(join(notebook.directory, 'journal'), 'not a directory');
  assert.equal(await recentActivityContext(runtime, 'homelab'), '');
  assert.equal(await recentChatDecisions(runtime, 'homelab'), '');
  assert.match(String(warnings[0]![0]), /recent_context_unavailable: homelab/);
});

test('declared context defaults and age filtering apply within a current journal file', async () => {
  const { runtime, notebook } = await fixture();
  const original = runtime.declarations.owners.get('homelab')!;
  const owner = OwnerDeclaration.parse({ ...original, chatContext: { ageHours: 1, maxEntries: 3 } });
  assert.equal(owner.chatContext.maxChars, 8000);
  assert.equal(owner.chatContext.maxEntries, 3);
  assert.throws(() => OwnerDeclaration.parse({ ...original, chatContext: { ageHours: 0 } }));
  runtime.declarations.owners.set(owner.id, owner);
  const now = Date.now();
  const rows = [
    { at: new Date(now - 7_200_000).toISOString(), kind: 'answered', note: 'too old in a new file' },
    { at: new Date(now + 60_000).toISOString(), kind: 'answered', note: 'future timestamp' },
  ];
  await writeFile(journalPath(runtime), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await notebook.journal({ kind: 'attention-decision', note: 'resolved attention' });
  const activity = await recentActivityContext(runtime, 'homelab');
  assert.match(activity, /resolved attention/);
  assert.doesNotMatch(activity, /too old|future timestamp/);
});

test('a stale plugin reloads unknown owner declarations before archiving their notices', async () => {
  const { runtime } = await fixture();
  const fake = transport();
  fake.chat('person', 1);
  await queueExchangeNotice(runtime, 'homelab', 'Owner declared after plugin startup');
  runtime.declarations.owners.delete('homelab');
  await deliverExchangeNotices(runtime, fake.client);
  assert.equal((await records(runtime, 'undeliverable')).length, 0);
  assert.equal((await records(runtime, 'delivered')).length, 1);
});
