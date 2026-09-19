import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createBriefMcpServer, type BriefMcpOptions } from '../src/index.ts';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { createRepositoryBrief, workflowEvents } from '@onionsoup/repository-brief';
const request = { schemaVersion: 1 as const, repository: 'example/widget', since: '2026-09-17T00:00:00Z',
  until: '2026-09-18T00:00:00Z', maxSuggestions: 0 };
const reader: BriefMcpOptions['reader'] = async endpoint => endpoint === 'repos/example/widget'
  ? { full_name: 'example/widget', default_branch: 'main' }
  : endpoint.includes('/actions/runs') ? { total_count: 0, workflow_runs: [] } : { total_count: 0, incomplete_results: false, items: [] };
const modelFactory: BriefMcpOptions['modelFactory'] = async () => ({ provider: 'copilot', modelId: EVALUATION_MODEL,
  model: new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ initialDelayInMs: null,
    chunkDelayInMs: null, chunks: [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: '1',
      toolName: 'submit_result', input: JSON.stringify({ schemaVersion: 1, observations: [], limitations: ['No observed activity.'] }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }] }) }) }) });
async function setup(t: TestContext, overrides: Partial<BriefMcpOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'brief-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options: BriefMcpOptions = { runsDirectory: root, provider: 'copilot', repositories: ['example/widget'], reader, modelFactory, ...overrides };
  const host = createBriefMcpServer(options), client = new Client({ name: 'test-orchestrator', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await host.server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await host.shutdown(); await client.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError, body: result.structuredContent as any };
  };
  return { ...host, client, root, options, call };
}
async function finished(call: Awaited<ReturnType<typeof setup>>['call'], jobId: string) {
  for (let i = 0; i < 100; i++) {
    const result = await call('inspect_repository_brief', { jobId });
    if (result.body.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture did not settle');
}
test('MCP calls the shared recipe and preserves durable artifacts, events, and rendered results', async t => {
  let calls = 0;
  const f = await setup(t, { modelFactory: async (...args) => { calls++; return modelFactory!(...args); } });
  assert.equal((await f.call('discover_repository_brief')).body.agents.length, 3);
  assert.equal(calls, 0);
  const { body } = await f.call('submit_repository_brief', { request });
  const result = await finished(f.call, body.jobId);
  assert.equal(result.body.status, 'settled'); assert.equal(result.body.resultStatus, 'completed'); assert.equal(calls, 1);
  const artifact = JSON.parse(await readFile(join(f.root, body.jobId, 'analysis/repository-brief.json'), 'utf8'));
  assert.deepEqual(result.body.events, workflowEvents(artifact));
  assert.equal(result.body.markdown, await readFile(join(f.root, body.jobId, 'analysis/repository-brief.md'), 'utf8'));
  assert.equal(result.body.state, undefined); assert.ok(!JSON.stringify(result.body).includes(f.root));
  assert.equal((await f.call('submit_repository_brief', { request })).body.error, 'job_limit');
  await f.shutdown();
  const restarted = await setup(t, { ...f.options, modelFactory: async () => { throw new Error('Must not replay'); } });
  assert.deepEqual((await restarted.call('inspect_repository_brief', { jobId: body.jobId })).body, result.body);
});
test('MCP rejects request authority substitution and storage traversal before admission', async t => {
  const f = await setup(t);
  for (const args of [{ request, provider: 'codex' }, { request, directory: '/tmp' }, { request: { ...request, command: 'id' } }])
    assert.equal((await f.call('submit_repository_brief', args)).error, true);
  assert.equal((await f.call('submit_repository_brief', { request: { ...request, repository: 'other/private' } })).body.error, 'repository_not_allowed');
  assert.equal((await f.call('inspect_repository_brief', { jobId: '../../secret' })).error, true);
  assert.equal((await f.call('discover_repository_brief')).body.admitted, 0);
});
test('MCP bounds concurrency, cancels cooperatively and does not replenish admissions', async t => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = await setup(t, { reader: async (endpoint, signal) => { enter(); await held; signal.throwIfAborted(); return reader!(endpoint, signal); } });
  const { body } = await f.call('submit_repository_brief', { request }); await entered;
  assert.equal((await f.call('submit_repository_brief', { request })).body.error, 'busy');
  assert.equal((await f.call('cancel_repository_brief', { jobId: body.jobId })).body.status, 'cancellation_requested');
  release();
  assert.equal((await finished(f.call, body.jobId)).body.resultStatus, 'failed');
  assert.equal((await f.call('discover_repository_brief')).body.admitted, 1);
});
test('MCP restart exposes admitted work as unfinished and refuses mismatched saved requests', async t => {
  const f = await setup(t), jobId = randomUUID(), directory = join(f.root, jobId);
  await mkdir(directory);
  await writeFile(join(directory, 'job.json'), JSON.stringify({ schemaVersion: 1, kind: 'brief-mcp-job', jobId,
    request, provider: 'copilot', createdAt: new Date().toISOString(), status: 'admitted' }));
  assert.equal((await f.call('inspect_repository_brief', { jobId })).body.status, 'unfinished');
  await createRepositoryBrief({ ...request, maxSuggestions: 1 }, { directory: join(directory, 'analysis'),
    provider: 'copilot', reader: async () => { throw new Error('unavailable'); } });
  assert.equal((await f.call('inspect_repository_brief', { jobId })).body.error, 'artifact_mismatch');
});
test('MCP cannot begin collection when durable admission storage fails', async t => {
  const path = join(tmpdir(), `blocked-${randomUUID()}`); await writeFile(path, 'occupied');
  t.after(() => rm(path)); let reads = 0;
  const f = await setup(t, { runsDirectory: path, reader: async () => { reads++; throw new Error('forbidden'); } });
  assert.equal((await f.call('submit_repository_brief', { request })).body.error, 'admission_storage_failed');
  assert.equal(reads, 0); assert.equal((await f.call('discover_repository_brief')).body.admitted, 1);
});
