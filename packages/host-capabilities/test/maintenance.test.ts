import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { openJobHost, type JobHost } from '@onionsoup/job-host';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { IssueSnapshot } from '@onionsoup/maintenance/contracts';
import type { Source } from '@onionsoup/maintenance/github-issues';
import { registeredCapabilities } from '../src/index.ts';

const example = new URL('../../../examples/', import.meta.url);
const issue = IssueSnapshot.parse({ ...JSON.parse(await readFile(new URL('incomplete-bug.json', example), 'utf8')), repository: 'example/widget' });
const assessment = JSON.parse(await readFile(new URL('incomplete-assessment.json', example), 'utf8'));

function scripted(responses: unknown[]) {
  let next = 0;
  return new MockLanguageModelV3({ provider: 'fixture', modelId: 'scripted', doStream: async () => {
    const input = responses[next++];
    if (input === undefined) throw new Error('Fixture exhausted');
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: `fixture-${next}`, toolName: 'submit_assessment', input: JSON.stringify(input) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } },
    ] }) };
  } });
}
const source: Source = {
  scan: async () => { throw new Error('not used'); },
  get: async (repository, number) => ({ number, title: issue.title, state: 'open', updatedAt: issue.updatedAt, observedAt: new Date().toISOString(), commentsExcluded: 0, snapshot: { ...issue, repository, number } }),
};
async function settled(host: JobHost, id: string) {
  for (let n = 0; n < 400; n++) {
    const job = await host.inspect('web', id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timeout');
}

test('maintenance capabilities run readiness from the catalog and refuse ineligible or unconfigured handoffs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-host-'));
  let modelCalls = 0;
  const capabilities = registeredCapabilities({ schemaVersion: 1, provider: 'copilot', repositories: [{ name: 'example/widget' }] }, {
    modelFactory: async (modelId, provider) => { modelCalls++; return { model: scripted([assessment]), provider: provider as 'copilot', modelId: modelId as typeof EVALUATION_MODEL }; },
    repositoryBrief: async () => { throw new Error('not used'); },
    maintenance: { source },
  });
  const ids = capabilities.map((c) => c.id);
  assert.deepEqual(ids, ['repository.brief', 'issue.readiness', 'code.location', 'investigation.packet', 'change.proposal']);
  const host = await openJobHost({ directory, binding: {}, capabilities, invokers: [{ id: 'web', capabilities: ids }] });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });

  await assert.rejects(host.submit('web', { capability: 'issue.readiness', idempotencyKey: 'bad-repo-1', input: { repository: 'other/repo', issue: 1 } }));
  const readiness = await host.submit('web', { capability: 'issue.readiness', idempotencyKey: 'readiness-1', input: { repository: 'example/widget', issue: 7 } });
  const done = await settled(host, readiness.jobId);
  assert.equal(done.status, 'completed', done.error);
  const result = done.result as { issue: { number: number }; run: { status: string; assessment: { bug_readiness: string } } };
  assert.equal(result.issue.number, 7);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.assessment.bug_readiness, 'needs_information');
  assert.equal(modelCalls, 1);
  assert.ok(await readFile(join(directory, readiness.jobId, 'readiness.json'), 'utf8'));

  const location = await host.submit('web', { capability: 'code.location', idempotencyKey: 'location-1', input: { readinessJobId: readiness.jobId } });
  const refused = await settled(host, location.jobId);
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error, 'readiness_not_eligible');

  const packet = await host.submit('web', { capability: 'investigation.packet', idempotencyKey: 'packet-1', input: { repository: 'example/widget', issue: 7 } });
  const unconfigured = await settled(host, packet.jobId);
  assert.equal(unconfigured.status, 'failed');
  assert.equal(unconfigured.error, 'no_checkout_configured:example/widget');

  const proposal = await host.submit('web', { capability: 'change.proposal', idempotencyKey: 'proposal-1', input: { packetJobId: readiness.jobId } });
  const wrongParent = await settled(host, proposal.jobId);
  assert.equal(wrongParent.status, 'failed');
  assert.equal(wrongParent.error, 'dependency_not_packet');
  assert.equal(modelCalls, 1);
});
