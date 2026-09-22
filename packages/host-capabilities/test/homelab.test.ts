import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { openJobHost, type JobHost } from '@onionsoup/job-host';
import { investigateContainers } from '@onionsoup/container-triage';
import type { ContainerTransport } from '@onionsoup/container-source/containers';
import { HomelabRegistry, registeredCapabilities } from '../src/index.ts';

const podmanRows = JSON.stringify([
  { Id: 'd4', Names: ['db'], Image: 'postgres:16', State: 'running', Status: 'Up 5 days', Restarts: 0 },
  { Id: 'f6', Names: ['payments-gateway'], Image: 'api:3', State: 'running', Status: 'Up 2 minutes (unhealthy)', Restarts: 4 },
]);
const transport: ContainerTransport = async () => ({ code: 0, stdout: podmanRows });

function scripted(decide: (input: any) => unknown) {
  return new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const user = prompt.find((m) => m.role === 'user') as any;
    const input = JSON.parse(user.content[0].text);
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: '1', toolName: 'submit_result', input: JSON.stringify(decide(input)) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
}
const assessment = (input: any) => ({ schemaVersion: 1, findings: input.snapshot.selected.map((containerId: string) => ({ containerId, classification: 'attention_now', reason: 'Unhealthy with repeated restarts.', nextInvestigation: 'Read its recent log lines.', evidenceIds: [containerId] })) });

async function settled(host: JobHost, id: string) {
  for (let n = 0; n < 600; n++) {
    const job = await host.inspect('web', id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timeout');
}

test('homelab sources are registered, refreshed, investigated with names joined, and briefed from the latest observations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'homelab-host-'));
  const registry = await HomelabRegistry.open({ directory: join(root, 'homelab'), entries: [{ sourceId: 'fixed-k3s', kind: 'kubernetes', target: { schemaVersion: 1, assetId: 'fixed-k3s', host: 'k3s.invalid', user: 'operator' } }], maxAgeSeconds: 600 });
  const capabilities = registeredCapabilities({ schemaVersion: 2, models: { default: { provider: 'copilot', model: 'gpt-5.6-terra' } }, homelab: { schemaVersion: 1 } }, {
    homelab: registry,
    models: async () => ({ provider: 'copilot', modelId: 'gpt-5.6-terra', model: scripted(assessment) }),
    homelabOptions: { investigators: { containers: (target, options) => investigateContainers(target, { ...options, transport }) } },
    repositoryBrief: async () => { throw new Error('unused'); },
  });
  const ids = capabilities.map((c) => c.id);
  assert.ok(['homelab.sources', 'homelab.add-source', 'homelab.update-source', 'homelab.refresh', 'homelab.investigate', 'homelab.brief'].every((id) => ids.includes(id)));
  const host = await openJobHost({ directory: join(root, 'host'), binding: {}, capabilities, invokers: [{ id: 'web', capabilities: ids }] });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const run = async (capability: string, input: unknown, key: string) => settled(host, (await host.submit('web', { capability, input, idempotencyKey: key })).jobId);

  const added = await run('homelab.add-source', { sourceId: 'lab-box', kind: 'containers', host: 'lab.invalid', user: 'operator', engines: ['podman'] }, 'add-lab-box-1');
  assert.equal(added.status, 'completed', added.error);
  assert.equal((await run('homelab.add-source', { sourceId: 'fixed-k3s', kind: 'kubernetes', host: 'x.invalid', user: 'operator' }, 'add-fixed-1')).error, 'source_exists');
  const schema = host.discover('web').capabilities.find((c) => c.id === 'homelab.refresh')!.inputSchema as any;
  assert.deepEqual(schema.properties.sourceId.enum, ['fixed-k3s', 'lab-box']);

  const investigated = await run('homelab.investigate', { sourceId: 'lab-box' }, 'investigate-lab-1');
  assert.equal(investigated.status, 'completed', investigated.error);
  const result = investigated.result as { markdown: string; names: Record<string, { name: string }>; run: { result: { findings: unknown[] } } };
  assert.equal(result.run.result.findings.length, 1);
  assert.match(result.markdown, /\*\*attention now\*\* — payments-gateway \(podman, Up 2 minutes \(unhealthy\)\)/);
  assert.equal(JSON.stringify(result.run).includes('payments-gateway'), false);
  assert.deepEqual(investigated.outcome, { status: 'attention', label: '1 attention, 0 historical, 0 unclear' });

  const listed = await run('homelab.sources', {}, 'list-sources-1');
  const lab = (listed.result as { sources: any[] }).sources.find((s) => s.sourceId === 'lab-box');
  assert.equal(lab.latestInvestigation.summary, '1 attention, 0 historical');
  assert.equal(lab.latestInvestigation.attention, true);
  // Results recorded before `attention` existed must still read back.
  const sourcesOutput = capabilities.find((c) => c.id === 'homelab.sources')!.output;
  const { attention: _unrecorded, ...older } = lab.latestInvestigation;
  const reread = sourcesOutput.parse({ sources: [{ ...lab, latestInvestigation: older }] }) as { sources: { latestInvestigation: { attention: boolean } }[] };
  assert.equal(reread.sources[0].latestInvestigation.attention, false);
  assert.equal(lab.latestObservation.status, 'completed');

  const brief = await run('homelab.brief', {}, 'homelab-brief-1');
  assert.equal(brief.status, 'completed', brief.error);
  const briefResult = brief.result as { markdown: string; brief: { sources: { freshness: string }[] } };
  assert.match(briefResult.markdown, /## lab-box/);
  assert.match(briefResult.markdown, /Finding counts: 1 attention/);
  assert.deepEqual(briefResult.brief.sources.map((s) => s.freshness), ['fresh', 'fresh']);

  const updated = await run('homelab.update-source', { sourceId: 'lab-box', engines: ['podman', 'docker'] }, 'update-lab-1');
  assert.equal(updated.status, 'completed', updated.error);
  assert.match((updated.result as { source: { detail: string } }).source.detail, /podman, docker/);
  assert.equal((await run('homelab.update-source', { sourceId: 'fixed-k3s', access: 'sudo' }, 'update-fixed-1')).error, 'source_fixed_by_config');
  const saved = JSON.parse(await readFile(join(root, 'homelab', 'sources.json'), 'utf8'));
  assert.deepEqual(saved.sources.map((s: any) => s.sourceId), ['lab-box']);
});
