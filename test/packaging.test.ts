import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createRepositoryBrief } from '@onionsoup/repository-brief';
import { createRepositoryBrief as legacyRecipe } from '../src/repository-brief/recipe.ts';
import { summarizeRepositoryThemes } from '@onionsoup/repository-analysis';
import { summarizeRepositoryThemes as legacyAgent } from '../src/repository-brief/agents.ts';
import { tick } from '@onionsoup/brief-delivery';
import { tick as legacyTick } from '../src/delivery/runtime.ts';
const execute = promisify(execFile);
test('legacy imports forward to the same packaged implementations', () => {
  assert.equal(createRepositoryBrief, legacyRecipe); assert.equal(summarizeRepositoryThemes, legacyAgent); assert.equal(tick, legacyTick);
});
test('compiled release runs CLI, delivery worker and MCP outside the source repository', {
  skip: process.env.ONIONSOUP_RELEASE_INSTALL !== '1', timeout: 120000,
}, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'onionsoup-portable-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await execute(process.execPath, ['scripts/release-brief.mjs']);
  const release = join(parent, 'release'); await cp('dist/repository-brief', release, { recursive: true });
  const command = (args: string[]) => execute(process.execPath, args, { cwd: release, timeout: 30000 });
  await execute('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: release, timeout: 90000 });
  await command(['verify-release.mjs']);
  for (const app of ['brief-cli', 'brief-worker', 'brief-mcp', 'mail-capture'])
    assert.match((await command([`apps/${app}/dist/main.js`, '--help'])).stdout, /Usage|stdio/);
  await assert.rejects(readFile(join(release, 'src/providers.ts')));
  const request = { schemaVersion: 1, repository: 'example/widget', since: '2026-09-17T00:00:00Z', until: '2026-09-18T00:00:00Z', maxSuggestions: 0 };
  const original = join(parent, 'original');
  const record = await createRepositoryBrief(request, { directory: original, provider: 'copilot',
    reader: async endpoint => endpoint === 'repos/example/widget' ? { full_name: 'example/widget', default_branch: 'main' }
      : endpoint.includes('/actions/runs') ? { total_count: 0, workflow_runs: [] } : { total_count: 0, incomplete_results: false, items: [] },
    modelFactory: async () => ({ provider: 'copilot', modelId: 'gpt-5.6-terra', model: new MockLanguageModelV3({ doStream: async () => ({
      stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [{ type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: '1', toolName: 'submit_result', input: JSON.stringify({ schemaVersion: 1, observations: [], limitations: ['No observed activity.'] }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 } } }] }) }) }) }) });
  assert.equal(record.status, 'completed');
  const saved = join(parent, 'saved'); await cp(original, saved, { recursive: true });
  assert.equal(JSON.parse((await command(['apps/brief-cli/dist/main.js', 'render', saved])).stdout).workflowId, record.workflowId);
  for (const file of ['repository-brief.json', 'events.json', 'repository-brief.md', 'repository-brief.html'])
    assert.equal(await readFile(join(saved, file), 'utf8'), await readFile(join(original, file), 'utf8'));
  const config = join(parent, 'delivery.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, jobId: 'portable-proof', repository: 'example/widget', provider: 'copilot', days: 1, maxSuggestions: 0,
    schedule: { timeZone: 'America/New_York', time: '08:00', weekdays: [0,1,2,3,4,5,6], catchUpHours: 2 },
    from: 'brief@example.invalid', to: 'maintainer@example.invalid', smtp: { host: '127.0.0.1', port: 2525, security: 'loopback' } }));
  const delivery = JSON.parse((await command(['apps/brief-worker/dist/main.js', 'prepare', config, join(saved, 'repository-brief.json'), '--state', join(parent, 'delivery')])).stdout);
  assert.equal(delivery.status, 'prepared'); assert.equal(delivery.briefWorkflowId, record.workflowId);
  // Execute the actual stdio app without any real GitHub or model credentials.
  const bin = join(parent, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const runs = join(parent, 'mcp');
  const client = new Client({ name: 'portable-orchestrator', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(release, 'apps/brief-mcp/dist/main.js')], cwd: release,
    env: { PATH: bin, ONIONSOUP_PROVIDER: 'copilot', ONIONSOUP_REPOSITORIES: 'example/widget', ONIONSOUP_RUNS_DIR: runs }, stderr: 'pipe' });
  t.after(() => client.close()); await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any;
  assert.equal((await client.listTools()).tools.length, 4);
  const job = await call('submit_repository_brief', { request });
  let result;
  for (let i = 0; i < 100; i++) {
    result = await call('inspect_repository_brief', { jobId: job.jobId });
    if (result.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.status, 'settled'); assert.equal(result.resultStatus, 'failed');
  assert.equal(result.budget.consumed, 0);
  assert.equal((await call('submit_repository_brief', { request })).error, 'job_limit');
  await client.close();
  // Inventory catches changed compiled code without trusting source-tree availability.
  await writeFile(join(release, 'packages/repository-analysis/dist/agents.js'), '// tampered\n');
  await assert.rejects(command(['verify-release.mjs']), /inventory mismatch/);
});
