import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvocationBudget } from '../src/invocation-budget.ts';
import { assessIssues, validateReadinessWorkflow, type ReadinessWorkflow } from '../src/readiness-workflow.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { workflowEvents } from '../src/workflow-events.ts';

const issue = (number: number) => ({ schemaVersion: 1 as const, repository: 'example/widget', number,
  updatedAt: '2026-09-18T12:00:00Z', title: 'Private issue text', body: 'Private content' });
const feature = { schemaVersion: 2, kind: 'feature_request', bug_readiness: 'not_applicable',
  summary: 'Private assessment text', evidence: [], questions: [] };
const model = () => ({ provider: 'fixture', modelId: 'scripted', model: fixtureModel([feature]) });
const input = { issues: [issue(1), issue(2), issue(3)] };

test('invocation reservations are atomic, finite, and cannot replenish across consumers', async () => {
  const budget = createInvocationBudget(2);
  const reserved = await Promise.all(Array.from({ length: 10 }, async () => budget.reserve()));
  assert.equal(reserved.filter(Boolean).length, 2);
  assert.deepEqual(budget.snapshot(), { limit: 2, consumed: 2, remaining: 0 });
  for (const invalid of [0, 11, NaN, 1.1]) assert.throws(() => createInvocationBudget(invalid));
});

test('ordered workflow saves reservations before inference and reports budget-limited partial outcomes', async () => {
  const snapshots: ReadinessWorkflow[] = []; let calls = 0;
  const record = await assessIssues(input, { budget: createInvocationBudget(2),
    checkpoint: async record => { snapshots.push(record); }, model: async () => {
      calls++;
      assert.equal(snapshots.at(-1)!.budget.consumed, calls);
      assert.equal(snapshots.at(-1)!.items[calls - 1].status, 'running');
      return model();
    } });
  assert.equal(calls, 2); assert.equal(record.status, 'partial');
  assert.deepEqual(record.items.map(i => i.status), ['completed', 'completed', 'not_attempted']);
  assert.equal(record.items[2].reason, 'budget_exhausted'); assert.equal(record.items[2].run, undefined);
  assert.equal(snapshots[0].budget.consumed, 0); assert.equal(snapshots[0].items[0].status, 'pending');
  const trace = workflowEvents(record);
  assert.deepEqual(trace, workflowEvents(record));
  assert.deepEqual(trace.events.filter(e => e.type === 'workflow.budget_reserved').map(e => e.budget?.remaining), [1, 0]);
  assert.deepEqual(trace.events.filter(e => e.type === 'agent.started').map(e => e.issueIndex), [0, 1]);
  assert.equal(trace.events.at(-1)?.type, 'workflow.partial');
  assert.equal(trace.events.find(e => e.type === 'stage.skipped')?.issueIndex, 2);
  assert.ok(trace.events.every(e => e.workflowId === record.workflowId));
  assert.ok(!JSON.stringify(trace).includes('Private'));
  assert.equal(trace.events.find(e => e.type === 'agent.completed')?.usage?.inputTokens, 0);
});

test('provider and initialization failures consume the shared allowance and preserve later work', async t => {
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const record = await assessIssues(input, { budget: createInvocationBudget(3), checkpoint: async () => {},
    model: async () => {
      calls++;
      if (calls === 1) throw new Error('private-configuration-error');
      return calls === 2 ? { ...model(), model: fixtureModel([new Error('private-provider-error')]) } : model();
    } });
  assert.deepEqual(record.items.map(i => i.status), ['failed', 'failed', 'completed']);
  assert.equal(record.status, 'partial'); assert.equal(record.budget.remaining, 0);
  assert.equal(record.items[0].run, undefined); assert.equal(record.items[1].run?.failure, 'provider_error');
  assert.ok(!JSON.stringify(workflowEvents(record)).includes('private-'));
  const allFailed = await assessIssues({ issues: [issue(1)] }, { budget: createInvocationBudget(1),
    checkpoint: async () => {}, model: async () => { throw new Error('failed'); } });
  assert.equal(allFailed.status, 'failed');
});

test('caller retries and later workflows draw from the same budget', async () => {
  const budget = createInvocationBudget(2); budget.reserve(); // Earlier single invocation.
  let calls = 0;
  const options = { budget, checkpoint: async () => {}, model: async () => { calls++; return model(); } };
  const first = await assessIssues(input, options);
  assert.equal(first.budgetAtStart.consumed, 1);
  assert.deepEqual(first.items.map(i => i.status), ['completed', 'not_attempted', 'not_attempted']);
  const retry = await assessIssues(input, options);
  assert.equal(retry.status, 'partial'); assert.ok(retry.items.every(i => i.reason === 'budget_exhausted'));
  assert.equal(calls, 1); assert.notEqual(first.workflowId, retry.workflowId);
});

