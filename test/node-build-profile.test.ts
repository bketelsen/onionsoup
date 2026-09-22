import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { RepositoryProfile, NodeBuildVerification, NodeVerificationPlan, Task, validateTask } from '../src/project-change/repository-profile.ts';
import { Runtime } from '../src/project-change/contracts.ts';
import { proposeProject, acceptProject } from '../src/project-change/proposal.ts';
import { provisionDependencies } from '../src/project-change/dependencies.ts';
import { verifyProject } from '../src/project-change/sandbox.ts';
import { hash } from '../src/repository-brief/contracts.ts';

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const siteProfile = await json(new URL('../examples/repository-profiles/brian-ketelsen-site.json', import.meta.url).pathname);

test('a Node profile may verify by building instead of by tests, and the build request stays a closed schema', () => {
  const profile = RepositoryProfile.parse(siteProfile);
  assert.ok('build' in profile.verification);
  assert.deepEqual(profile.verification.required, ['node-build']);
  assert.throws(() => NodeBuildVerification.parse({ required: ['node-build'], build: { bin: '../escape', args: [] } }));
  assert.throws(() => NodeBuildVerification.parse({ required: ['node-build'], build: { bin: 'astro', args: ['build; rm -rf /'] } }));
  const withTests = RepositoryProfile.parse({ ...siteProfile, verification: { required: ['node-typecheck', 'node-tests'], testFiles: ['test/site.test.ts'] } });
  assert.ok('testFiles' in withTests.verification);
});

const claim = (text: string, evidenceIds = ['issue:body']) => ({ text, basis: 'proposed' as const, evidenceIds });
const requirements = { schemaVersion: 1, status: 'sufficient_for_proposal', userNeed: claim('Refresh the home page intro.'), scenarios: [claim('The intro reads as requested.')], constraints: [claim('Keep the layout.')], nonGoals: [], questions: [] };
const proposal = {
  schemaVersion: 1, status: 'proposal_ready', outcome: claim('Update the intro copy.'), changes: [claim('Edit the intro paragraph.', ['issue:body', 'source:1'])], nonGoals: [],
  acceptanceCriteria: [{ id: 'AC1', criterion: claim('The intro shows the new copy.') }],
  verification: [
    { criterionIds: ['AC1'], kind: 'acceptance', check: claim('Build the site and read the home page.'), baselineExpectation: 'existing_behavior' },
    { criterionIds: ['AC1'], kind: 'compatibility', check: claim('Every other page still builds.'), baselineExpectation: 'existing_behavior' },
  ],
  compatibility: claim('Only copy changes.'), migration: claim('None.'), documentation: claim('None needed.'), questions: [], risks: [],
};
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

// Live proof against the real site checkout and pinned runtime: the sandbox builds the site at its base commit.
//   ONIONSOUP_SITE_CHECKOUT=/abs/path/to/brian-ketelsen-site ONIONSOUP_FIXTURE_RUNTIME=/abs/path/site-runtime.json
test('the site profile builds in the sandbox at its base commit', { skip: !process.env.ONIONSOUP_SITE_CHECKOUT }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-site-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = resolve(process.env.ONIONSOUP_SITE_CHECKOUT!);
  const commit = (await promisify(execFile)('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
  const profile = RepositoryProfile.parse(siteProfile);
  const runtime = Runtime.parse(await json(process.env.ONIONSOUP_FIXTURE_RUNTIME!));
  const plan = NodeVerificationPlan.parse({ schemaVersion: 1, adapter: 'node-typescript-v1', source: 'export {};\n', checks: [{ id: 'task-index-changed', kind: 'file-changed', path: 'src/pages/index.astro' }] });
  const task = Task.parse({
    schemaVersion: 1, id: 'site-intro-copy', repositoryProfileHash: hash(profile), baseCommit: commit, title: 'Refresh the home page intro',
    request: 'Operator-authored request: refresh the intro paragraph on the home page. Only src/pages/index.astro may change.',
    allowedFiles: ['src/pages/index.astro'], context: [{ path: 'src/pages/index.astro', startLine: 1, endLine: 12 }],
    verificationHash: hash(plan), checks: [{ id: 'task-index-changed', baseline: 'observe' }],
  });
  validateTask(profile, task, plan);
  const dependencies = await provisionDependencies(checkout, commit, join(root, 'dependencies'));
  const proposalDirectory = join(root, 'proposal');
  // One adapter serves both project agents in order: requirements first, then the proposal.
  const adapter = { provider: 'copilot' as const, modelId: 'gpt-5.6-terra' as const, model: scripted([requirements, proposal]) };
  const modelFactory = async () => adapter;
  const proposed = await proposeProject(checkout, commit, proposalDirectory, { repositoryProfile: profile, task, models: modelFactory });
  assert.equal(proposed.status, 'completed');
  const job = await acceptProject(checkout, proposalDirectory, [{ criterionId: 'AC1', checks: ['node-build', 'task-index-changed'] }], 'Site build qualification.', { runtime, dependencies, verificationPlan: plan });
  const baseline = await verifyProject(checkout, commit, job, runtime, dependencies, [], { directory: join(root, 'baseline'), phase: 'baseline', verificationPlan: plan });
  const observed = JSON.parse(await readFile(join(root, 'baseline', 'observations.json'), 'utf8')) as { stdout: string; stderr: string };
  const detail = () => `status=${baseline.status} stdout=${observed.stdout.slice(-1500)} stderr=${observed.stderr.slice(-1500)}`;
  assert.equal(baseline.cleanup, 'removed', detail());
  assert.equal(baseline.checks.find((c) => c.id === 'node-build')?.status, 'passed', detail());
  assert.equal(baseline.checks.find((c) => c.id === 'task-index-changed')?.status, 'failed');
  assert.equal(baseline.status, 'checks_failed');
});
