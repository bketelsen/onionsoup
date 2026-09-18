import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMcpServer, type McpOptions } from '../src/mcp-adapter.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { inputHash } from '../src/triage.ts';
import { workflowEvents } from '../src/workflow-events.ts';

const issue = { schemaVersion: 1, repository: 'example/widget', number: 1,
  updatedAt: '2026-09-18T12:00:00Z', title: 'Add export', body: 'Please add export support.' } as const;
const assessment = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable',
  summary: 'A request for export support.', evidence: [], questions: [] };
const fixture = () => ({ provider: 'fixture', modelId: 'scripted', model: fixtureModel([assessment]) });
async function setup(t: TestContext, options: Partial<McpOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-mcp-'));
  const server = createAgentMcpServer({ runsDirectory: directory, model: async () => fixture(), ...options });
  const client = new Client({ name: 'external-test-consumer', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { directory, server, client, call };
}
const payload = (result: Awaited<ReturnType<Client['callTool']>>) => result.structuredContent as any;

test('MCP consumer discovers without credentials, invokes unchanged readiness, and inspects exact trace', async t => {
  let calls = 0;
  const { call, client, directory } = await setup(t, { model: async () => { calls++; return fixture(); } });
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['assess_issue', 'discover_agents', 'inspect_run']);
  const discovered = payload(await call('discover_agents'));
  assert.equal(calls, 0); assert.deepEqual(discovered.adapter.invocable, ['bug-readiness']);
  assert.equal(discovered.agents[0].contracts.resultVersion, 2);
  assert.equal(discovered.agents[1].id, 'code-location');
  const result = await call('assess_issue', { issue });
  assert.equal(result.isError, false); assert.equal(calls, 1);
  const body = payload(result); const run = body.run;
  assert.equal(run.status, 'completed'); assert.deepEqual(run.assessment, assessment);
  assert.equal(run.inputHash, inputHash(issue));
  assert.deepEqual(payload(await call('inspect_run', { runId: run.runId })), body);
  assert.equal(calls, 1);
  const session = (await readdir(directory))[0];
  const path = join(directory, session, `${run.runId}.json`);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(raw.state); assert.equal(raw.schemaVersion, 2);
  assert.deepEqual(run.events, JSON.parse(JSON.stringify(workflowEvents(raw))));
  assert.equal(run.events.workflowId, run.runId);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, session))).mode & 0o777, 0o700);
  assert.equal(run.state, undefined); assert.equal(run.input, undefined);
  assert.deepEqual(JSON.parse((result.content as any)[0].text), body);
  assert.equal(payload(await call('assess_issue', { issue })).error, 'invocation_limit');
  assert.equal(calls, 1);
});

test('MCP validates strict inputs before spending allowance and cannot select model, paths, or other sessions', async t => {
  const { call } = await setup(t);
  for (const args of [{ issue, model: 'untrusted' }, { issue: { ...issue, path: '/tmp/secret' } }, { issue: { ...issue, body: 'x'.repeat(24001) } }]) {
    assert.equal((await call('assess_issue', args)).isError, true);
  }
  assert.equal(payload(await call('discover_agents')).adapter.invocationsUsed, 0);
  assert.equal((await call('inspect_run', { runId: '../../secret' })).isError, true);
  assert.equal(payload(await call('inspect_run', { runId: '11111111-1111-4111-8111-111111111111' })).error, 'run_not_found');
  assert.equal((await call('assess_issue', { issue })).isError, false);
});

test('MCP bounds concurrent admission without consuming a second allowance', async t => {
  let resolveModel!: (value: ReturnType<typeof fixture>) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<ReturnType<typeof fixture>>(resolve => { resolveModel = resolve; });
  const { call } = await setup(t, { maxInvocations: 2, model: async () => { entered(); return pending; } });
  const first = call('assess_issue', { issue }); await started;
  assert.equal(payload(await call('assess_issue', { issue })).error, 'busy');
  assert.equal(payload(await call('discover_agents')).adapter.invocationsUsed, 1);
  resolveModel(fixture()); await first;
});

test('MCP hides configuration exceptions and counts the failed admission without retry', async t => {
  let calls = 0;
  const { call } = await setup(t, { model: async () => { calls++; throw new Error('Bearer private-provider-details'); } });
  const response = await call('assess_issue', { issue });
  assert.equal(response.isError, true);
  assert.equal(payload(response).error, 'execution_or_persistence_error');
  assert.ok(!JSON.stringify(response).includes('private-provider-details'));
  assert.equal(payload(await call('assess_issue', { issue })).error, 'invocation_limit');
  assert.equal(calls, 1);
});

