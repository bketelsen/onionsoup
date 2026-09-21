import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { openJobHost, type JobHost } from '@onionsoup/job-host';
import { triage } from '@onionsoup/maintenance/triage';
import { createPacket } from '@onionsoup/maintenance/packet';
import { createChangeProposal } from '@onionsoup/maintenance/proposal/recipe';
import type { Source } from '@onionsoup/maintenance/github-issues';
import { registeredCapabilities } from '../src/index.ts';

const commit = 'a'.repeat(40);
const issue = { schemaVersion: 1 as const, repository: 'bketelsen/widget', number: 7, updatedAt: '2026-09-18T12:00:00Z', title: 'Add list export', body: 'Export the current list to JSON. Preserve existing list output.' };
const claim = (text: string, evidenceIds = ['issue:body']) => ({ text, basis: 'proposed' as const, evidenceIds });
const requirements = { schemaVersion: 1, status: 'sufficient_for_proposal', userNeed: claim('Export a list.'), scenarios: [claim('List exports JSON.')], constraints: [claim('Preserve list output.')], nonGoals: [], questions: [] };
const proposal = {
  schemaVersion: 1, status: 'proposal_ready', outcome: claim('Export list as JSON.'), changes: [claim('Add JSON export.', ['issue:body', 'source:1'])], nonGoals: [],
  acceptanceCriteria: [{ id: 'AC1', criterion: claim('JSON represents every listed entry.') }],
  verification: [
    { criterionIds: ['AC1'], kind: 'acceptance', check: claim('Compare parsed JSON entries to the fixture list.'), baselineExpectation: 'capability_absent' },
    { criterionIds: ['AC1'], kind: 'compatibility', check: claim('Compare current list output unchanged.'), baselineExpectation: 'existing_behavior' },
  ],
  compatibility: claim('Preserve list output.'), migration: claim('Propose no migration.'), documentation: claim('Document export.'), questions: [], risks: [],
};
const source = { id: 'source:1', path: 'widget.ts', startLine: 1, endLine: 1, quote: 'export const list = [];', relevance: 'unassessed_search_lead' as const };
const preparation = { sources: [source], attempts: [{ operation: 'search' as const, status: 'completed' as const }], limitations: ['Only one search lead.'] };
const assessment = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable', summary: 'Requests a JSON export.', evidence: [], questions: [] };

