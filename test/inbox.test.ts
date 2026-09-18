import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { refreshInbox } from '../src/inbox.ts';
import { observe, type Source } from '../src/inbox-source.ts';
import { loadConfig, loadAttempts, loadIndex, attemptPath, atomicJson, recoverInbox, withInboxLock } from '../src/inbox-store.ts';
import { renderInbox } from '../src/inbox-report.ts';
import { fixtureModel } from '../src/fixture-model.ts';

const repo = 'example/widget';
const at = '2026-09-18T12:00:00Z';
const later = '2026-09-18T13:00:00Z';
const response = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable',
  summary: 'Requests a dark theme.', evidence: [], questions: [] };
function raw(number = 1, extra = {}) { return { number, title: 'Add dark mode', body: 'Please add dark mode.',
  state: 'open', updated_at: at, comments: 0, ...extra }; }
async function fixture(rows = [raw()], responses: unknown[] = Array(20).fill(response)) {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-inbox-test-'));
  const model = fixtureModel(responses);
  const data = { rows, reads: 0 };
  const source: Source = {
    scan: async () => ({ observations: data.rows.flatMap(r => { const o = observe(r, repo, new Date().toISOString()); return o ? [o] : []; }), entries: data.rows.length, windowFull: false }),
    get: async (_, number) => { data.reads++; return observe(data.rows.find(r => r.number === number), repo, new Date().toISOString())!; },
  };
  const modelFactory = async (modelId = 'gpt-5.6-terra', provider: 'copilot' | 'codex' = 'copilot') => ({ modelId, provider, model });
  const options = { source, modelFactory };
  const records = async () => loadAttempts(directory, await loadConfig(directory));
  return { directory, model, data, source, options, records };
}

test('unchanged text and metadata-only changes reuse the original assessment; edits keep both revisions', async () => {
  const f = await fixture();
  const first = await refreshInbox(f.directory, repo, f.options);
  assert.equal(first.completed, 1);
  const original = (await f.records())[0];
  const originalBytes = await readFile(attemptPath(f.directory, original), 'utf8');
  const second = await refreshInbox(f.directory, repo, f.options);
  assert.equal(second.attempted, 0); assert.equal(f.model.doStreamCalls.length, 1);
  f.data.rows = [raw(1, { updated_at: later, comments: 5 })];
  assert.equal((await refreshInbox(f.directory, repo, f.options)).attempted, 0);
  f.data.rows = [raw(1, { updated_at: later, body: 'Please add a high contrast theme.' })];
  assert.equal((await refreshInbox(f.directory, repo, f.options)).completed, 1);
  assert.equal((await f.records()).length, 2);
  assert.equal(f.model.doStreamCalls.length, 2);
  assert.equal(await readFile(attemptPath(f.directory, original), 'utf8'), originalBytes);
});

test('caps point reads and model calls, queues remaining reports, excludes PRs and invalid snapshots', async () => {
  const f = await fixture([raw(1), raw(2), raw(3), raw(4, { pull_request: {} }), raw(5, { body: 'x'.repeat(24001) })]);
  const first = await refreshInbox(f.directory, repo, { ...f.options, maxIssues: 1 });
  assert.equal(first.attempted, 1); assert.equal(first.pointReads, 1);
  let summary = await renderInbox(f.directory);
  assert.equal(summary.counts.waiting, 2); assert.equal(summary.counts.attention, 1);
  assert.equal((await loadIndex(f.directory, await loadConfig(f.directory))).observations.length, 4);
  assert.equal((await refreshInbox(f.directory, repo, { ...f.options, maxIssues: 0 })).attempted, 0);
  assert.equal(f.model.doStreamCalls.length, 1);
  assert.equal((await refreshInbox(f.directory, repo, { ...f.options, maxIssues: 2 })).completed, 2);
  summary = await renderInbox(f.directory); assert.equal(summary.counts.waiting, 0);
});

test('fresh point read observes closures or edits before assessment and rejects stale responses', async () => {
  const f = await fixture([raw(1), raw(2), raw(3)]);
  f.source.get = async (_, n) => observe(raw(n, n === 1 ? { state: 'closed', updated_at: later } :
    n === 2 ? { body: 'Edited before the call', updated_at: later } : { updated_at: '2026-09-17T12:00:00Z' }), repo, later)!;
  const result = await refreshInbox(f.directory, repo, { ...f.options, maxIssues: 3 });
  assert.equal(result.completed, 1); assert.equal(result.pointReads, 3);
  assert.equal((await f.records())[0].record.input.body, 'Edited before the call');
  const summary = await renderInbox(f.directory);
  assert.equal(summary.counts.closed, 1); assert.equal(summary.counts.waiting, 1);
  assert.equal(result.warning, 'stale_source_response');
});

