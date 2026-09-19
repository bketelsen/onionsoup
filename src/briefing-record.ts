import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { IssueSnapshot } from './contracts.ts';
import { Commit } from './location-contracts.ts';
import { BriefingIntake } from './briefing-intake.ts';
import { InvocationBudgetSnapshot } from './invocation-budget.ts';
import { validateReadinessWorkflow, type ReadinessWorkflow } from './readiness-workflow.ts';
import { validateLocationHandoff, type LocationHandoff } from './location-handoff.ts';

export const BriefingLimits = { issues: 5, locations: 2, invocations: 7 } as const;
export const MaintenanceBriefing = z.object({ schemaVersion: z.literal(1), kind: z.literal('maintenance-briefing'),
  workflowId: z.uuid(), repository: IssueSnapshot.shape.repository, commit: Commit.optional(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), status: z.enum(['running', 'completed', 'partial', 'failed']),
  execution: z.object({ provider: z.enum(['copilot', 'codex']), model: z.string().min(1) }).strict(),
  budget: InvocationBudgetSnapshot, intake: BriefingIntake.optional(), readiness: z.custom<ReadinessWorkflow>().optional(),
  locations: z.array(z.object({ number: z.number().int().positive(),
    disposition: z.enum(['pending', 'not_eligible', 'readiness_unavailable', 'selection_limit', 'cancelled', 'prior_attempt_unfinished', 'handoff']),
    handoff: z.custom<LocationHandoff>().optional() }).strict()).max(5),
  failure: z.enum(['source_unavailable', 'intake_failed', 'execution_error', 'cancelled']).optional(),
}).strict();
export type MaintenanceBriefing = z.infer<typeof MaintenanceBriefing>;
export function briefingStatus(b: MaintenanceBriefing): 'completed' | 'partial' | 'failed' {
  const progress = b.readiness?.items.some(i => i.status === 'completed');
  if (b.failure) return progress ? 'partial' : 'failed';
  if (b.intake?.rejected.length || b.readiness && b.readiness.status !== 'completed' ||
      b.locations.some(l => !['not_eligible', 'selection_limit', 'handoff'].includes(l.disposition) || l.handoff && l.handoff.status !== 'completed')) return 'partial';
  return 'completed';
}
export function validateBriefing(raw: unknown): MaintenanceBriefing {
  const b = MaintenanceBriefing.parse(raw);
  const invalid = () => { throw new Error('Invalid maintenance briefing invariants'); };
  if (b.budget.limit !== BriefingLimits.invocations) invalid();
  const issues = b.intake?.issues ?? [];
  if (new Set(issues.map(i => i.snapshot.number)).size !== issues.length || issues.some(i => i.snapshot.repository !== b.repository)) invalid();
  if (b.locations.length !== issues.length || b.locations.some((l,i) => l.number !== issues[i].snapshot.number)) invalid();
  if (b.intake && issues.length > b.intake.requestedCount) invalid();
  let consumed = 0; let eligibleIndex = 0;
  let stopped = false;
  if (b.readiness) {
    if (!b.commit || !issues.length) invalid();
    const r = validateReadinessWorkflow(b.readiness);
    if (!isDeepStrictEqual(r.items.map(i => i.input), issues.map(i => i.snapshot)) || r.budgetAtStart.consumed !== 0 || r.budget.limit !== 7) invalid();
    consumed = r.budget.consumed;
    stopped = r.items.some(i => i.status === 'unfinished' || i.status === 'running');
    for (const i of r.items) if (i.run && (i.run.provider !== b.execution.provider || i.run.model !== b.execution.model)) invalid();
  }
  const childIds = new Set<string>([b.workflowId, ...(b.readiness ? [b.readiness.workflowId] : [])]);
  if (b.readiness?.workflowId === b.workflowId) invalid();
  for (const [index, slot] of b.locations.entries()) {
    const item = b.readiness?.items[index]; const r = item?.run;
    const eligible = item?.status === 'completed' && r?.assessment?.kind === 'bug_report' && r.assessment.bug_readiness === 'ready';
    if (eligible) eligibleIndex++;
    if ((slot.disposition === 'handoff') !== Boolean(slot.handoff)) invalid();
    if (slot.handoff) {
      if (stopped || !eligible || eligibleIndex > 2 || b.readiness?.status === 'running') invalid();
      const h = validateLocationHandoff(slot.handoff);
      if (!isDeepStrictEqual(h.readiness, r) || h.readinessWorkflowId !== b.readiness!.workflowId ||
          h.repository.name !== b.repository || h.repository.commit !== b.commit || h.budgetAtStart.consumed !== consumed || h.budget.limit !== 7) invalid();
      consumed = h.budget.consumed;
      if (childIds.has(h.workflowId) || h.location && (h.location.provider !== b.execution.provider || h.location.model !== b.execution.model)) invalid();
      childIds.add(h.workflowId);
      stopped = h.status === 'running' || h.disposition === 'unfinished';
    }
    if (['cancelled', 'prior_attempt_unfinished'].includes(slot.disposition) && (!eligible || eligibleIndex > 2)) invalid();
    if (slot.disposition === 'prior_attempt_unfinished' && !stopped) invalid();
    if (slot.disposition === 'not_eligible' && (item?.status !== 'completed' || eligible)) invalid();
    if (slot.disposition === 'readiness_unavailable' && (!item || item.status === 'completed')) invalid();
    if (slot.disposition === 'selection_limit' && (!eligible || eligibleIndex <= 2)) invalid();
  }
  if (consumed !== b.budget.consumed) invalid();
  if (b.status === 'running') { if (b.finishedAt) invalid(); }
  else {
    if (!b.finishedAt || b.status !== briefingStatus(b)) invalid();
    if (!b.failure && (!b.commit || !b.intake || issues.length > 0 && !b.readiness || b.locations.some(l => l.disposition === 'pending'))) invalid();
  }
  return b;
}
