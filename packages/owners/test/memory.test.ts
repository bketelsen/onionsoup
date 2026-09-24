import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { distill, distillIsDue, memoryStatus, requestDistill } from '../src/memory.ts';
import { drain, scheduleMemory, type TickLog } from '../src/daemon.ts';
import type { HireRequest } from '../src/opencode.ts';

async function fixture() {
  const state = await mkdtemp('/tmp/onionsoup-memory-test-');
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state });
  const notebook = runtime.notebook('clippy');
  await notebook.ensure('# Charter\nMemory test\n');
  const briefs: string[] = [];
  const script = { run: async () => ({ notebook: [] as unknown[] }) };
  runtime.hire = async <Output>(_owner: string, request: HireRequest<Output>) => {
    briefs.push(request.brief);
    const value = request.schema.parse(await script.run());
    const at = new Date().toISOString();
    return { value, sessionID: 'scripted-memory', cost: 0, startedAt: at, finishedAt: at };
  };
  return { runtime, notebook, briefs, script };
}

test('distillation leaves entries appended during the hire for the next snapshot', async () => {
  const { runtime, notebook, briefs, script } = await fixture();
  await notebook.journal({ kind: 'chat-decision', note: 'first decision' });
  script.run = async () => {
    await notebook.journal({ kind: 'chat-decision', note: 'concurrent decision' });
    return { notebook: [{ register: 'decisions', section: 'Preference', mode: 'append', text: 'first decision' }] };
  };
  const first = await distill(runtime, 'clippy');
  assert.equal(first.entries, 1);
  assert.equal(first.cursor?.line, 1);
  assert.doesNotMatch(briefs[0]!, /concurrent decision/);
  assert.match(await notebook.read(['decisions']), /first decision/);
  script.run = async () => ({ notebook: [] });
  const second = await distill(runtime, 'clippy');
  assert.equal(second.entries, 1);
  assert.equal(second.cursor?.line, 2);
  assert.match(briefs[1]!, /concurrent decision/);
});

test('failed distillation retains the cursor and queued request, backs off, and retries', async () => {
  const { runtime, notebook, script } = await fixture();
  await notebook.journal({ kind: 'chat-decision', note: 'retain this' });
  await requestDistill(runtime, 'clippy', 'person');
  script.run = async () => { throw new Error('scripted_hire_failed'); };
  await assert.rejects(distill(runtime, 'clippy'), /scripted_hire_failed/);
  const failed = await memoryStatus(runtime, 'clippy');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.queued, true);
  assert.equal(failed.cursor, undefined);
  assert.match(failed.error!, /scripted_hire_failed/);
  assert.equal(await distillIsDue(runtime, 'clippy'), false);
  const retryAt = Date.parse(failed.lastAttempt!) + runtime.owner('clippy').memory.retryMs + 1;
  assert.equal(await distillIsDue(runtime, 'clippy', retryAt), true);
  script.run = async () => ({ notebook: [] });
  await distill(runtime, 'clippy');
  const completed = await memoryStatus(runtime, 'clippy');
  assert.equal(completed.status, 'idle');
  assert.equal(completed.queued, false);
  assert.equal(completed.cursor?.line, 1);
});

test('empty notebooks and consumed journals never hire a model', async () => {
  const { runtime, notebook, briefs } = await fixture();
  assert.equal(await distillIsDue(runtime, 'clippy'), false);
  await requestDistill(runtime, 'clippy', 'person');
  await distill(runtime, 'clippy');
  assert.equal(briefs.length, 0);
  assert.equal((await memoryStatus(runtime, 'clippy')).queued, false);
  await notebook.journal({ kind: 'chat-decision', note: 'one entry' });
  await distill(runtime, 'clippy');
  await distill(runtime, 'clippy');
  assert.equal(briefs.length, 1);
});

test('bounded batches advance by line even when timestamps match and manual requests bypass disabled automation', async () => {
  const { runtime, notebook } = await fixture();
  const owner = runtime.declarations.owners.get('clippy')!;
  owner.memory = { ...owner.memory, enabled: false, maxEntries: 1 };
  const path = join(notebook.directory, 'journal', '2026-09-23.jsonl');
  const lines = ['first', 'second'].map(note => JSON.stringify({ at: '2026-09-23T12:00:00Z', kind: 'chat-decision', note }));
  await writeFile(path, lines.join('\n') + '\n');
  assert.equal(await distillIsDue(runtime, 'clippy'), false);
  await requestDistill(runtime, 'clippy', 'person');
  assert.equal(await distillIsDue(runtime, 'clippy'), true);
  assert.equal((await distill(runtime, 'clippy')).cursor?.line, 1);
  assert.equal((await distill(runtime, 'clippy')).cursor?.line, 2);
});

test('a manual request arriving during a hire stays queued and the scheduler does not block', async () => {
  const { runtime, notebook, script, briefs } = await fixture();
  await notebook.journal({ kind: 'chat-decision', note: 'remember' });
  await requestDistill(runtime, 'clippy', 'person');
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  script.run = async () => {
    started();
    await pending;
    return { notebook: [] };
  };
  const errors: unknown[] = [];
  const log: TickLog = { duty() {}, item() {}, request() {}, error: (_context, error) => { errors.push(error); } };
  await scheduleMemory(runtime, log, new Set(['clippy']));
  assert.equal(briefs.length, 0);
  await scheduleMemory(runtime, log);
  await entered;
  await scheduleMemory(runtime, log);
  assert.equal(briefs.length, 1);
  await requestDistill(runtime, 'clippy', 'another person');
  release();
  await drain();
  assert.deepEqual(errors, []);
  assert.equal((await memoryStatus(runtime, 'clippy')).queued, true);
});

