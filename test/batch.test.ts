import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import test from 'node:test';
import { selectCases } from '../src/batch-collect.ts';
import { BatchManifest, Feedback } from '../src/batch-contracts.ts';
import { atomicJson, freezeRuntime, readManifest, readRecord, recordPath, readReviews } from '../src/batch-store.ts';
import { runBatch } from '../src/batch-run.ts';
import { importFeedback, loadReviewedCases, summarizeModel } from '../src/batch-review.ts';
import { renderBatchReport, scriptJson } from '../src/batch-report.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { triage, inputHash } from '../src/triage.ts';
import { IssueSnapshot } from '../src/contracts.ts';
import { assessmentLabel } from '../src/assessment-view.ts';
import { EVALUATION_MODEL, assertEvaluationModels } from '../src/evaluation-policy.ts';

const input = IssueSnapshot.parse({ schemaVersion: 1, repository: 'example/widget', number: 42,
  updatedAt: '2026-09-18T12:00:00Z', title: 'Add a dark theme', body: 'Please add a dark theme.' });
const answer = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable', summary: 'A feature request', evidence: [], questions: [] };
async function batch() {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-batch-test-'));
  const manifest = BatchManifest.parse({ schemaVersion: 1, batchId: randomUUID(), capturedAt: input.updatedAt,
    repository: input.repository, provider: 'copilot', models: ['fixture-a', 'fixture-b'],
    selection: { seed: 'test', before: null, requestedCount: 1, fetchedEntries: 1, eligibleCount: 1,
      rejectedCount: 0, method: 'Test fixture' }, frozen: await freezeRuntime(),
    criteria: { minimumCases: 30, acceptanceRate: 0.9, allowedFalseReady: 0, costDecision: 'human_required' },
    cases: [{ input, inputHash: inputHash(input), url: 'https://github.com/example/widget/issues/42',
      commentsExcluded: 0, bucket: 'short', declaredAgentGenerated: false }] });
  await atomicJson(join(directory, 'manifest.json'), manifest);
  return { directory, manifest };
}
const factory = async (modelId = 'fixture-a') => ({ modelId, provider: 'copilot' as const, model: fixtureModel([answer]) });

test('selection is reproducible and excludes PRs, old pilot numbers, invalid inputs and duplicates', () => {
  const row = (number: number, body: string, extra = {}) => ({ number, body, title: 'Report',
    updated_at: input.updatedAt, comments: 0, ...extra });
  const rows = [row(1, 'Short'), row(2, 'A'.repeat(2000), { type: { name: 'Feature' } }),
    row(3, 'Sometimes ' + 'x'.repeat(2000)), row(4, 'Detailed '.repeat(300)),
    row(5, 'PR', { pull_request: {} }), row(6, 'x'.repeat(24001)), row(99, 'Pilot'), row(1, 'Duplicate')];
  const options = { count: 4, before: 90, seed: 'fixed' };
  const result = selectCases(rows, 'example/widget', options);
  assert.deepEqual(result.cases.map(c => c.bucket), ['short', 'feature', 'intermittent', 'detailed']);
  assert.deepEqual(result, selectCases([...rows].reverse().filter(r => r.body !== 'Duplicate'), 'example/widget', options));
  assert.equal(result.rejectedCount, 1);
  assert.throws(() => selectCases(rows, 'example/widget', { ...options, count: 5 }), /Only 4/);
});

test('batch runner preserves outcomes and resumes without additional model calls', async () => {
  const { directory } = await batch();
  let calls = 0;
  const trackedFactory = async (modelId?: string) => {
    const adapter = await factory(modelId);
    const original = adapter.model.doStream.bind(adapter.model);
    adapter.model.doStream = async opts => { calls++; return original(opts); };
    return adapter;
  };
  await runBatch(directory, { modelFactory: trackedFactory });
  assert.equal(calls, 2);
  await runBatch(directory, { modelFactory: trackedFactory });
  assert.equal(calls, 2);
  const { manifest, cases } = await loadReviewedCases(directory);
  const summary = summarizeModel(manifest, 'fixture-a', cases);
  assert.equal(summary.completed, 1);
  assert.equal(summary.reviewed, 0);
  assert.equal(summary.acceptanceRate, null);
  assert.equal(summary.falseReady, null);
  assert.equal(summary.billedCost, null);
});

