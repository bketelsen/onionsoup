import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { fixtureModel } from '../src/fixture-model.ts';
import { createBriefing, renderBriefing } from '../src/briefing.ts';
import { captureBriefingIssues } from '../src/briefing-intake.ts';
import { validateBriefing, type MaintenanceBriefing } from '../src/briefing-record.ts';
import { workflowEvents } from '../src/workflow-events.ts';
import { atomicJson } from '../src/batch-store.ts';
import { observe, type Source } from '../src/inbox-source.ts';
import { EVALUATION_MODEL } from '../src/evaluation-policy.ts';
const execute = promisify(execFile);
const repository = 'example/widget';
const issue = (number: number) => ({ schemaVersion: 1 as const, repository, number,
  updatedAt: '2026-09-18T12:00:00Z', title: '<script>bad</script> [link](https://bad.invalid)',
  body: 'Run export. Expected CSV. Error E42. Linux v1.' });
const observation = (number: number) => ({ number, title: issue(number).title, state: 'open' as const, updatedAt: issue(number).updatedAt,
  observedAt: '2026-09-18T13:00:00Z', commentsExcluded: 3, snapshot: issue(number) });
const source: Source = { scan: async () => ({ observations: [1,2,3,4,5].map(observation), entries: 5, windowFull: false }),
  get: async (_repo, number) => observation(number) };
const ready = { schemaVersion: 2, kind: 'bug_report', bug_readiness: 'ready', summary: 'Export fails.',
  evidence: ['reproduction', 'expected', 'actual', 'environment'].map((field,i) => ({ field, source: 'body',
    quote: ['Run export.', 'Expected CSV.', 'Error E42.', 'Linux v1.'][i] })), questions: [] };
