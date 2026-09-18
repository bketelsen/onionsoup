import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { LocationSource } from '../src/location-source.ts';
import { resolveBrief, LOCATION_LIMITS, type BriefDraft } from '../src/location-contracts.ts';
import { locateCode, type LocationRun } from '../src/location-agent.ts';
import { makeLocationInput, validateLocationRun, locateInboxIssues, loadLocationRuns, locationFilename, attachedLocation } from '../src/location-workflow.ts';
import { initialize, atomicJson, attemptPath, contentHash } from '../src/inbox-store.ts';
import { observe } from '../src/inbox-source.ts';
import { triage } from '../src/triage.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { fields } from '../src/contracts.ts';
import { renderInbox } from '../src/inbox-report.ts';

const execute = promisify(execFile);
const repository = 'example/widget';
const observed = observe({ number: 1, title: 'Artifact fails', body: 'Run build. Expected success. Saw ENOENT. Linux v1.',
  state: 'open', updated_at: '2026-09-18T12:00:00Z', comments: 0 }, repository, '2026-09-18T12:01:00Z')!;
const assessment = { schemaVersion: 2, kind: 'bug_report', bug_readiness: 'ready', summary: 'Artifact fails on Linux.',
  evidence: fields.map((field, i) => ({ field, source: 'body', quote: ['Run build.', 'Expected success.', 'Saw ENOENT.', 'Linux v1.'][i] })), questions: [] };
const code = ['export function buildArtifact() {', '  return run("npm");', '}', 'const text = "</script><img src=x onerror=alert(1)>";'];
const tests = ['import { buildArtifact } from "./artifact";', 'test("artifact", () => buildArtifact());'];
const draft: BriefDraft = { status: 'located', summary: 'Start at the artifact builder.',
  codePointers: [{ excerptId: 'E1', startLine: 1, endLine: 4, symbol: 'buildArtifact', reason: 'Calls the reported program.' }],
  testPointers: [{ excerptId: 'E2', startLine: 1, endLine: 2, symbol: 'buildArtifact', reason: 'Exercises the builder.' }],
  uncertainties: ['The pinned source may differ from the reported release.'] };
