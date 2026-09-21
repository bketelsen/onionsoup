import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { LanguageModel } from 'ai';
import type { RunRecord } from './triage.ts';
import { validateReadinessRun } from './readiness-record.ts';
import { LocationInput } from './location-contracts.ts';
import { locateCode, type LocationRun } from './location-agent.ts';
import { validateLocationRun } from './location-record.ts';
import { InvocationBudgetSnapshot, type InvocationBudget } from '@onionsoup/runtime/budget';

export const LocationSourceConfig = z.object({ checkout: z.string().min(1), repository: LocationInput.shape.repository }).strict();
export type LocationSourceConfig = z.infer<typeof LocationSourceConfig>;
export function readyLocationInput(raw: unknown, source: LocationSourceConfig) {
  const parent = validateReadinessRun(raw);
  if (parent.schemaVersion !== 2 || parent.status !== 'completed' ||
      parent.assessment?.kind !== 'bug_report' || parent.assessment.bug_readiness !== 'ready')
    throw new Error('readiness_not_eligible');
  const r = parent as RunRecord;
  if (r.input.repository !== source.repository.name) throw new Error('source_repository_mismatch');
  return LocationInput.parse({ schemaVersion: 1, issue: r.input, repository: source.repository,
    parent: { runId: r.runId, inputHash: r.inputHash, promptVersion: r.promptVersion,
      kind: 'bug_report', bug_readiness: 'ready', summary: r.assessment!.summary } });
}
export const LocationHandoff = z.object({ schemaVersion: z.literal(1), kind: z.literal('location-handoff'),
  workflowId: z.uuid(), readinessWorkflowId: z.uuid().optional(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['running', 'completed', 'partial', 'failed']), readiness: z.custom<RunRecord>(),
  repository: LocationInput.shape.repository, budgetAtStart: InvocationBudgetSnapshot, budget: InvocationBudgetSnapshot,
  reservedAt: z.iso.datetime().optional(), reservation: InvocationBudgetSnapshot.optional(),
  disposition: z.enum(['pending', 'located', 'not_located', 'failed', 'unfinished', 'not_attempted']),
  reason: z.enum(['budget_exhausted', 'cancelled', 'execution_error', 'agent_failed']).optional(),
  location: z.custom<LocationRun>().optional(),
}).strict();
export type LocationHandoff = z.infer<typeof LocationHandoff>;
export function validateLocationHandoff(raw: unknown): LocationHandoff {
  const h = LocationHandoff.parse(raw);
  const input = readyLocationInput(h.readiness, { checkout: 'unused', repository: h.repository });
  const invalid = () => { throw new Error('Invalid location handoff invariants'); };
  if (h.budget.limit !== h.budgetAtStart.limit || Boolean(h.reservation) !== Boolean(h.reservedAt)) invalid();
  if (h.reservation) {
    if (h.reservation.limit !== h.budget.limit || h.reservation.consumed !== h.budgetAtStart.consumed + 1 ||
        JSON.stringify(h.reservation) !== JSON.stringify(h.budget)) invalid();
  } else if (JSON.stringify(h.budget) !== JSON.stringify(h.budgetAtStart) || h.location) invalid();
  if (h.location) {
    const r = validateLocationRun(h.location);
    if (!isDeepStrictEqual(r.input, input) || r.runId === h.readiness.runId) invalid();
  }
  if (h.status === 'running') {
    if (h.finishedAt || h.disposition !== 'pending' || h.reason) invalid();
  } else {
    if (!h.finishedAt) invalid();
    const d = h.disposition;
    if (d === 'located' || d === 'not_located') {
      if (h.location?.status !== 'completed' || h.location.brief?.status !== d || h.reason ||
        h.status !== (d === 'located' ? 'completed' : 'partial')) invalid();
    } else if (d === 'not_attempted') {
      if (h.status !== 'partial' || h.reservation || !['budget_exhausted', 'cancelled'].includes(h.reason ?? '') ||
          h.reason === 'budget_exhausted' && h.budget.remaining !== 0) invalid();
    } else if (d === 'unfinished') {
      if (h.status !== 'partial' || h.location?.status !== 'running' || h.reason !== 'execution_error') invalid();
    } else if (d === 'failed') {
      if (h.status !== 'failed' || !h.reservation || h.location && h.location.status !== 'failed' ||
          !['execution_error', 'agent_failed', 'cancelled'].includes(h.reason ?? '')) invalid();
    } else invalid();
  }
  return h;
}
class PersistenceError extends Error {}
export async function locateReadyIssue(raw: unknown, options: {
  source: LocationSourceConfig; budget: InvocationBudget; readinessWorkflowId?: string; signal?: AbortSignal;
  model: () => Promise<{ model: LanguageModel; provider: string; modelId: string }>;
  checkpoint: (record: LocationHandoff) => Promise<void>;
}): Promise<LocationHandoff> {
  const source = LocationSourceConfig.parse(options.source);
  const input = readyLocationInput(raw, source);
  const readiness = structuredClone(raw) as RunRecord;
  const now = () => new Date().toISOString();
  const h: LocationHandoff = { schemaVersion: 1, kind: 'location-handoff', workflowId: randomUUID(),
    readinessWorkflowId: options.readinessWorkflowId, startedAt: now(), status: 'running', readiness,
    repository: source.repository, budgetAtStart: options.budget.snapshot(), budget: options.budget.snapshot(), disposition: 'pending' };
  const save = async () => {
    try { await options.checkpoint(structuredClone(validateLocationHandoff(h))); }
    catch { throw new PersistenceError('Handoff persistence failed'); }
  };
  await save();
  const reservation = options.signal?.aborted ? undefined : options.budget.reserve();
  if (!reservation) {
    h.status = 'partial'; h.disposition = 'not_attempted'; h.reason = options.signal?.aborted ? 'cancelled' : 'budget_exhausted';
  } else {
    h.budget = reservation; h.reservation = reservation; h.reservedAt = now(); await save();
    try {
      const model = await options.model();
      if (options.signal?.aborted) {
        h.status = 'failed'; h.disposition = 'failed'; h.reason = 'cancelled';
      } else {
        h.location = await locateCode(input, { ...model, checkout: source.checkout, signal: options.signal,
          checkpoint: async record => { h.location = record; await save(); } });
        h.disposition = h.location.status === 'completed' ? h.location.brief!.status : 'failed';
        h.status = h.disposition === 'located' ? 'completed' : h.disposition === 'not_located' ? 'partial' : 'failed';
        if (h.disposition === 'failed') h.reason = 'agent_failed';
      }
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      h.disposition = h.location ? 'unfinished' : 'failed'; h.status = h.location ? 'partial' : 'failed'; h.reason = 'execution_error';
    }
  }
  h.finishedAt = now(); await save(); return h;
}