const feature = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable', summary: 'Request', evidence: [], questions: [] };
function locationModel() {
  let next = 0;
  const calls = [
    ['search_repository', { query: 'exportCSV', scope: 'tests', pathPrefix: '' }],
    ['read_repository', { path: 'export.ts', startLine: 1, endLine: 1 }],
    ['read_repository', { path: 'export.test.ts', startLine: 1, endLine: 1 }],
    ['submit_brief', { status: 'located', codePointers: [{ excerptId: 'E1', startLine: 1, endLine: 1, symbol: 'exportCSV', reason: 'Export entry.' }],
      testPointers: [{ excerptId: 'E2', startLine: 1, endLine: 1, symbol: 'exportCSV', reason: 'Checks export.', relevance: 'adjacent' }],
      testSearch: { status: 'completed', reason: 'Read candidate.' }, uncertainties: ['Not reproduced.'] }],
  ];
  return new MockLanguageModelV3({ doStream: async () => {
    const call = calls[next++]; if (!call) throw new Error('Exhausted fixture');
    return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: String(next), toolName: call[0] as string, input: JSON.stringify(call[1]) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }],
      initialDelayInMs: null, chunkDelayInMs: null }) };
  } });
}
async function fixture(t: TestContext) {
  const checkout = await mkdtemp(join(tmpdir(), 'onionsoup-briefing-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const git = (...args: string[]) => execute('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  await git('init', '-q'); await git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
  await writeFile(join(checkout, 'export.ts'), 'export function exportCSV() { return "csv"; }\n');
  await writeFile(join(checkout, 'export.test.ts'), 'test("export", () => expect(exportCSV()).toBe("csv"));\n');
  await git('add', '.'); await git('commit', '-qm', 'fixture');
  let calls = 0;
  return { checkout, directory: join(checkout, 'output'), provider: 'copilot' as const, source,
    issueNumbers: [1,2,3,4,5], calls: () => calls,
    modelFactory: async () => ({ provider: 'copilot' as const, modelId: EVALUATION_MODEL,
      model: ++calls <= 5 ? fixtureModel([ready]) : locationModel() }) };
}

test('five ready reports reserve exactly seven attempts, locate first two, and render one correlated trace', async t => {
  const f = await fixture(t); const b = await createBriefing(repository, f);
  assert.equal(b.status, 'completed'); assert.equal(b.budget.consumed, 7); assert.equal(f.calls(), 7);
  assert.deepEqual(b.locations.map(l => l.disposition), ['handoff', 'handoff', 'selection_limit', 'selection_limit', 'selection_limit']);
  assert.ok(b.locations.slice(0,2).every(l => l.handoff?.disposition === 'located'));
  const events = workflowEvents(b).events;
  assert.equal(events.filter(e => e.type === 'workflow.started').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'workflow.budget_reserved').map(e => e.budget?.consumed), [1,2,3,4,5,6,7]);
  assert.equal(events.filter(e => e.type === 'agent.started').length, 7);
  assert.equal(new Set(events.flatMap(e => e.childWorkflowId ? [e.childWorkflowId] : [])).size, 3);
  assert.equal(events.filter(e => e.type === 'agent.reused').length, 2);
  assert.ok(!JSON.stringify(events).includes('Expected CSV'));
  const markdown = await readFile(join(f.directory, 'briefing.md'), 'utf8');
  assert.ok(!markdown.includes('<script>')); assert.ok(!markdown.includes('[link](https://bad.invalid)'));
  assert.ok(markdown.includes(`/blob/${b.commit}/export.ts#L1-L1`)); assert.ok(markdown.includes('Comments excluded: 3'));
  const before = await readFile(join(f.directory, 'briefing.json'), 'utf8');
  await renderBriefing(f.directory);
  assert.equal(f.calls(), 7); assert.equal(await readFile(join(f.directory, 'briefing.json'), 'utf8'), before);
  assert.equal(await readFile(join(f.directory, 'briefing.md'), 'utf8'), markdown);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  for (const name of ['briefing.json', 'briefing.md', 'events.json']) assert.equal((await stat(join(f.directory,name))).mode & 0o777, 0o600);
  for (const corrupt of [
    (v: MaintenanceBriefing) => { v.locations[1].handoff!.budgetAtStart.consumed--; },
    (v: MaintenanceBriefing) => { v.locations[0].handoff!.readiness.input.body = 'Changed'; },
    (v: MaintenanceBriefing) => { v.intake!.issues.reverse(); },
    (v: MaintenanceBriefing) => { v.locations[2].disposition = 'cancelled'; },
    (v: MaintenanceBriefing) => { v.execution.model = 'other'; },
  ]) { const changed = structuredClone(b); corrupt(changed); assert.throws(() => validateBriefing(changed)); }
  await assert.rejects(createBriefing(repository, f)); assert.equal(f.calls(), 7);
});

test('intake preserves explicit order and closed snapshots; rejects oversized and unavailable issues without truncation', async () => {
  const oversized = observe({ number: 3, title: 'Large', body: 'x'.repeat(24001), state: 'open', updated_at: issue(3).updatedAt, comments: 0 }, repository, issue(3).updatedAt)!;
  const s: Source = { ...source, get: async (_repo,n) => {
    if (n === 4) throw new Error('private-api-error');
    return n === 3 ? oversized : { ...observation(n), state: 'closed' };
  } };
  const intake = await captureBriefingIssues(repository, { count: 5, issueNumbers: [2,1,3,4], source: s, signal: new AbortController().signal });
  assert.deepEqual(intake.issues.map(i => i.snapshot), [issue(2), issue(1)]);
  assert.ok(intake.issues.every(i => i.state === 'closed'));
  assert.deepEqual(intake.rejected, [{ number: 3, reason: 'invalid_snapshot' }, { number: 4, reason: 'unavailable' }]);
  assert.ok(!JSON.stringify(intake).includes('private-api-error'));
  const scan = await captureBriefingIssues(repository, { count: 2, signal: new AbortController().signal, source: { ...source,
    scan: async () => ({ entries: 100, windowFull: true, observations: [observation(1), { ...observation(3), state: 'closed' }, observation(2), observation(2)] }) } });
  assert.deepEqual(scan.issues.map(i => i.snapshot.number), [2,1]); assert.equal(scan.windowFull, true);
});

test('source validation fails before intake and model work, and empty intake requires no inference', async t => {
  const f = await fixture(t);
  const b = await createBriefing('other/repo', { ...f, source: { ...source, get: async () => { throw new Error('Must not fetch'); } } });
  assert.equal(b.status, 'failed'); assert.equal(b.failure, 'source_unavailable'); assert.equal(b.intake, undefined); assert.equal(f.calls(), 0);
  const empty = await createBriefing(repository, { ...f, directory: join(f.checkout,'empty'), issueNumbers: undefined,
    source: { ...source, scan: async () => ({ entries: 0, windowFull: false, observations: [] }) } });
  assert.equal(empty.status, 'completed'); assert.equal(empty.budget.consumed, 0); assert.equal(f.calls(), 0);
});

test('provider failures remain recorded, feature requests skip location, and failed attempts do not retry', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(t); let calls = 0;
  const b = await createBriefing(repository, { ...f, issueNumbers: [1,2], modelFactory: async () => ({ provider: 'copilot', modelId: EVALUATION_MODEL,
    model: fixtureModel([++calls === 1 ? new Error('private-provider-error') : feature]) }) });
  assert.equal(b.status, 'partial'); assert.equal(b.budget.consumed, 2); assert.equal(calls, 2);
  assert.deepEqual(b.locations.map(l => l.disposition), ['readiness_unavailable', 'not_eligible']);
  assert.equal(b.readiness?.items[0].run?.status, 'failed');
  assert.ok(!JSON.stringify(workflowEvents(b)).includes('private-provider-error'));
});

