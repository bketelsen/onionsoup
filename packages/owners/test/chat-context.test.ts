import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { askOwner } from '../src/ask.ts';
import { recentActivityContext, recentChatDecisions, recentJournal } from '../src/chat-context.ts';
import { OwnerDeclaration } from '../src/declarations.ts';
import { NOTICE_PREFIX } from '../src/notices.ts';
import type { HireRequest } from '../src/opencode.ts';
import type { TranscriptMessage } from '../src/transcript-client.ts';
import { withActiveHooks } from './active-hooks.ts';
import { Runtime } from '../src/runtime.ts';

const declarations = 'packages/owners/test/fixtures/owners';
async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-context-test-'));
  const runtime = await Runtime.open({ declarations, state });
  const notebook = runtime.notebook('homelab');
  await notebook.ensure('# Test charter');
  return { runtime, notebook, state };
}

function journalPath(runtime: Runtime, date = new Date().toISOString().slice(0, 10)) {
  return join(runtime.notebook('homelab').directory, 'journal', `${date}.jsonl`);
}

function message(id: string, created: number, text: string, agent = 'Miles Teg'): TranscriptMessage {
  return { info: { id, role: 'user', agent, time: { created } }, parts: [{ type: 'text', text }] };
}

test('recent activity includes autonomous work and fresh decisions, honors retractions, and ignores old or malformed records', async () => {
  const { runtime, notebook } = await fixture();
  for (const kind of ['asked', 'answered', 'work-status', 'ci-triage', 'attention', 'attention-condition', 'owner-created', 'owner-updated', 'owner-retired']) {
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
  assert.ok((await recentJournal(runtime, 'homelab')).some(entry => entry.kind === 'answered' && entry.note?.includes('Which server should we use')));
  assert.ok((await recentJournal(runtime, 'clippy')).some(entry => entry.kind === 'asked'));
});

test('plugin rereads recent activity on every system transform and its watcher never hires for runtime notices', async () => {
  const { runtime, notebook, state } = await fixture();
  let watcherCreates = 0;
  const session = { id: 'person', directory: '/test/owner-desk', time: { updated: 1 } };
  const transcript = [message('person-hello', 1, 'hello')];
  const client = { session: {
    status: async () => ({ data: {} }),
    children: async () => ({ data: [] }),
    get: async ({ path }: { path: { id: string } }) => ({ data: path.id === session.id ? session : undefined }),
    messages: async () => ({ data: transcript }),
    create: async () => { watcherCreates += 1; throw new Error('watcher_must_not_wake'); },
  } };
  const originalSandbox = process.env.ONIONSOUP_SANDBOX;
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  assert.equal(process.env.ONIONSOUP_SANDBOX, originalSandbox);
  await hooks['chat.message']!({ sessionID: 'person', agent: 'Miles Teg' }, {} as never);
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'person' } } });
  assert.equal(watcherCreates, 1, 'ordinary person messages reach the watcher hire seam');
  transcript.push(message('runtime-notice', 2, `${NOTICE_PREFIX} work finished`));
  await notebook.journal({ kind: 'answered', note: 'An exchange outside this chat' });
  const first = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']!({ sessionID: 'person' } as never, first);
  assert.match(first.system.join('\n'), /An exchange outside this chat/);
  await notebook.journal({ kind: 'work-status', note: 'New work finished between turns' });
  const next = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']!({ sessionID: 'person' } as never, next);
  assert.match(next.system.join('\n'), /New work finished between turns/);
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'person' } } });
  assert.equal(watcherCreates, 1, 'a runtime notice must not hire the watcher');
  assert.ok(!(await recentJournal(runtime, 'homelab')).some(entry => entry.kind === 'chat-decision'));
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

