import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { triage } from '../src/triage.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { createInvocationBudget } from '../src/invocation-budget.ts';
import { locateReadyIssue, validateLocationHandoff, type LocationHandoff } from '../src/location-handoff.ts';
import { workflowEvents } from '../src/workflow-events.ts';
import { createAgentMcpServer } from '../src/mcp-adapter.ts';
const execute = promisify(execFile);
const issue = { schemaVersion: 1 as const, repository: 'example/widget', number: 1,
  updatedAt: '2026-09-18T12:00:00Z', title: 'Export fails', body: 'Run export. Expected CSV. Error E42. Linux v1.' };
const ready = { schemaVersion: 2, kind: 'bug_report', bug_readiness: 'ready', summary: 'Export fails.',
  evidence: ['reproduction', 'expected', 'actual', 'environment'].map((field, i) => ({ field, source: 'body',
    quote: ['Run export.', 'Expected CSV.', 'Error E42.', 'Linux v1.'][i] })), questions: [] };
function locationModel(notLocated = false) {
  const calls = [
    ['search_repository', { query: 'exportCSV', scope: 'tests', pathPrefix: '' }],
    ['read_repository', { path: 'export.ts', startLine: 1, endLine: 1 }],
    ['read_repository', { path: 'export.test.ts', startLine: 1, endLine: 1 }],
    ['submit_brief', { status: 'located', codePointers: [{ excerptId: 'E1', startLine: 1, endLine: 1, symbol: 'exportCSV', reason: 'Export entry point.' }],
      testPointers: [{ excerptId: 'E2', startLine: 1, endLine: 1, symbol: 'exportCSV', reason: 'Checks export output.', relevance: 'adjacent' }],
      testSearch: { status: 'completed', reason: 'Read the candidate test.' }, uncertainties: ['The reported error is not reproduced.'] }],
  ];
  if (notLocated) calls.splice(1, calls.length - 1, ['submit_brief', { status: 'not_located',
    codePointers: [], testPointers: [], testSearch: { status: 'completed', reason: 'No useful candidate established.' },
    uncertainties: ['No location established in the bounded search.'] }]);
  let next = 0;
  return new MockLanguageModelV3({ provider: 'fixture', modelId: 'scripted', doStream: async () => {
    const call = calls[next++]; if (!call) throw new Error('Fixture exhausted');
    return { stream: simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: String(next), toolName: call[0] as string, input: JSON.stringify(call[1]) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ], initialDelayInMs: null, chunkDelayInMs: null }) };
  } });
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-handoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execute('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  await git('init', '-q'); await git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
  await writeFile(join(directory, 'export.ts'), 'export function exportCSV() { return "csv"; }\n');
  await writeFile(join(directory, 'export.test.ts'), 'test("export", () => expect(exportCSV()).toBe("csv"));\n');
  await git('add', '.'); await git('commit', '-qm', 'fixture');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  const parent = await triage(issue, { model: fixtureModel([ready]), provider: 'fixture', modelId: 'scripted' });
  return { directory, parent, source: { checkout: directory, repository: { name: issue.repository, commit } },
    model: async () => ({ model: locationModel(), provider: 'fixture', modelId: 'scripted' }) };
}

test('second agent shares allowance and preserves ready parent, source, citations, and historical usage', async t => {
  const f = await fixture(t); const budget = createInvocationBudget(2); budget.reserve();
  const parentWorkflowId = '11111111-1111-4111-8111-111111111111';
  const h = await locateReadyIssue(f.parent, { ...f, budget, readinessWorkflowId: parentWorkflowId, checkpoint: async () => {} });
  assert.equal(h.status, 'completed'); assert.equal(h.budget.consumed, 2);
  assert.equal(h.location?.input.parent.runId, f.parent.runId); assert.deepEqual(h.location?.input.issue, issue);
  assert.equal(h.location?.input.repository.commit, f.source.repository.commit);
  assert.equal(h.location?.brief?.codePointers[0].quote, 'export function exportCSV() { return "csv"; }');
  const events = workflowEvents(h).events;
  assert.ok(events.every(e => e.parentWorkflowId === parentWorkflowId && e.workflowId === h.workflowId));
  assert.ok(!events.some(e => e.type === 'agent.started' && e.agent === 'bug-readiness'));
  const reused = events.find(e => e.type === 'agent.reused')!;
  assert.ok(reused.historicalUsage); assert.equal(reused.usage, undefined);
  assert.equal(events.find(e => e.type === 'workflow.budget_reserved')?.budget?.remaining, 0);
  assert.ok(!JSON.stringify(events).includes('Expected CSV'));
  const corrupt = structuredClone(h); corrupt.location!.input.parent.summary = 'Forged summary';
  assert.throws(() => validateLocationHandoff(corrupt));
  const badBudget = structuredClone(h); badBudget.budget = badBudget.budgetAtStart;
  assert.throws(() => validateLocationHandoff(badBudget));
});