test('cancellation after readiness prevents location admission and preserves completed assessments', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const b = await createBriefing(repository, { ...f, signal: controller.signal, persist: async (file, record) => {
    await atomicJson(file, record);
    if (record.readiness?.status === 'completed') controller.abort();
  } });
  assert.equal(b.status, 'partial'); assert.equal(b.budget.consumed, 5); assert.equal(f.calls(), 5);
  assert.deepEqual(b.locations.map(l => l.disposition), ['cancelled','cancelled','selection_limit','selection_limit','selection_limit']);
});

test('checkpoint failures stop work and keep persisted attempts unfinished; render cannot resume inference', async t => {
  const f = await fixture(t);
  for (const boundary of ['reservation', 'child_final', 'handoff_reservation', 'root_final']) {
    const directory = join(f.checkout, boundary); let calls = 0;
    await assert.rejects(createBriefing(repository, { ...f, directory, issueNumbers: [1], modelFactory: async () => ({
      provider: 'copilot', modelId: EVALUATION_MODEL, model: ++calls === 1 ? fixtureModel([ready]) : locationModel() }),
      persist: async (file, record) => {
        if (boundary === 'reservation' && record.budget.consumed === 1 ||
            boundary === 'child_final' && record.readiness?.items[0].run?.status === 'completed' ||
            boundary === 'handoff_reservation' && record.budget.consumed === 2 ||
            boundary === 'root_final' && record.finishedAt) throw new Error('private-storage-error');
        await atomicJson(file, record);
      } }), /persistence failed/);
    assert.equal(calls, boundary === 'reservation' ? 0 : boundary === 'root_final' ? 2 : 1);
    const b = await renderBriefing(directory);
    assert.equal(b.status, 'running'); assert.equal(workflowEvents(b).events.at(-1)?.type, 'workflow.unfinished');
    assert.match(await readFile(join(directory, 'briefing.md'), 'utf8'), /outcome unknown/);
  }
});

test('invalid selection is rejected before output admission; source interruption and intake errors spend no allowance', async t => {
  const f = await fixture(t);
  for (const selection of [{ count: 6 }, { issueNumbers: [1,1] }, { issueNumbers: [] }, { issueNumbers: [0] }]) {
    await assert.rejects(createBriefing(repository, { ...f, ...selection }));
    await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = await createBriefing(repository, { ...f, signal: controller.signal });
  assert.equal(cancelled.failure, 'cancelled'); assert.equal(cancelled.budget.consumed, 0);
  const failed = await createBriefing(repository, { ...f, directory: join(f.checkout,'intake-failed'), issueNumbers: undefined,
    source: { ...source, scan: async () => { throw new Error('private-api-error'); } } });
  assert.equal(failed.failure, 'intake_failed'); assert.equal(failed.budget.consumed, 0); assert.equal(f.calls(), 0);
  assert.ok(!JSON.stringify(failed).includes('private-api-error'));
});

test('cancellation during readiness retains later snapshots as unattempted and admits no location work', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const b = await createBriefing(repository, { ...f, signal: controller.signal, persist: async (file, record) => {
    await atomicJson(file, record);
    if (record.readiness?.items[0].status === 'completed') controller.abort();
  } });
  assert.equal(b.status, 'partial'); assert.equal(b.budget.consumed, 1); assert.equal(f.calls(), 1);
  assert.deepEqual(b.readiness?.items.map(i => i.status), ['completed','not_attempted','not_attempted','not_attempted','not_attempted']);
  assert.deepEqual(b.locations.map(l => l.disposition), ['cancelled','readiness_unavailable','readiness_unavailable','readiness_unavailable','readiness_unavailable']);
});

test('location initialization failure consumes its reservation and leaves the next selected report independently invocable', async t => {
  const f = await fixture(t); let calls = 0;
  const b = await createBriefing(repository, { ...f, issueNumbers: [1,2], modelFactory: async () => {
    if (++calls === 3) throw new Error('private-auth-error');
    return { provider: 'copilot', modelId: EVALUATION_MODEL, model: calls <= 2 ? fixtureModel([ready]) : locationModel() };
  } });
  assert.equal(b.status, 'partial'); assert.equal(b.budget.consumed, 4); assert.equal(calls, 4);
  assert.equal(b.locations[0].handoff?.disposition, 'failed'); assert.equal(b.locations[0].handoff?.location, undefined);
  assert.equal(b.locations[1].handoff?.disposition, 'located');
  assert.ok(!JSON.stringify(b).includes('private-auth-error'));
});