function scripted(tool: string, responses: unknown[]) {
  let index = 0;
  return new MockLanguageModelV3({ provider: 'fixture', modelId: 'scripted', doStream: async () => {
    const response = responses[index++];
    if (response === undefined) throw new Error('Fixture exhausted');
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: String(index), toolName: tool, input: JSON.stringify(response) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
}
const adapter = (model: MockLanguageModelV3) => ({ provider: 'copilot' as const, modelId: 'gpt-5.6-terra' as const, model });

async function settled(host: JobHost, id: string) {
  for (let n = 0; n < 600; n++) {
    const job = await host.inspect('web', id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timeout');
}

test('approval fixes an in-profile task from a real proposal; implement and publish bind to it and refuse the wrong parents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'implementation-host-'));

  // Build a completed proposal workflow the way the maintenance capabilities would.
  const readiness = await triage(issue, { ...adapter(scripted('submit_assessment', [assessment])) });
  const packet = await createPacket(issue, { directory: join(root, 'packet'), checkout: '/unused', commit, provider: 'copilot', readiness });
  let proposalCalls = 0;
  const workflow = await createChangeProposal(packet, {
    directory: join(root, 'proposal'), provider: 'copilot', checkout: '/unused', query: 'list', prepareFeature: async () => structuredClone(preparation),
    modelFactory: async () => adapter(scripted('submit_result', [proposalCalls++ === 0 ? requirements : proposal])),
  });
  assert.equal(workflow.status, 'completed');

  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  const profile = {
    schemaVersion: 1, id: 'widget-v1', repository: 'bketelsen/widget', repositoryId: 1, baseBranch: 'main',
    execution: { adapter: 'node-typescript-v1', sandbox: 'offline-node-v1', toolchain: { version: 'v24.19.0', digest: 'a'.repeat(64) }, dependencies: 'public-locked-npm-v1' },
    verification: { required: ['node-typecheck', 'node-tests'], testFiles: ['test/widget.test.ts'] },
    changes: { allowed: ['widget.ts', 'src/**'], protected: [], maximumFiles: 3, existingTests: 'append-only' }, publication: 'draft',
  };
  const files = { profile: join(root, 'profile.json'), runtime: join(root, 'runtime.json'), publication: join(root, 'publication.json') };
  await writeFile(files.profile, JSON.stringify(profile));
  await writeFile(files.runtime, JSON.stringify({ schemaVersion: 1, imageId: 'sha256:' + 'a'.repeat(64), nodePath: '/fixture/node', nodeHash: 'b'.repeat(64), podmanVersion: 'fixture' }));
  await writeFile(files.publication, JSON.stringify({ schemaVersion: 1, stateDirectory: join(root, 'publications'), targets: [{ repository: 'bketelsen/widget', repositoryId: 1, baseBranch: 'main', baseCommit: commit }] }));

  const githubSource: Source = {
    scan: async () => { throw new Error('not used'); },
    get: async (repository, number) => ({ number, title: issue.title, state: 'open', updatedAt: issue.updatedAt, observedAt: new Date().toISOString(), commentsExcluded: 0, snapshot: { ...issue, repository, number } }),
  };
  const pipelineCalls: string[] = [];
  let acceptedMapping: unknown;
  let proposedTask: any;
  const capabilities = registeredCapabilities({ schemaVersion: 1, provider: 'copilot', repositories: [{ name: 'bketelsen/widget', checkout, implementation: { ...files, target: 0 } }] }, {
    modelFactory: async () => { throw new Error('no live model in this test'); },
    repositoryBrief: async () => { throw new Error('not used'); },
    maintenance: { source: githubSource, head: async () => commit, packet: async () => packet, proposal: async () => workflow },
    implementation: { pipeline: {
      provisionNode: async () => { pipelineCalls.push('provision'); return { schemaVersion: 1 } as any; },
      propose: async (_checkout, _commit, _dir, _provider, options) => { pipelineCalls.push('propose'); proposedTask = options?.task; return { status: 'completed', proposal: { result: proposal } } as any; },
      accept: async (_checkout, _dir, mapping) => { pipelineCalls.push('accept'); acceptedMapping = mapping; return {} as any; },
      execute: async () => { pipelineCalls.push('execute'); throw new Error('sandbox_unavailable_in_test'); },
    } },
  });
  const ids = capabilities.map((c) => c.id);
  assert.ok(['change.approve', 'change.implement', 'change.publish'].every((id) => ids.includes(id)));
  assert.equal(capabilities.find((c) => c.id === 'change.approve')?.interactive, true);
  const host = await openJobHost({ directory: join(root, 'host'), binding: {}, capabilities, invokers: [{ id: 'web', capabilities: ids }] });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

  const packetJob = await host.submit('web', { capability: 'investigation.packet', idempotencyKey: 'packet-job-1', input: { repository: 'bketelsen/widget', issue: 7 } });
  assert.equal((await settled(host, packetJob.jobId)).status, 'completed');
  const proposalJob = await host.submit('web', { capability: 'change.proposal', idempotencyKey: 'proposal-job-1', input: { packetJobId: packetJob.jobId, query: 'list' } });
  assert.equal((await settled(host, proposalJob.jobId)).status, 'completed');

  const wrongParent = await host.submit('web', { capability: 'change.approve', idempotencyKey: 'approve-wrong', input: { proposalJobId: packetJob.jobId, reason: 'x' } });
  assert.equal((await settled(host, wrongParent.jobId)).error, 'dependency_not_proposal');
  const outside = await host.submit('web', { capability: 'change.approve', idempotencyKey: 'approve-outside', input: { proposalJobId: proposalJob.jobId, reason: 'x', allowedFiles: ['package.json'] } });
  assert.equal((await settled(host, outside.jobId)).error, 'files_outside_profile:package.json');

  const approveJob = await host.submit('web', { capability: 'change.approve', idempotencyKey: 'approve-1', input: { proposalJobId: proposalJob.jobId, reason: 'Matches what I want.' } });
  const approved = await settled(host, approveJob.jobId);
  assert.equal(approved.status, 'completed', approved.error);
  const approval = (approved.result as { approval: any }).approval;
  assert.deepEqual(approval.task.allowedFiles, ['widget.ts']);
  assert.deepEqual(approval.task.context, [{ path: 'widget.ts', startLine: 1, endLine: 1 }]);
  assert.match(approval.task.request, /Acceptance criteria:\n- AC1/);
  assert.equal(approval.reason, 'Matches what I want.');
  assert.equal(approval.baseCommit, commit);

  const implementJob = await host.submit('web', { capability: 'change.implement', idempotencyKey: 'implement-1', input: { approvalJobId: approveJob.jobId } });
  const implemented = await settled(host, implementJob.jobId);
  assert.equal(implemented.status, 'failed');
  assert.equal(implemented.error, 'sandbox_unavailable_in_test');
  assert.deepEqual(pipelineCalls, ['provision', 'propose', 'accept', 'execute']);
  assert.equal(proposedTask.baseCommit, commit);
  assert.deepEqual(proposedTask.allowedFiles, ['widget.ts']);
  assert.deepEqual(acceptedMapping, [{ criterionId: 'AC1', checks: ['node-typecheck', 'node-tests', 'task-primary-file-changed'] }]);

  const publishWrong = await host.submit('web', { capability: 'change.publish', idempotencyKey: 'publish-wrong', input: { implementJobId: approveJob.jobId, reason: 'ship' } });
  assert.equal((await settled(host, publishWrong.jobId)).error, 'dependency_not_implementation');

  await assert.rejects(host.saveRecipe('web', { schemaVersion: 1, id: 'auto-approve', title: 'No', steps: [{ id: 'a', capability: 'change.approve', input: {} }] }), /interactive_capability:change.approve/);
});