test('ineligible or mismatched parents are rejected without reservation, source reads, or provider work', async t => {
  const f = await fixture(t); const budget = createInvocationBudget(2); let calls = 0;
  const options = { ...f, budget, checkpoint: async () => {}, model: async () => { calls++; return f.model(); } };
  const feature = await triage(issue, { model: fixtureModel([{ schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable', summary: 'Request', evidence: [], questions: [] }]), provider: 'fixture', modelId: 'scripted' });
  await assert.rejects(locateReadyIssue(feature, options), /readiness_not_eligible/);
  await assert.rejects(locateReadyIssue(f.parent, { ...options, source: { ...f.source, repository: { ...f.source.repository, name: 'other/repo' } } }), /source_repository_mismatch/);
  const corrupt = structuredClone(f.parent); corrupt.input.body = 'Changed';
  await assert.rejects(locateReadyIssue(corrupt, options));
  assert.equal(calls, 0); assert.equal(budget.snapshot().consumed, 0);
});

test('exhaustion and cancellation produce explicit no-run partial handoffs without new provider work', async t => {
  const f = await fixture(t);
  for (const cancel of [false, true]) {
    const budget = createInvocationBudget(1); if (!cancel) budget.reserve();
    const controller = new AbortController(); if (cancel) controller.abort();
    const h = await locateReadyIssue(f.parent, { ...f, budget, signal: controller.signal, checkpoint: async () => {}, model: async () => { throw new Error('Must not initialize'); } });
    assert.equal(h.status, 'partial'); assert.equal(h.disposition, 'not_attempted'); assert.equal(h.location, undefined);
    assert.equal(h.reason, cancel ? 'cancelled' : 'budget_exhausted');
    assert.equal(workflowEvents(h).events.find(e => e.type === 'stage.skipped')?.reason, h.reason);
  }
});

test('unavailable or wrong source consumes one attempt but cannot run inference or invent a child', async t => {
  const f = await fixture(t);
  for (const source of [{ ...f.source, checkout: join(f.directory, 'missing') },
    { ...f.source, repository: { ...f.source.repository, commit: '0'.repeat(40) } }]) {
    let inference = 0; const model = locationModel(); model.doStream = async () => { inference++; throw new Error('Must not run'); };
    const h = await locateReadyIssue(f.parent, { source, budget: createInvocationBudget(1), checkpoint: async () => {},
      model: async () => ({ model, provider: 'fixture', modelId: 'scripted' }) });
    assert.equal(h.status, 'failed'); assert.equal(h.reason, 'execution_error'); assert.equal(h.location, undefined);
    assert.equal(h.budget.consumed, 1); assert.equal(inference, 0);
    assert.equal(workflowEvents(h).events.find(e => e.type === 'stage.failed')?.runId, undefined);
  }
});

test('persistence errors preserve only saved state and prevent false workflow success', async t => {
  const f = await fixture(t);
  for (const boundary of ['initial', 'reservation', 'child_final', 'workflow_final']) {
    let saved: LocationHandoff | undefined; let calls = 0;
    const budget = createInvocationBudget(2);
    await assert.rejects(locateReadyIssue(f.parent, { ...f, budget, model: async () => { calls++; return f.model(); }, checkpoint: async record => {
      if (boundary === 'initial' || boundary === 'reservation' && record.reservation ||
          boundary === 'child_final' && record.location?.status === 'completed' || boundary === 'workflow_final' && record.finishedAt) throw new Error('private-storage-error');
      saved = record;
    } }), /persistence failed/);
    assert.equal(calls, boundary === 'initial' || boundary === 'reservation' ? 0 : 1);
    if (saved) assert.equal(workflowEvents(saved).events.at(-1)?.type, 'workflow.unfinished');
  }
});

test('MCP composes by saved IDs, rejects source injection, and cannot bypass shared exhaustion', async t => {
  const f = await fixture(t); let modelCalls = 0;
  const server = createAgentMcpServer({ runsDirectory: join(f.directory, 'runs'), maxInvocations: 2,
    preparedInput: { issues: [issue] }, locationSource: f.source, model: async () => {
      modelCalls++; return { model: modelCalls === 1 ? fixtureModel([ready]) : locationModel(), provider: 'fixture', modelId: 'scripted' };
    } });
  const client = new Client({ name: 'handoff-consumer', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any;
  const discover = await call('discover_agents');
  assert.deepEqual(discover.adapter.invocable, ['bug-readiness', 'code-location']);
  assert.ok(!JSON.stringify(discover).includes(f.directory));
  const w = (await call('assess_prepared_issues', { inputHash: discover.preparedWorkflow.inputHash })).workflow;
  const runId = w.items[0].run.runId;
  assert.equal((await client.callTool({ name: 'locate_ready_issue', arguments: { readinessRunId: runId, checkout: '/arbitrary' } })).isError, true);
  const result = await call('locate_ready_issue', { readinessRunId: runId });
  assert.equal(result.handoff.status, 'completed'); assert.equal(result.handoff.readinessWorkflowId, w.workflowId);
  assert.equal(result.handoff.location.parentRunId, runId);
  assert.deepEqual(await call('inspect_handoff', { workflowId: result.handoff.workflowId }), result);
  const next = await call('locate_ready_issue', { readinessRunId: runId });
  assert.equal(next.handoff.reason, 'budget_exhausted'); assert.equal(next.handoff.location, undefined); assert.equal(modelCalls, 2);
  const session = (await readdir(join(f.directory, 'runs')))[0];
  const raw = JSON.parse(await readFile(join(f.directory, 'runs', session, `handoff-${result.handoff.workflowId}.json`), 'utf8'));
  assert.deepEqual(result.handoff.events, JSON.parse(JSON.stringify(workflowEvents(raw))));
});


test('completed not-located and provider-failed children remain distinct handoff outcomes', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(t);
  for (const fails of [false, true]) {
    const model = locationModel(true);
    if (fails) model.doStream = async () => { throw new Error('private-provider-response'); };
    const h = await locateReadyIssue(f.parent, { ...f, budget: createInvocationBudget(1), checkpoint: async () => {},
      model: async () => ({ model, provider: 'fixture', modelId: 'scripted' }) });
    assert.equal(h.status, fails ? 'failed' : 'partial');
    assert.equal(h.disposition, fails ? 'failed' : 'not_located');
    assert.equal(h.location?.status, fails ? 'failed' : 'completed');
    assert.equal(h.budget.remaining, 0);
    assert.ok(!JSON.stringify(workflowEvents(h)).includes('private-provider-response'));
  }
});
