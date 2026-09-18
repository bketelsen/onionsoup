import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { IssueSnapshot } from './contracts.ts';
import { inputHash, triage, type RunRecord } from './triage.ts';
import { validateReadinessRun } from './readiness-record.ts';
import { InvocationBudgetSnapshot, type InvocationBudget } from './invocation-budget.ts';

export const ReadinessWorkflowInput = z.object({ issues: z.array(IssueSnapshot).min(1).max(5) }).strict()
  .refine(value => new Set(value.issues.map(i => `${i.repository.toLowerCase()}#${i.number}`)).size === value.issues.length,
    'Supply distinct issues, not duplicate attempts or revisions');
export function readinessWorkflowInputHash(raw: unknown): string {
  return createHash('sha256').update(JSON.stringify(ReadinessWorkflowInput.parse(raw))).digest('hex');
}
const Item = z.object({ input: IssueSnapshot, inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'unfinished', 'not_attempted']),
  updatedAt: z.iso.datetime(), reservedAt: z.iso.datetime().optional(), reservation: InvocationBudgetSnapshot.optional(),
  reason: z.enum(['budget_exhausted', 'cancelled', 'prior_attempt_unfinished', 'execution_error', 'agent_failed']).optional(),
  run: z.custom<RunRecord>().optional(),
}).strict();
export const ReadinessWorkflow = z.object({ schemaVersion: z.literal(1), kind: z.literal('readiness-workflow'),
  workflowId: z.uuid(), status: z.enum(['running', 'completed', 'partial', 'failed']), startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(), budgetAtStart: InvocationBudgetSnapshot, budget: InvocationBudgetSnapshot,
  items: z.array(Item).min(1).max(5),
}).strict();
export type ReadinessWorkflow = z.infer<typeof ReadinessWorkflow>;
function terminalStatus(items: ReadinessWorkflow['items']): 'completed' | 'partial' | 'failed' {
  if (items.every(i => i.status === 'completed')) return 'completed';
  if (items.every(i => i.status === 'failed')) return 'failed';
  return 'partial';
}
export function validateReadinessWorkflow(raw: unknown): ReadinessWorkflow {
  const w = ReadinessWorkflow.parse(raw);
  ReadinessWorkflowInput.parse({ issues: w.items.map(i => i.input) });
  let consumed = w.budgetAtStart.consumed;
  let stopped = false;
  const runIds = new Set<string>();
  const invalid = () => { throw new Error('Invalid readiness workflow invariants'); };
  if (w.budget.limit !== w.budgetAtStart.limit) invalid();
  for (const item of w.items) {
    if (item.inputHash !== inputHash(item.input)) invalid();
    const attempted = !['pending', 'not_attempted'].includes(item.status);
    if (attempted) {
      if (stopped || !item.reservation || !item.reservedAt || item.reservation.limit !== w.budget.limit || item.reservation.consumed !== ++consumed) invalid();
    } else {
      stopped = true;
      if (item.reservation || item.reservedAt || item.run) invalid();
    }
    if (item.run) {
      const run = validateReadinessRun(item.run);
      if (run.schemaVersion !== 2 || run.inputHash !== item.inputHash || runIds.has(run.runId)) invalid();
      runIds.add(run.runId);
      if (run.status !== (item.status === 'unfinished' ? 'running' : item.status)) invalid();
    }
    if ((item.status === 'completed' || item.status === 'unfinished') && !item.run) invalid();
    if (item.status === 'not_attempted') {
      if (!['budget_exhausted', 'cancelled', 'prior_attempt_unfinished'].includes(item.reason ?? '')) invalid();
      if (item.reason === 'budget_exhausted' && w.budget.remaining !== 0) invalid();
    } else if (item.status === 'failed' || item.status === 'unfinished') {
      if (!['execution_error', 'agent_failed', 'cancelled'].includes(item.reason ?? '')) invalid();
    } else if (item.reason) invalid();
    if (item.status === 'running' || item.status === 'unfinished') stopped = true;
  }
  if (w.budget.consumed !== consumed) invalid();
  if (w.status === 'running') {
    if (w.finishedAt || w.items.filter(i => i.status === 'running').length > 1) invalid();
  } else if (!w.finishedAt || w.items.some(i => ['pending', 'running'].includes(i.status)) || w.status !== terminalStatus(w.items)) invalid();
  return w;
}

class PersistenceError extends Error {}
export async function assessIssues(raw: unknown, options: {
  budget: InvocationBudget;
  model: () => Promise<{ model: LanguageModel; provider: string; modelId: string }>;
  signal?: AbortSignal;
  checkpoint: (record: ReadinessWorkflow) => Promise<void>;
}): Promise<ReadinessWorkflow> {
  const { issues } = ReadinessWorkflowInput.parse(raw);
  const now = () => new Date().toISOString();
  const startedAt = now();
  const workflow: ReadinessWorkflow = { schemaVersion: 1, kind: 'readiness-workflow', workflowId: randomUUID(),
    status: 'running', startedAt, budgetAtStart: options.budget.snapshot(), budget: options.budget.snapshot(),
    items: issues.map(input => ({ input, inputHash: inputHash(input), status: 'pending', updatedAt: startedAt })) };
  const save = async () => {
    try { await options.checkpoint(structuredClone(validateReadinessWorkflow(workflow))); }
    catch { throw new PersistenceError('Workflow persistence failed'); }
  };
  await save();
  let stop: 'cancelled' | 'budget_exhausted' | 'prior_attempt_unfinished' | undefined;
  for (const item of workflow.items) {
    if (options.signal?.aborted) stop = 'cancelled';
    const reservation = stop ? undefined : options.budget.reserve();
    if (!reservation) {
      stop ??= 'budget_exhausted';
      item.status = 'not_attempted'; item.reason = stop; item.updatedAt = now();
      await save(); continue;
    }
    item.reservation = reservation; item.reservedAt = now(); item.updatedAt = item.reservedAt;
    item.status = 'running'; workflow.budget = reservation;
    await save(); // Reservation and identity are persisted before provider initialization.
    try {
      const model = await options.model();
      if (options.signal?.aborted) {
        item.status = 'failed'; item.reason = 'cancelled';
      } else {
        const run = await triage(item.input, { ...model, signal: options.signal, checkpoint: async record => {
          item.run = record; item.updatedAt = record.finishedAt ?? record.startedAt;
          item.status = record.status;
          if (record.status === 'failed') item.reason = 'agent_failed';
          await save();
        } });
        item.run = run; item.status = run.status;
      }
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      item.status = item.run ? 'unfinished' : 'failed'; item.reason = 'execution_error';
      if (item.status === 'unfinished') stop = 'prior_attempt_unfinished';
    }
    item.updatedAt = now(); await save();
  }
  workflow.status = terminalStatus(workflow.items); workflow.finishedAt = now();
  await save();
  return workflow;
}
