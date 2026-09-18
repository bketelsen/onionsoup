import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { IssueSnapshot, validateAssessment } from '../src/contracts.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { LIMITS, triage, type RunRecord } from '../src/triage.ts';

const input = IssueSnapshot.parse(JSON.parse(await readFile(new URL('../examples/incomplete-bug.json', import.meta.url), 'utf8')));
const assessment = JSON.parse(await readFile(new URL('../examples/incomplete-assessment.json', import.meta.url), 'utf8'));
const options = (responses: unknown[]) => ({ model: fixtureModel(responses), provider: 'fixture', modelId: 'scripted' });

test('real AgentLayer loop accepts a grounded result and checkpoints admission and completion', async () => {
  const snapshots: RunRecord[] = [];
  const run = await triage(input, { ...options([assessment]), checkpoint: async record => { snapshots.push(record); } });
  assert.equal(run.status, 'completed');
  assert.equal(run.assessment?.bug_readiness, 'needs_information');
  assert.equal(run.events.filter(e => e.type === 'stepStart').length, 1);
  assert.deepEqual(snapshots.map(s => s.status), ['running', 'completed']);
  assert.equal(snapshots[0].assessment, undefined);
  assert.ok(run.state?.messages.some(m => m.role === 'tool'));
  assert.equal(JSON.parse(JSON.stringify(run)).inputHash, run.inputHash);
});

test('invented evidence receives feedback and can be corrected', async () => {
  const invented = structuredClone(assessment);
  invented.evidence[0].quote = 'This quotation does not exist';
  const run = await triage(input, options([invented, assessment]));
  assert.equal(run.status, 'completed');
  assert.equal(run.events.filter(e => e.type === 'stepStart').length, 2);
  assert.match(JSON.stringify(run.state), /UNGROUNDED_EVIDENCE/);
});

test('repeated invalid outputs exhaust the bounded loop without success', async () => {
  const invalid = { ...assessment, bug_readiness: 'ready' };
  const run = await triage(input, options([invalid, invalid, invalid]));
  assert.equal(run.status, 'failed');
  assert.equal(run.failure, 'no_valid_assessment');
  assert.equal(run.assessment, undefined);
  assert.equal(run.events.filter(e => e.type === 'stepStart').length, LIMITS.steps);
});

test('malformed schema cannot become a completed run', async () => {
  const run = await triage(input, options([{ nonsense: true }, { nonsense: true }, { nonsense: true }]));
  assert.equal(run.status, 'failed');
  assert.equal(run.assessment, undefined);
});

test('pre-cancelled runs are recorded as failures', async () => {
  const run = await triage(input, { ...options([assessment]), signal: AbortSignal.abort() });
  assert.equal(run.status, 'failed');
  assert.equal(run.failure, 'interrupted_or_timed_out');
});

test('provider failure is not represented as a business assessment', async () => {
  const run = await triage(input, options([new Error('transport broke')]));
  assert.equal(run.status, 'failed');
  assert.equal(run.failure, 'provider_error');
  assert.equal(run.assessment, undefined);
});

test('oversized input fails before admission or model invocation', async () => {
  let admitted = false;
  await assert.rejects(triage({ ...input, body: 'x'.repeat(24001) }, {
    ...options([]), checkpoint: async () => { admitted = true; },
  }));
  assert.equal(admitted, false);
});

test('failed admission persistence prevents model work', async () => {
  const model = fixtureModel([assessment]);
  await assert.rejects(triage(input, {
    model, provider: 'fixture', modelId: 'scripted',
    checkpoint: async () => { throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(model.doStreamCalls.length, 0);
});

test('contradictory and duplicated fields fail the contract', () => {
  const conflict = structuredClone(assessment);
  conflict.questions[0].field = 'actual';
  assert.throws(() => validateAssessment(conflict, input), /CONFLICTING_FIELD/);
  const duplicate = structuredClone(assessment);
  duplicate.evidence.push(duplicate.evidence[0]);
  assert.throws(() => validateAssessment(duplicate, input), /DUPLICATE_FIELD/);
});

test('feature requests are classified without a project acceptance decision', async () => {
  const run = await triage({ ...input, title: 'Please add dark mode', body: 'Feature request' }, options([
    { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable', summary: 'Feature request', evidence: [], questions: [] },
  ]));
  assert.equal(run.status, 'completed');
  assert.equal(run.schemaVersion, 2);
  assert.equal(run.assessment?.schemaVersion, 2);
  assert.equal(run.assessment?.kind, 'feature_request');
  assert.equal(run.assessment?.bug_readiness, 'not_applicable');
});

test('kind and readiness combinations cannot imply readiness for non-bugs or skip bug assessment', () => {
  for (const kind of ['feature_request', 'support_question', 'other', 'unclear']) {
    const nonBug = { schemaVersion: 2, kind, bug_readiness: 'not_applicable',
      summary: 'Describes the request without deciding its merits.', evidence: [], questions: [] };
    assert.equal(validateAssessment(nonBug, input).kind, kind);
    for (const bug_readiness of ['ready', 'needs_information'])
      assert.throws(() => validateAssessment({ ...nonBug, bug_readiness }, input), /INCOMPATIBLE_READINESS/);
    assert.throws(() => validateAssessment({ ...nonBug, evidence: assessment.evidence }, input), /NOT_APPLICABLE/);
  }
  assert.throws(() => validateAssessment({ ...assessment, bug_readiness: 'not_applicable' }, input), /INCOMPATIBLE_READINESS/);
  assert.throws(() => validateAssessment({ disposition: 'out_of_scope', summary: 'Old result', evidence: [], questions: [] }, input));
});