test('frozen runtime and input tampering stop work before provider initialization', async () => {
  const { directory, manifest } = await batch();
  let initialized = false;
  manifest.frozen.promptText += '\nchanged';
  await atomicJson(join(directory, 'manifest.json'), manifest);
  await assert.rejects(runBatch(directory, { modelFactory: async () => { initialized = true; return factory(); } }), /Frozen runtime changed/);
  assert.equal(initialized, false);
  manifest.cases[0].input.body = 'Replaced snapshot';
  await atomicJson(join(directory, 'manifest.json'), manifest);
  await assert.rejects(readManifest(directory), /Snapshot identity/);
});

test('a concurrent runner is rejected instead of issuing duplicate requests', async () => {
  const { directory } = await batch();
  await writeFile(join(directory, '.run.lock'), 'another process');
  await assert.rejects(runBatch(directory, { modelFactory: factory }), /EEXIST/);
});

test('unfinished run is preserved, not silently reissued', async () => {
  const { directory, manifest } = await batch();
  const run = await triage(input, { ...await factory() });
  delete run.assessment;
  run.status = 'running';
  await atomicJson(recordPath(directory, 'fixture-a', 42), run);
  await assert.rejects(runBatch(directory, { modelFactory: factory }), /Interrupted record/);
  assert.equal((await readRecord(directory, manifest, 'fixture-a', 42))?.runId, run.runId);
});

test('feedback is run-bound, atomic, idempotent, and preserves revisions', async () => {
  const { directory, manifest } = await batch();
  await runBatch(directory, { modelFactory: factory });
  const run = (await readRecord(directory, manifest, 'fixture-a', 42))!;
  const review = Feedback.parse({ batchId: manifest.batchId, model: 'fixture-a', issue: 42, runId: run.runId,
    reviewer: 'Test reviewer', role: 'operator', verdict: 'accept', falseReady: false,
    unnecessaryQuestions: false, overlookedEvidence: false, unsupportedClaims: false, notes: '' });
  await assert.rejects(importFeedback(directory, { schemaVersion: 1, reviews: [review, { ...review, model: 'fixture-b', runId: randomUUID() }] }), /does not match/);
  assert.equal((await readReviews(directory)).reviews.length, 0);
  await importFeedback(directory, { schemaVersion: 1, reviews: [review] });
  await importFeedback(directory, { schemaVersion: 1, reviews: [review] });
  assert.equal((await readReviews(directory)).reviews.length, 1);
  await importFeedback(directory, { schemaVersion: 1, reviews: [{ ...review, verdict: 'revise', notes: 'Clarify the scope reason' }] });
  assert.equal((await readReviews(directory)).reviews.length, 2);
  assert.equal((await loadReviewedCases(directory)).cases[0].review?.verdict, 'revise');
  assert.throws(() => Feedback.parse({ ...review, unsupportedClaims: true }), /acceptance/);
  await assert.rejects(importFeedback(directory, { schemaVersion: 1, reviews: [{ ...review, runId: randomUUID() }] }), /does not match/);
});