test('MCP persists provider failures as failed runs, never as successful assessments', async t => {
  t.mock.method(console, 'error', () => {});
  const { call } = await setup(t, { model: async () => ({ ...fixture(), model: fixtureModel([new Error('private-provider-details')]) }) });
  const response = await call('assess_issue', { issue });
  assert.equal(response.isError, true);
  const run = payload(response).run;
  assert.equal(run.status, 'failed'); assert.equal(run.failure, 'provider_error');
  assert.equal(run.assessment, undefined);
  assert.equal(run.events.events.at(-1).type, 'workflow.failed');
  assert.ok(!JSON.stringify(response).includes('private-provider-details'));
  assert.deepEqual(payload(await call('inspect_run', { runId: run.runId })).run, run);
});

test('MCP admission persistence failure prevents a model call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'onionsoup-mcp-blocked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocked = join(dir, 'not-a-directory'); await writeFile(blocked, 'blocked');
  const model = fixtureModel([assessment]); let calls = 0;
  const original = model.doStream;
  model.doStream = async args => { calls++; return original(args); };
  const { call } = await setup(t, { runsDirectory: blocked, model: async () => ({ ...fixture(), model }) });
  const result = await call('assess_issue', { issue });
  assert.equal(payload(result).error, 'execution_or_persistence_error');
  assert.equal(calls, 0); assert.equal(payload(result).run, undefined);
});

test('MCP cancellation reaches the agent and preserves an interrupted outcome', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const model = fixtureModel([]);
  model.doStream = async options => {
    entered();
    await new Promise<void>((resolve, reject) => {
      if (options.abortSignal?.aborted) return reject(new Error('aborted'));
      options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    throw new Error('unreachable');
  };
  const { client, call, directory } = await setup(t, { model: async () => ({ ...fixture(), model }) });
  const controller = new AbortController();
  const result = client.callTool({ name: 'assess_issue', arguments: { issue } }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(result);
  await started; controller.abort(); await rejection;
  // Cancellation is a notification; wait for the server's final checkpoint.
  let raw: any;
  for (let i = 0; i < 100; i++) {
    const session = (await readdir(directory))[0];
    const file = (await readdir(join(directory, session))).find(f => f.endsWith('.json'))!;
    raw = JSON.parse(await readFile(join(directory, session, file), 'utf8'));
    if (raw.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(raw.status, 'failed'); assert.equal(raw.failure, 'interrupted_or_timed_out');
  assert.equal(payload(await call('inspect_run', { runId: raw.runId })).run.status, 'failed');
});

test('real stdio entrypoint serves discovery with nonexistent credentials and clean protocol stdout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-mcp-stdio-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp-cli.ts'], stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ONIONSOUP_PROVIDER: 'copilot', ONIONSOUP_MODEL: 'gpt-5.6-terra',
      ONIONSOUP_AUTH_PATH: join(directory, 'missing-auth.json'), ONIONSOUP_RUNS_DIR: directory } });
  const client = new Client({ name: 'stdio-test-consumer', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const discovered = await client.callTool({ name: 'discover_agents', arguments: {} });
  assert.equal(payload(discovered).adapter.invocationsUsed, 0);
  assert.deepEqual(await readdir(directory), []);
  const result = await client.callTool({ name: 'assess_issue', arguments: { issue } });
  assert.equal(payload(result).error, 'execution_or_persistence_error');
  assert.ok(!JSON.stringify(result).includes('missing-auth'));
});


test('MCP final persistence failure returns only the saved unfinished admission', async t => {
  let directory = '';
  const model = fixtureModel([assessment]);
  const original = model.doStream;
  model.doStream = async args => {
    const session = (await readdir(directory))[0];
    const path = join(directory, session);
    await rename(path, `${path}-preserved`);
    await writeFile(path, 'simulated storage failure');
    return original(args);
  };
  const consumer = await setup(t, { model: async () => ({ ...fixture(), model }) });
  directory = consumer.directory;
  const result = await consumer.call('assess_issue', { issue });
  assert.equal(result.isError, true);
  assert.equal(payload(result).error, 'execution_or_persistence_error');
  const run = payload(result).run;
  assert.equal(run.status, 'running'); assert.equal(run.assessment, undefined);
  assert.equal(run.events.events.at(-1).type, 'workflow.unfinished');
  assert.deepEqual(payload(await consumer.call('inspect_run', { runId: run.runId })).run, run);
});
