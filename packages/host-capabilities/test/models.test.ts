import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { openJobHost, type JobHost } from '@onionsoup/job-host';
import { IssueSnapshot } from '@onionsoup/maintenance/contracts';
import type { Source } from '@onionsoup/maintenance/github-issues';
import type { ProviderCatalog, ProviderId } from '@onionsoup/providers';
import { ModelConfig, ModelRegistry, registeredCapabilities } from '../src/index.ts';

const example = new URL('../../../examples/', import.meta.url);
const issue = IssueSnapshot.parse({ ...JSON.parse(await readFile(new URL('incomplete-bug.json', example), 'utf8')), repository: 'example/widget' });
const assessment = JSON.parse(await readFile(new URL('incomplete-assessment.json', example), 'utf8'));

const config = {
  schemaVersion: 2,
  models: { default: { provider: 'codex', model: 'gpt-5.6-terra' }, agents: { 'change-review': { provider: 'copilot', model: 'claude-sonnet-5' } } },
  repositories: [{ name: 'example/widget' }],
};
const listings: Record<ProviderId, ProviderCatalog> = {
  copilot: { provider: 'copilot', status: 'ok', models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
  codex: { provider: 'codex', status: 'signed_out' },
};
const source: Source = {
  scan: async () => { throw new Error('not used'); },
  get: async (repository, number) => ({ number, title: issue.title, state: 'open', updatedAt: issue.updatedAt, observedAt: new Date().toISOString(), commentsExcluded: 0, snapshot: { ...issue, repository, number } }),
};

function assessing() {
  return new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'tool-call' as const, toolCallId: 'assessment', toolName: 'submit_assessment', input: JSON.stringify(assessment) },
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } },
  ] }) }) });
}

async function settled(host: JobHost, id: string) {
  for (let n = 0; n < 400; n++) {
    const job = await host.inspect('web', id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timeout');
}

async function openHost(directory: string, opened: string[]) {
  const registry = await ModelRegistry.open({ directory: join(directory, 'models'), config: ModelConfig.parse(config.models) });
  // Opening a model records which one the agent asked for; the scripted model stands in for the provider.
  const open = async (modelId: string, provider: ProviderId) => { opened.push(`${provider}/${modelId}`); return { provider, modelId, model: assessing() }; };
  const capabilities = registeredCapabilities(config, {
    modelRegistry: registry, models: registry.resolver(open), catalog: async (provider) => listings[provider],
    repositoryBrief: async () => { throw new Error('not used'); }, maintenance: { source },
  });
  const host = await openJobHost({ directory: join(directory, 'jobs'), binding: {}, capabilities, invokers: [{ id: 'web', capabilities: capabilities.map((c) => c.id) }] });
  return { host, registry };
}

test('each agent runs on its assigned model, assignments come from provider catalogs and survive a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'models-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened: string[] = [];
  const first = await openHost(directory, opened);

  assert.deepEqual(first.registry.choice('change-review'), { choice: { provider: 'copilot', model: 'claude-sonnet-5' }, origin: 'config' });
  assert.deepEqual(first.registry.choice('bug-readiness'), { choice: { provider: 'codex', model: 'gpt-5.6-terra' }, origin: 'default' });

  const assign = async (key: string, input: unknown) => settled(first.host, (await first.host.submit('web', { capability: 'models.assign', idempotencyKey: key, input })).jobId);
  const assigned = await assign('assign-first', { agent: 'bug-readiness', choice: { provider: 'copilot', model: 'claude-opus-5' } });
  assert.equal(assigned.status, 'completed', assigned.error);
  assert.deepEqual(assigned.result, { agent: 'bug-readiness', choice: { provider: 'copilot', model: 'claude-opus-5', origin: 'assigned' } });

  const unlisted = await assign('assign-unlisted', { agent: 'bug-readiness', choice: { provider: 'copilot', model: 'not-offered' } });
  assert.equal(unlisted.error, 'model_not_in_catalog:copilot/not-offered');
  const signedOut = await assign('assign-signed-out', { agent: 'chat', choice: { provider: 'codex', model: 'gpt-5.6-terra' } });
  assert.equal(signedOut.error, 'provider_signed_out:codex');
  await assert.rejects(first.host.submit('web', { capability: 'models.assign', idempotencyKey: 'assign-unknown', input: { agent: 'no-such-agent' } }));

  const readiness = await settled(first.host, (await first.host.submit('web', { capability: 'issue.readiness', idempotencyKey: 'readiness-1', input: { repository: 'example/widget', issue: 7 } })).jobId);
  assert.equal(readiness.status, 'completed', readiness.error);
  const run = (readiness.result as { run: { provider: string; model: string } }).run;
  assert.deepEqual([run.provider, run.model], ['copilot', 'claude-opus-5']);
  assert.deepEqual(opened, ['copilot/claude-opus-5']);
  await first.host.close();

  const second = await openHost(directory, opened);
  t.after(() => second.host.close());
  assert.deepEqual(second.registry.choice('bug-readiness'), { choice: { provider: 'copilot', model: 'claude-opus-5' }, origin: 'assigned' });
  const reset = await settled(second.host, (await second.host.submit('web', { capability: 'models.assign', idempotencyKey: 'reset-readiness', input: { agent: 'bug-readiness' } })).jobId);
  assert.deepEqual(reset.result, { agent: 'bug-readiness', choice: { provider: 'codex', model: 'gpt-5.6-terra', origin: 'default' } });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'models', 'assignments.json'), 'utf8')), { schemaVersion: 1, agents: {} });
});

test('an agent the host does not know cannot open a model', async () => {
  const registry = ModelRegistry.fixed({ default: { provider: 'codex', model: 'gpt-5.6-terra' }, agents: {} });
  await assert.rejects(registry.resolver(async () => { throw new Error('must not open'); })('invented-agent'), /unknown_model_agent:invented-agent/);
  await assert.rejects(registry.assign('chat', null), /model_assignments_not_persisted/);
});