test('cancellation before admission or between children preserves completed work and stops spending', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(); if (before) controller.abort();
    let calls = 0;
    const record = await assessIssues(input, { budget: createInvocationBudget(3), signal: controller.signal,
      model: async () => { calls++; return model(); }, checkpoint: async record => {
        if (record.items[0].status === 'completed') controller.abort();
      } });
    assert.equal(calls, before ? 0 : 1);
    assert.equal(record.status, 'partial'); assert.equal(record.budget.consumed, calls);
    assert.ok(record.items.slice(before ? 0 : 1).every(i => i.status === 'not_attempted' && i.reason === 'cancelled'));
  }
});

test('persistence failures stop inference or further admission, leaving the last saved state explicit', async () => {
  for (const failAt of ['initial', 'reservation', 'child_final', 'workflow_final']) {
    const budget = createInvocationBudget(3); let calls = 0; let saved: ReadinessWorkflow | undefined;
    await assert.rejects(assessIssues(input, { budget,
      model: async () => { calls++; return model(); }, checkpoint: async record => {
        if (failAt === 'initial' || failAt === 'reservation' && record.budget.consumed > 0 ||
          failAt === 'child_final' && record.items.some(i => i.status === 'completed') ||
          failAt === 'workflow_final' && record.status !== 'running') throw new Error('private-storage-error');
        saved = record;
      } }), /Workflow persistence failed/);
    assert.equal(calls, failAt === 'initial' || failAt === 'reservation' ? 0 : failAt === 'child_final' ? 1 : 3);
    if (saved) {
      assert.equal(saved.status, 'running');
      assert.equal(workflowEvents(saved).events.at(-1)?.type, 'workflow.unfinished');
    }
    assert.equal(budget.snapshot().consumed, failAt === 'initial' ? 0 : failAt === 'workflow_final' ? 3 : 1);
  }
});

test('invalid or duplicate snapshots do not reserve capacity; corrupted saved invariants are rejected', async () => {
  const budget = createInvocationBudget(3);
  const options = { budget, model: async () => model(), checkpoint: async () => {} };
  for (const value of [{ issues: [] }, { issues: [issue(1), issue(1)] }, { ...input, maxInvocations: 10 },
    { issues: [issue(1), { ...issue(1), repository: 'EXAMPLE/widget' }] }]) await assert.rejects(assessIssues(value, options));
  assert.equal(budget.snapshot().consumed, 0);
  const record = await assessIssues(input, options);
  assert.equal(record.status, 'completed');
  for (const corrupt of [
    { ...record, status: 'partial' },
    { ...record, budget: { limit: 3, consumed: 2, remaining: 1 } },
    { ...record, items: record.items.map((i, index) => index === 0 ? { ...i, inputHash: '0'.repeat(64) } : i) },
    { ...record, items: record.items.map(i => ({ ...i, reservation: { limit: 3, consumed: 1, remaining: 2 } })) },
  ]) assert.throws(() => validateReadinessWorkflow(corrupt));
});

test('unknown usage remains unknown and an unfinished child cannot become successful completion', async () => {
  const record = await assessIssues({ issues: [issue(1)] }, { budget: createInvocationBudget(1), model: async () => model(), checkpoint: async () => {} });
  const child = record.items[0].run!; delete child.tokenUsage;
  assert.equal(workflowEvents(record).events.find(e => e.type === 'agent.completed')?.usage, undefined);
  child.status = 'running'; delete child.finishedAt; delete child.assessment;
  record.items[0].status = 'unfinished'; record.items[0].reason = 'execution_error'; record.status = 'partial';
  const trace = workflowEvents(record);
  assert.ok(trace.events.some(e => e.type === 'agent.unfinished'));
  assert.ok(!trace.events.some(e => e.type === 'agent.completed'));
});

test('cancellation during provider initialization keeps the reservation but never starts inference', async () => {
  const controller = new AbortController(); let calls = 0;
  const record = await assessIssues(input, { budget: createInvocationBudget(3), signal: controller.signal,
    checkpoint: async () => {}, model: async () => { calls++; controller.abort(); return model(); } });
  assert.equal(calls, 1); assert.equal(record.budget.consumed, 1);
  assert.equal(record.items[0].status, 'failed'); assert.equal(record.items[0].reason, 'cancelled');
  assert.equal(record.items[0].run, undefined);
  assert.ok(record.items.slice(1).every(i => i.status === 'not_attempted' && i.reason === 'cancelled'));
  assert.equal(workflowEvents(record).events.find(e => e.type === 'stage.failed')?.failure, 'interrupted_or_timed_out');
});