test('graduation requires all reviews, zero false-ready, reliability, and explicit cost decision', async () => {
  const { manifest } = await batch();
  manifest.cases = Array.from({ length: 40 }, (_, i) => ({ ...manifest.cases[0], input: { ...input, number: i + 1 } }));
  const run = await triage(input, { ...await factory() });
  const rows = manifest.cases.map(c => ({ model: 'fixture-a', issue: c.input.number, run,
    review: { verdict: 'accept', falseReady: false } as Feedback }));
  assert.equal(summarizeModel(manifest, 'fixture-a', rows).readiness, 'pending_cost_review');
  rows[39].review = undefined!;
  assert.equal(summarizeModel(manifest, 'fixture-a', rows).qualityGate, 'pending_review');
  assert.equal(summarizeModel(manifest, 'fixture-a', rows).acceptanceRate, null);
  rows[39].review = { verdict: 'reject', falseReady: true } as Feedback;
  assert.equal(summarizeModel(manifest, 'fixture-a', rows).qualityGate, 'not_met');
  rows[39].review = { verdict: 'accept', falseReady: false } as Feedback;
  const cost = { acceptable: true, reviewer: 'Operator', note: 'Observed usage is acceptable', recordedAt: input.updatedAt };
  assert.equal(summarizeModel(manifest, 'fixture-a', rows, cost).readiness, 'supervised_pilot_eligible');
  rows[39].run = { ...run, status: 'failed', assessment: undefined };
  assert.equal(summarizeModel(manifest, 'fixture-a', rows, cost).qualityGate, 'not_met');
});

test('HTML report renders source and feedback as inert data and contains valid client code', async () => {
  const { directory, manifest } = await batch();
  manifest.models = ['fixture-a'];
  const payload = '</script><img src=x onerror=alert(1)>';
  manifest.cases[0].input.body = payload;
  manifest.cases[0].inputHash = inputHash(manifest.cases[0].input);
  await atomicJson(join(directory, 'manifest.json'), manifest);
  await runBatch(directory, { modelFactory: factory });
  await renderBatchReport(directory);
  const html = await readFile(join(directory, 'report.html'), 'utf8');
  assert.ok(!html.includes(payload));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<h3>Assessment<\/h3>/);
  assert.match(html, /feature_request · not_applicable/);
  assert.ok(!html.includes('Candidate 1'));
  assert.ok(!scriptJson({ notes: payload }).includes('</script>'));
  const clientCode = html.match(/<script>([\s\S]*)<\/script>/)![1];
  assert.doesNotThrow(() => new Script(clientCode));
  const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
  assert.equal(summary.models[0].acceptanceRate, null);
  assert.equal(summary.models[0].kinds.feature_request, 1);
  assert.equal(summary.models[0].bugReadiness.not_applicable, 1);
});

test('historical v1 outcomes and feedback remain readable without inventing a request type', async () => {
  const { directory, manifest } = await batch();
  const run = await triage(input, await factory());
  const old = { ...run, schemaVersion: 1, assessment: {
    disposition: 'out_of_scope', summary: 'Not a bug report', evidence: [], questions: [],
  } };
  await atomicJson(recordPath(directory, 'fixture-a', 42), old);
  const stored = (await readRecord(directory, manifest, 'fixture-a', 42))!;
  assert.equal(assessmentLabel(stored.assessment), 'out_of_scope (legacy v1)');
  assert.ok(!('kind' in stored.assessment!));
  await importFeedback(directory, { schemaVersion: 1, reviews: [{ batchId: manifest.batchId,
    model: 'fixture-a', issue: 42, runId: run.runId, reviewer: 'Test reviewer', role: 'operator',
    verdict: 'accept', falseReady: false, unnecessaryQuestions: false, overlookedEvidence: false,
    unsupportedClaims: false, notes: '' }] });
  await renderBatchReport(directory);
  const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
  assert.equal(summary.models[0].kinds.unclassified_legacy, 1);
  assert.equal(summary.models[0].kinds.feature_request, 0);
  assert.equal(summary.models[0].accepted, 1);
  await atomicJson(recordPath(directory, 'fixture-a', 42), { ...old, schemaVersion: 2 });
  await assert.rejects(readRecord(directory, manifest, 'fixture-a', 42));
});

test('current evaluations allow only Terra and reject historical comparison execution before calls', async () => {
  assert.equal(EVALUATION_MODEL, 'gpt-5.6-terra');
  assert.doesNotThrow(() => assertEvaluationModels([EVALUATION_MODEL]));
  assert.throws(() => assertEvaluationModels(['gpt-5.6-terra', 'gpt-5.6-luna']), /Terra|terra/);
  const { directory } = await batch();
  await assert.rejects(runBatch(directory), /Historical comparisons/);
});