test('failures are preserved and not auto-retried; explicit retry appends another attempt', async () => {
  const f = await fixture([raw()], [{ bad: true }, { bad: true }, { bad: true }, response]);
  assert.equal((await refreshInbox(f.directory, repo, f.options)).failed, 1);
  const old = (await f.records())[0]; const before = await readFile(attemptPath(f.directory, old), 'utf8');
  assert.equal((await refreshInbox(f.directory, repo, f.options)).attempted, 0);
  assert.equal(f.model.doStreamCalls.length, 3);
  assert.equal((await refreshInbox(f.directory, repo, { ...f.options, retryIssue: 1 })).completed, 1);
  assert.equal((await f.records()).length, 2);
  assert.equal(await readFile(attemptPath(f.directory, old), 'utf8'), before);
  assert.equal((await refreshInbox(f.directory, repo, { ...f.options, retryIssue: 1 })).attempted, 0);
});

test('concurrent refresh is rejected and cancellation stops additional admission', async () => {
  const f = await fixture([raw(1), raw(2)]);
  await withInboxLock(f.directory, async () => {
    await assert.rejects(refreshInbox(f.directory, repo, f.options), /locked/);
    assert.equal(f.model.doStreamCalls.length, 0);
  });
  const controller = new AbortController();
  const result = await refreshInbox(f.directory, repo, { ...f.options, signal: controller.signal,
    onProgress: () => controller.abort() });
  assert.equal(result.status, 'interrupted'); assert.equal(result.attempted, 1);
  assert.equal((await refreshInbox(f.directory, repo, f.options)).completed, 1);
  assert.equal(f.model.doStreamCalls.length, 2);
});

test('source failure never spends tokens on a stale queue and logs no raw credentials', async () => {
  const f = await fixture();
  await refreshInbox(f.directory, repo, { ...f.options, maxIssues: 0 });
  f.source.scan = async () => { throw new Error('Authorization: secret-test-token'); };
  const result = await refreshInbox(f.directory, repo, f.options);
  assert.equal(result.status, 'failed'); assert.equal(result.warning, 'source_error');
  assert.equal(f.model.doStreamCalls.length, 0);
  const summary = await renderInbox(f.directory); assert.equal(summary.counts.waiting, 1);
  for (const name of await readdir(join(f.directory, 'refreshes')))
    assert.ok(!(await readFile(join(f.directory, 'refreshes', name), 'utf8')).includes('secret-test-token'));
});

test('refresh deadline aborts a pending source request without admitting model work', async () => {
  const f = await fixture();
  f.source.scan = async (_, __, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Keep the test process alive while AbortSignal's unref'ed deadline runs.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const result = await refreshInbox(f.directory, repo, { ...f.options, maxSeconds: 1 });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.warning, 'time_limit_or_cancelled');
    assert.equal(f.model.doStreamCalls.length, 0);
  } finally { clearInterval(keepAlive); }
});

test('explicit recovery refuses live locks, retains interrupted attempts, and makes no model calls', async () => {
  const f = await fixture();
  await refreshInbox(f.directory, repo, f.options);
  const a = (await f.records())[0]; a.record.status = 'running'; delete a.record.assessment; delete a.record.finishedAt;
  await atomicJson(attemptPath(f.directory, a), a);
  assert.equal((await refreshInbox(f.directory, repo, f.options)).attempted, 0);
  await writeFile(join(f.directory, '.refresh.lock'), JSON.stringify({ pid: process.pid, host: hostname() }));
  await assert.rejects(recoverInbox(f.directory), /still alive/);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const deadPid = child.pid!;
  await once(child, 'exit');
  await writeFile(join(f.directory, '.refresh.lock'), JSON.stringify({ pid: deadPid, host: hostname() }));
  assert.equal(await recoverInbox(f.directory), 1);
  assert.equal((await f.records())[0].record.failure, 'interrupted_process');
  assert.equal(f.model.doStreamCalls.length, 1);
  assert.equal((await refreshInbox(f.directory, repo, f.options)).attempted, 0);
});

test('wrong configuration or corrupt persisted record stops before more model calls', async () => {
  const f = await fixture();
  await refreshInbox(f.directory, repo, f.options);
  await assert.rejects(refreshInbox(f.directory, 'other/repo', f.options), /configuration\/runtime/);
  const a = (await f.records())[0]; a.record.inputHash = 'tampered';
  await atomicJson(attemptPath(f.directory, a), a);
  await assert.rejects(refreshInbox(f.directory, repo, f.options), /Invalid inbox attempt/);
  assert.equal(f.model.doStreamCalls.length, 1);
});

test('report keeps source text inert, distinguishes request kinds, and exposes partial scan coverage', async () => {
  const payload = '</script><img src=x onerror=alert(1)>';
  const f = await fixture([raw(1, { title: payload, body: payload })]);
  const original = f.source.scan;
  f.source.scan = async (...args) => ({ ...await original(...args), windowFull: true });
  await refreshInbox(f.directory, repo, f.options);
  const summary = await renderInbox(f.directory);
  assert.equal(summary.counts.feature_request, 1); assert.equal(summary.windowFull, true);
  const html = await readFile(join(f.directory, 'index.html'), 'utf8');
  assert.ok(!html.includes(payload)); assert.match(html, /&lt;img/);
  assert.match(html, /older updates may be outside this window/);
  assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*)<\/script>/)![1]));
  assert.equal(summary.quotaConsumed, null); assert.equal(summary.billedCost, null);
});