test('legacy timestamp cursors migrate without replaying previously consumed entries', async () => {
  const { runtime, notebook, briefs } = await fixture();
  const marker = '2026-09-23T12:00:00Z';
  await writeFile(join(runtime.stateDirectory, 'distill-clippy.txt'), marker);
  const entries = [marker, '2026-09-23T12:01:00Z'].map(at => JSON.stringify({ at, kind: 'chat-decision', note: at }));
  await writeFile(join(notebook.directory, 'journal', '2026-09-23.jsonl'), entries.join('\n') + '\n');
  await distill(runtime, 'clippy');
  assert.equal((await memoryStatus(runtime, 'clippy')).cursor?.line, 2);
  assert.doesNotMatch(briefs[0]!, /12:00:00Z/);
  assert.match(await readFile(join(runtime.stateDirectory, 'memory/clippy/state.json'), 'utf8'), /12:01|cursor/);
});

test('manual batches stay queued until drained and automatic backlogs use the shorter batch delay', async () => {
  const { runtime, notebook } = await fixture();
  const owner = runtime.declarations.owners.get('clippy')!;
  owner.memory.maxEntries = 1;
  await notebook.journal({ kind: 'chat-decision', note: 'first' });
  await notebook.journal({ kind: 'chat-decision', note: 'second' });
  await requestDistill(runtime, 'clippy', 'person');
  await distill(runtime, 'clippy');
  const partial = await memoryStatus(runtime, 'clippy');
  assert.equal(partial.hasMore, true);
  assert.equal(partial.queued, true);
  assert.equal(await distillIsDue(runtime, 'clippy'), true);
  await distill(runtime, 'clippy');
  assert.equal((await memoryStatus(runtime, 'clippy')).queued, false);
  await notebook.journal({ kind: 'chat-decision', note: 'third' });
  await notebook.journal({ kind: 'chat-decision', note: 'fourth' });
  await distill(runtime, 'clippy');
  const automatic = await memoryStatus(runtime, 'clippy');
  const nextBatch = Date.parse(automatic.lastAttempt!) + owner.memory.batchDelayMs + 1;
  assert.equal(await distillIsDue(runtime, 'clippy', nextBatch), true);
});

test('disappearing queue entries cannot rewind a successfully consumed cursor', async () => {
  const { runtime, notebook, script, briefs } = await fixture();
  await notebook.journal({ kind: 'chat-decision', note: 'exactly once in this run' });
  await requestDistill(runtime, 'clippy', 'person');
  script.run = async () => {
    const queue = join(runtime.stateDirectory, 'memory/clippy/queue');
    for (const file of await readdir(queue)) await unlink(join(queue, file));
    return { notebook: [] };
  };
  await distill(runtime, 'clippy');
  assert.equal((await memoryStatus(runtime, 'clippy')).cursor?.line, 1);
  await distill(runtime, 'clippy');
  assert.equal(briefs.length, 1);
});

test('interrupted memory jobs expose a retryable failure instead of a permanently running control', async () => {
  const { runtime } = await fixture();
  await requestDistill(runtime, 'clippy', 'person');
  await writeFile(join(runtime.stateDirectory, 'memory/clippy/state.json'), JSON.stringify({
    status: 'running', lastAttempt: '2026-01-01T00:00:00Z', activeRunner: 2147483647,
  }));
  const status = await memoryStatus(runtime, 'clippy');
  assert.equal(status.status, 'failed');
  assert.match(status.error!, /distill_interrupted/);
  assert.equal(await distillIsDue(runtime, 'clippy'), true);
});

test('housekeeping advances deterministically without a memory hire', async () => {
  const { runtime, notebook, briefs } = await fixture();
  await notebook.journal({ kind: 'app-updates', note: 'no updates' });
  await notebook.journal({ kind: 'maintain-prs', note: 'all green' });
  assert.equal(await distillIsDue(runtime, 'clippy'), true);
  await distill(runtime, 'clippy');
  const status = await memoryStatus(runtime, 'clippy');
  assert.equal(status.cursor?.line, 2);
  assert.equal(status.lastCompleted, undefined);
  assert.equal(briefs.length, 0);
  assert.equal(await distillIsDue(runtime, 'clippy'), false);
});

test('invalid journal entries preserve earlier batches and surface a backed-off failure with location', async () => {
  const { runtime, notebook, briefs } = await fixture();
  const path = join(notebook.directory, 'journal', '2026-09-23.jsonl');
  const valid = JSON.stringify({ at: '2026-09-23T12:00:00Z', kind: 'chat-decision', note: 'valid first' });
  await writeFile(path, `${valid}\ninvalid-json\n`);
  await distill(runtime, 'clippy');
  assert.equal((await memoryStatus(runtime, 'clippy')).cursor?.line, 1);
  const future = Date.now() + runtime.owner('clippy').memory.batchDelayMs + 1;
  assert.equal(await distillIsDue(runtime, 'clippy', future), true);
  await assert.rejects(distill(runtime, 'clippy'), /memory_entry_invalid: 2026-09-23.jsonl:2/);
  assert.match((await memoryStatus(runtime, 'clippy')).error!, /memory_entry_invalid/);
  assert.equal(await distillIsDue(runtime, 'clippy'), false);
  assert.equal(briefs.length, 1);
});

test('disabled automation without a queued request never promises a retry', async () => {
  const { runtime, notebook, script } = await fixture();
  runtime.declarations.owners.get('clippy')!.memory.enabled = false;
  await notebook.journal({ kind: 'chat-decision', note: 'pending' });
  script.run = async () => { throw new Error('unavailable'); };
  await assert.rejects(distill(runtime, 'clippy'), /unavailable/);
  assert.equal((await memoryStatus(runtime, 'clippy')).nextAttemptAt, undefined);
});