type Call = { name: string; input: unknown };
const calls: Call[] = [
  { name: 'search_repository', input: { query: 'buildArtifact', scope: 'code', pathPrefix: 'src' } },
  { name: 'read_repository', input: { path: 'src/artifact.ts', startLine: 1, endLine: 4 } },
  { name: 'search_repository', input: { query: 'buildArtifact', scope: 'tests', pathPrefix: '' } },
  { name: 'read_repository', input: { path: 'src/artifact.test.ts', startLine: 1, endLine: 2 } },
  { name: 'submit_brief', input: draft },
];
function modelFor(script: Call[]) {
  let next = 0;
  return new MockLanguageModelV3({ provider: 'fixture', modelId: 'scripted', doStream: async () => {
    const call = script[next++]; if (!call) throw new Error('Fixture exhausted');
    return { stream: simulateReadableStream({ chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: `fixture-${next}`, toolName: call.name, input: JSON.stringify(call.input) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } },
    ], initialDelayInMs: null, chunkDelayInMs: null }) };
  } });
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-location-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'repo'); await mkdir(join(checkout, 'src'), { recursive: true });
  const git = (...args: string[]) => execute('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  await git('init', '-q'); await git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
  await Promise.all([
    writeFile(join(checkout, 'src/artifact.ts'), code.join('\n') + '\n'),
    writeFile(join(checkout, 'src/artifact.test.ts'), tests.join('\n') + '\n'),
    writeFile(join(checkout, '.env'), 'buildArtifact=secret'),
    writeFile(join(checkout, 'binary'), Buffer.from([0, 1, 2])),
    writeFile(join(checkout, 'large'), 'x'.repeat(LOCATION_LIMITS.fileBytes + 1)),
    writeFile(join(checkout, 'many-lines'), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')),
    symlink('/etc/passwd', join(checkout, 'link')),
  ]);
  await git('add', '.'); await git('commit', '-qm', 'fixture');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  const parent = await triage(observed.snapshot, { model: fixtureModel([assessment]), provider: 'copilot', modelId: 'gpt-5.6-terra' });
  assert.equal(parent.status, 'completed');
  const input = makeLocationInput(parent, observed, commit);
  return { directory, checkout, commit, parent, input, git };
}

test('handoff admits only matching ready bugs and preserves original identity across metadata changes', async t => {
  const f = await fixture(t);
  for (const observation of [{ ...observed, state: 'closed' as const },
    { ...observed, snapshot: { ...observed.snapshot!, body: 'Changed report' } }])
    assert.throws(() => makeLocationInput(f.parent, observation, f.commit), /INELIGIBLE/);
  assert.throws(() => makeLocationInput({ ...f.parent, status: 'failed' }, observed, f.commit));
  assert.throws(() => makeLocationInput({ ...f.parent, inputHash: '0'.repeat(64) }, observed, f.commit));
  for (const changed of [
    { ...assessment, kind: 'feature_request', bug_readiness: 'not_applicable', evidence: [] },
    { ...assessment, bug_readiness: 'needs_information', evidence: assessment.evidence.slice(1), questions: [{ field: 'reproduction', question: 'How?' }] },
  ]) assert.throws(() => makeLocationInput({ ...f.parent, assessment: changed as typeof f.parent.assessment }, observed, f.commit));
  const metadata = { ...observed, snapshot: { ...observed.snapshot!, updatedAt: '2026-09-18T13:00:00Z' } };
  assert.deepEqual(makeLocationInput(f.parent, metadata, f.commit), f.input);
});

test('source tools read pinned blobs, exclude unsafe files, and enforce limits', async t => {
  const f = await fixture(t);
  await writeFile(join(f.checkout, 'src/artifact.ts'), 'dirty working copy');
  const source = await LocationSource.open(f.checkout, repository, f.commit);
  const search = await source.search({ query: 'buildArtifact', scope: 'code', pathPrefix: '' });
  assert.deepEqual(search.matches.map(m => m.path), ['src/artifact.ts']);
  assert.equal((await source.read({ path: 'src/artifact.ts', startLine: 1, endLine: 4 })).numberedLines, code.map((line, i) => `${i + 1}: ${line}`).join('\n'));
  for (const path of ['../outside', 'link', '.env', 'binary', 'large'])
    await assert.rejects(source.read({ path, startLine: 1, endLine: 2 }));
  const page = await source.read({ path: 'many-lines', startLine: 5, endLine: 100 });
  assert.equal(page.endLine, 64); assert.equal(page.truncated, true); assert.equal(page.nextStartLine, 65);
  assert.equal(source.excerpts.at(-1)?.lines.length, 60);
  assert.throws(() => resolveBrief({ ...draft, codePointers: [{ ...draft.codePointers[0], excerptId: page.excerptId, startLine: 65, endLine: 65 }], testPointers: [] }, source.excerpts, true), /UNREAD_CITATION/);
  while (source.calls < LOCATION_LIMITS.inspectionCalls) await source.search({ query: 'no-match', scope: 'tests', pathPrefix: '' });
  await assert.rejects(source.read({ path: 'src/artifact.ts', startLine: 1, endLine: 1 }), /BUDGET/);
  assert.equal(source.excerpts.length, 2);
  await assert.rejects(LocationSource.open(f.checkout, 'wrong/repository', f.commit), /REPOSITORY_MISMATCH/);
  await assert.rejects(LocationSource.open(f.checkout, repository, '0'.repeat(40)));
});

test('citations must use read excerpts, actual symbol text, appropriate paths, and a test search', () => {
  const excerpts = [{ id: 'E1', path: 'src/artifact.ts', startLine: 1, endLine: 4, lines: code },
    { id: 'E2', path: 'src/artifact.test.ts', startLine: 1, endLine: 2, lines: tests }];
  assert.equal(resolveBrief(draft, excerpts, true).codePointers[0].quote, code.join('\n'));
  assert.throws(() => resolveBrief(draft, excerpts, false), /TEST_SEARCH/);
  for (const change of [{ excerptId: 'E99' }, { startLine: 0 }, { endLine: 5 }, { symbol: 'inventedFunction' }, { excerptId: 'E2', endLine: 2 }])
    assert.throws(() => resolveBrief({ ...draft, codePointers: [{ ...draft.codePointers[0], ...change }] }, excerpts, true));
  assert.throws(() => resolveBrief({ ...draft, testPointers: draft.codePointers }, excerpts, true), /TEST_PATH/);
  const noResult = { ...draft, status: 'not_located', codePointers: [], testPointers: [] };
  assert.equal(resolveBrief(noResult, [], true).status, 'not_located');
});

test('empty scoped searches broaden explicitly while retaining test scope and source bounds', async t => {
  const f = await fixture(t);
  const source = await LocationSource.open(f.checkout, repository, f.commit);
  const result = await source.search({ query: 'buildArtifact', scope: 'tests', pathPrefix: 'wrong/plugin' });
  assert.equal(result.broadened, true);
  assert.deepEqual(result.searchedPrefixes, ['wrong/plugin', '']);
  assert.ok(result.matches.length > 0);
  assert.ok(result.matches.every(m => m.path === 'src/artifact.test.ts'));
  assert.equal(source.calls, 1);
  const scoped = await source.search({ query: 'buildArtifact', scope: 'code', pathPrefix: 'src' });
  assert.equal(scoped.broadened, false);
  assert.deepEqual(scoped.searchedPrefixes, ['src']);
  const absent = await source.search({ query: 'absent', scope: 'tests', pathPrefix: '' });
  assert.equal(absent.broadened, false); assert.deepEqual(absent.matches, []);
  await assert.rejects(source.search({ query: 'anything', scope: 'all', pathPrefix: '../outside' }));
});

test('related test filenames are bounded hints, never read evidence or confirmed test coverage', async t => {
  const f = await fixture(t);
  await mkdir(join(f.checkout, 'tests'));
  for (let n = 0; n < 9; n++) await writeFile(join(f.checkout, `tests/artifact.variant${n}.test.ts`), 'test("unverified", () => {});');
  await symlink('/etc/passwd', join(f.checkout, 'tests/artifact.link.test.ts'));
  await f.git('add', '.'); await f.git('commit', '-qm', 'test candidates');
  const commit = (await f.git('rev-parse', 'HEAD')).stdout.trim();
  const source = await LocationSource.open(f.checkout, repository, commit);
  const read = await source.read({ path: 'src/artifact.ts', startLine: 1, endLine: 4 });
  assert.equal(read.relatedTests?.paths[0], 'src/artifact.test.ts');
  assert.equal(read.relatedTests?.paths.length, 6); assert.equal(read.relatedTests?.truncated, true);
  assert.ok(!read.relatedTests?.paths.some(p => p.includes('.link.')));
  assert.equal(source.searchedTests, false);
  assert.equal(source.excerpts.length, 1);
  assert.throws(() => resolveBrief(draft, source.excerpts, true), /UNREAD_CITATION/);
  const historical = await LocationSource.open(f.checkout, repository, f.commit);
  const old = await historical.read({ path: 'src/artifact.ts', startLine: 1, endLine: 4 });
  assert.deepEqual(old.relatedTests?.paths, ['src/artifact.test.ts']);
});

test('real AgentLayer loop corrects unread citations and checkpoints a grounded result', async t => {
  const f = await fixture(t); const snapshots: LocationRun[] = [];
  const bad = { ...draft, codePointers: [{ ...draft.codePointers[0], excerptId: 'E99' }] };
  const model = modelFor([...calls.slice(0, 4), { name: 'submit_brief', input: bad }, calls[4]]);
  const run = await locateCode(f.input, { checkout: f.checkout, model, provider: 'fixture', modelId: 'scripted',
    checkpoint: async r => { snapshots.push(r); } });
  assert.equal(run.status, 'completed'); assert.equal(model.doStreamCalls.length, 6);
  assert.deepEqual(snapshots.map(s => s.status), ['running', 'completed']);
  assert.equal(run.brief?.codePointers[0].quote, code.join('\n'));
  assert.match(JSON.stringify(run.state), /UNREAD_CITATION/);
  assert.equal(validateLocationRun(JSON.parse(JSON.stringify(run))).runId, run.runId);
  const corrupt = structuredClone(run); corrupt.brief!.codePointers[0].quote = 'invented';
  assert.throws(() => validateLocationRun(corrupt), /not grounded/);
  assert.equal(attachedLocation([run], f.parent, observed.snapshot)?.runId, run.runId);
  assert.equal(attachedLocation([run], f.parent, { ...observed.snapshot!, body: 'edited' }), undefined);
});

test('invalid outputs exhaust bounded execution; failed admission and cancelled setup spend no tokens', async t => {
  const f = await fixture(t);
  const model = modelFor(Array(LOCATION_LIMITS.steps).fill({ name: 'submit_brief', input: draft }));
  const run = await locateCode(f.input, { checkout: f.checkout, model, provider: 'fixture', modelId: 'scripted' });
  assert.equal(run.status, 'failed'); assert.equal(run.failure, 'no_valid_brief'); assert.equal(run.brief, undefined);
  assert.equal(model.doStreamCalls.length, LOCATION_LIMITS.steps);
  const never = modelFor(calls); const options = { checkout: f.checkout, model: never, provider: 'fixture', modelId: 'scripted' };
  await assert.rejects(locateCode(f.input, { ...options, checkpoint: async () => { throw new Error('disk full'); } }), /disk full/);
  await assert.rejects(locateCode(f.input, { ...options, signal: AbortSignal.abort() }));
  assert.equal(never.doStreamCalls.length, 0);
});

test('host reserves submission and correction steps, retaining excerpts and summing phase usage', async t => {
  const f = await fixture(t);
  const bad = { ...draft, codePointers: [{ ...draft.codePointers[0], excerptId: 'E99' }] };
  const model = modelFor([...calls.slice(0, 4), ...Array(6).fill({ name: 'search_repository',
    input: { query: 'absent', scope: 'tests', pathPrefix: '' } }), { name: 'submit_brief', input: bad }, calls[4]]);
  const run = await locateCode(f.input, { checkout: f.checkout, model, provider: 'fixture', modelId: 'scripted' });
  assert.equal(run.status, 'completed');
  assert.equal(run.source.calls, 10);
  assert.deepEqual(model.doStreamCalls[10].tools?.map(t => t.name), ['submit_brief']);
  assert.deepEqual(model.doStreamCalls[11].tools?.map(t => t.name), ['submit_brief']);
  assert.deepEqual(run.events.filter(e => e.type === 'stepStart').map(e => e.step), Array.from({ length: 12 }, (_, i) => i));
  assert.equal(run.events.filter(e => e.type === 'finalizationStarted').length, 1);
  assert.equal(run.tokenUsage?.totals.inputTokens, 60);
  assert.equal(run.tokenUsage?.totals.outputTokens, 24);
  assert.equal(Object.values(run.tokenUsage!.byModel)[0].inputTokens, 60);
  assert.equal(run.brief?.codePointers[0].quote, code.join('\n'));
  assert.match(JSON.stringify(run.state), /UNREAD_CITATION/);
});

test('workflow retains failures, retries explicitly, caches success, and renders only matching grounded briefs', async t => {
  const f = await fixture(t); const directory = join(f.directory, 'inbox');
  await initialize(directory, repository, 'copilot');
  await atomicJson(join(directory, 'index.json'), { schemaVersion: 1, observations: [observed] });
  const attempt = { sequence: 1, contentHash: contentHash(f.parent.input), record: f.parent };
  await atomicJson(attemptPath(directory, attempt), attempt);
  const bad = modelFor(Array(LOCATION_LIMITS.steps).fill({ name: 'submit_brief', input: draft }));
  let model = bad;
  const options = { modelFactory: async (modelId = 'gpt-5.6-terra', provider: 'copilot' | 'codex' = 'copilot') => ({ model, modelId, provider }) };
  const dispatch = (retry = false) => locateInboxIssues(directory, f.checkout, f.commit, [1], { ...options, retry });
  assert.equal((await dispatch())[0].status, 'failed');
  const failure = (await loadLocationRuns(directory))[0]; const file = join(directory, 'locations', locationFilename(failure));
  const before = await readFile(file, 'utf8');
  model = modelFor(calls);
  assert.equal((await dispatch())[0].status, 'skipped_failed'); assert.equal(model.doStreamCalls.length, 0);
  assert.equal((await dispatch(true))[0].status, 'completed'); assert.equal(model.doStreamCalls.length, 5);
  assert.equal((await dispatch(true))[0].status, 'skipped_completed'); assert.equal(model.doStreamCalls.length, 5);
  assert.equal(await readFile(file, 'utf8'), before); assert.equal((await loadLocationRuns(directory)).length, 2);
  assert.equal((await renderInbox(directory)).locationBriefs, 1);
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  assert.ok(html.includes(`/blob/${f.commit}/src/artifact.ts#L1-L4`));
  assert.ok(!html.includes('</script><img')); assert.match(html, /&lt;img/);
  const edited = { ...observed, snapshot: { ...observed.snapshot!, body: 'Edited report' } };
  await atomicJson(join(directory, 'index.json'), { schemaVersion: 1, observations: [edited] });
  assert.equal((await dispatch())[0].status, 'ineligible');
  assert.equal((await renderInbox(directory)).locationBriefs, 0);
});
