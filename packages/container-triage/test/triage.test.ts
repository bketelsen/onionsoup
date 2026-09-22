import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { collectContainers, parseContainers, selectContainerFacts, type ContainerTransport } from '@onionsoup/container-source/containers';
import { classificationGate, investigateContainers, triageContainers, validateTriageResult, findingCounts } from '../src/index.ts';

const target = { schemaVersion: 1, assetId: 'lab-box', host: 'example.invalid', user: 'operator', engines: ['docker', 'podman', 'incus'] };
const dockerRows = [
  { ID: 'a1', Names: 'web', Image: 'nginx:1', State: 'running', Status: 'Up 3 hours (healthy)', CreatedAt: '2026-09-20 10:00:00 +0000 UTC' },
  { ID: 'b2', Names: 'worker', Image: 'app:2', State: 'exited', Status: 'Exited (137) 2 hours ago', CreatedAt: '2026-09-20 10:00:00 +0000 UTC' },
  { ID: 'c3', Names: 'cache', Image: 'redis:7', State: 'restarting', Status: 'Restarting (1) 5 seconds ago', CreatedAt: '2026-09-20 10:00:00 +0000 UTC' },
].map((row) => JSON.stringify(row)).join('\n') + '\n';
const podmanRows = JSON.stringify([
  { Id: 'd4', Names: ['db'], Image: 'postgres:16', State: 'running', Status: 'Up 5 days', Restarts: 0, Created: 1758000000, StartedAt: 1758000100, Exited: false },
  { Id: 'e5', Names: ['backup'], Image: 'restic', State: 'exited', Status: 'Exited (0) 6 hours ago', Restarts: 0, Created: 1758000000, StartedAt: 1758000100, Exited: true, ExitCode: 0 },
  { Id: 'f6', Names: ['api'], Image: 'api:3', State: 'running', Status: 'Up 2 minutes (unhealthy)', Restarts: 4, Created: 1758000000, StartedAt: 1758000100, Exited: false },
]);
const incusRows = JSON.stringify([
  { name: 'vm-1', project: 'default', type: 'virtual-machine', status: 'Running', created_at: '2026-09-01T00:00:00Z' },
  { name: 'old-lab', project: 'default', type: 'container', status: 'Stopped', created_at: '2026-09-01T00:00:00Z' },
]);
const transport: ContainerTransport = async (_target, engine) => ({ code: 0, stdout: engine === 'docker' ? dockerRows : engine === 'podman' ? podmanRows : incusRows });

test('the projection keeps names private, normalizes states across engines, and selects only containers that need a look', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'containers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = parseContainers('docker', dockerRows);
  assert.deepEqual(docker.map((r) => [r.fact.state, r.fact.exitCode, r.fact.unhealthy]), [['running', null, false], ['exited', 137, null], ['restarting', null, null]]);
  const podman = parseContainers('podman', podmanRows);
  assert.deepEqual(podman.map((r) => [r.fact.state, r.fact.exitCode, r.fact.restarts, r.fact.unhealthy]), [['running', null, 0, null], ['exited', 0, 0, null], ['running', null, 4, true]]);
  assert.equal(podman[0].fact.startedAt, new Date(1758000100 * 1000).toISOString());
  const incus = parseContainers('incus', incusRows);
  assert.deepEqual(incus.map((r) => [r.fact.kind, r.fact.state]), [['instance', 'running'], ['instance', 'stopped']]);

  const observation = await collectContainers(target, { directory: join(directory, 'run'), transport });
  assert.equal(observation.status, 'completed');
  assert.equal(observation.facts.length, 8);
  assert.equal(observation.eligible, 3);
  assert.equal(JSON.stringify(observation).includes('worker'), false);
  const names = JSON.parse(await readFile(join(directory, 'run', 'containers.private.json'), 'utf8'));
  const selectedNames = observation.selected.map((id) => names[id].name).sort();
  assert.deepEqual(selectedNames, ['api', 'cache', 'worker']);
  assert.equal(selectContainerFacts(observation.facts).omitted, 0);
});

function scripted(responses: unknown[]) {
  let index = 0;
  return new MockLanguageModelV3({ doStream: async () => {
    const response = responses[index++];
    if (response === undefined) throw new Error('Fixture exhausted');
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: String(index), toolName: 'submit_result', input: JSON.stringify(response) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
}

test('triage partitions the selected containers, respects the gates, and records rejections before accepting', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'triage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observation = await collectContainers(target, { directory: join(directory, 'source'), transport });
  const byName = Object.fromEntries(Object.entries(JSON.parse(await readFile(join(directory, 'source', 'containers.private.json'), 'utf8')) as Record<string, { name: string }>).map(([id, n]) => [n.name, id]));
  const finding = (name: string, classification: string, extra: string[] = []) => ({ containerId: byName[name], classification, reason: `Facts show ${classification.replaceAll('_', ' ')} for this container.`, nextInvestigation: 'Read its recent log lines and check when it last restarted.', evidenceIds: [byName[name], ...extra] });
  const gate = classificationGate(observation.facts.find((f) => f.id === byName.worker)!);
  assert.deepEqual(gate, { attentionAllowed: true, historicalAllowed: true });
  assert.throws(() => validateTriageResult({ schemaVersion: 1, findings: [finding('worker', 'attention_now')] }, observation), /FINDING_PARTITION/);
  assert.throws(() => validateTriageResult({ schemaVersion: 1, findings: [finding('worker', 'attention_now'), finding('cache', 'historical'), finding('api', 'attention_now')] }, observation), /CLASSIFICATION_NOT_PERMITTED/);

  const good = { schemaVersion: 1, findings: [finding('worker', 'historical'), finding('cache', 'attention_now'), finding('api', 'attention_now')] };
  const bad = { schemaVersion: 1, findings: [finding('worker', 'attention_now', ['r-' + 'f'.repeat(64)]), finding('cache', 'attention_now'), finding('api', 'attention_now')] };
  const run = await triageContainers(observation, { provider: 'copilot', modelId: 'gpt-5.6-terra', directory: join(directory, 'triage'), modelFactory: async () => scripted([bad, good]) });
  assert.equal(run.status, 'completed', run.failure);
  assert.deepEqual(findingCounts(run.result), { attentionNow: 2, historical: 1, insufficientEvidence: 0 });
  assert.deepEqual(run.events.filter((e) => e.type === 'resultRejected').map((e) => e.rejection), ['INVALID_EVIDENCE']);
  assert.equal(JSON.stringify(run).includes('cache'), false);
});

test('an investigation with nothing to assess completes without a model call', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quiet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quiet: ContainerTransport = async () => ({ code: 0, stdout: JSON.stringify([{ Id: 'x', Names: ['fine'], State: 'running', Status: 'Up 1 day', Restarts: 0 }]) });
  const run = await investigateContainers({ ...target, engines: ['podman'] }, { provider: 'copilot', modelId: 'gpt-5.6-terra', directory: join(directory, 'run'), transport: quiet, modelFactory: async () => { throw new Error('must not be called'); } });
  assert.equal(run.status, 'completed');
  assert.equal(run.modelInvoked, false);
  assert.deepEqual(run.result, { schemaVersion: 1, findings: [] });
  const unavailable: ContainerTransport = async () => ({ code: 69, stdout: '' });
  const missing = await investigateContainers({ ...target, engines: ['docker'] }, { provider: 'copilot', modelId: 'gpt-5.6-terra', directory: join(directory, 'missing'), transport: unavailable, modelFactory: async () => { throw new Error('must not be called'); } });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.failure, 'source_unavailable');
});
