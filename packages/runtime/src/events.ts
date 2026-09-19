import { z } from 'zod';
import { InvocationBudgetSnapshot } from './budget.ts';
const Id = z.string().uuid();
const Count = z.number().finite().nonnegative().nullable();
const Usage = z.object({ inputTokens: Count, outputTokens: Count, cacheReadTokens: Count,
  cacheWriteTokens: Count, reasoningTokens: Count, estimatedCostUsd: Count }).strict();
const Failures = z.enum(['provider_error', 'no_valid_assessment', 'no_valid_brief', 'interrupted_or_timed_out',
  'execution_error', 'stage_execution_or_persistence_error', 'unknown_failure', 'no_valid_result']);
export const WorkflowEvent = z.object({
  schemaVersion: z.literal(1), workflowId: Id, sequence: z.number().int().nonnegative(), at: z.iso.datetime(),
  type: z.enum(['workflow.started', 'workflow.completed', 'workflow.partial', 'workflow.failed', 'workflow.unfinished',
    'agent.started', 'agent.completed', 'agent.failed', 'agent.unfinished', 'agent.reused',
    'operator.requested', 'operator.completed', 'operator.failed', 'operator.unfinished',
    'delivery.prepared', 'delivery.attempted', 'delivery.accepted', 'delivery.rejected', 'delivery.unknown', 'delivery.reconciled',
    'agent.step_started', 'agent.step_finished', 'agent.tool_requested', 'stage.skipped', 'stage.failed',
    'stage.unfinished', 'stage.completed', 'workflow.budget_reserved','verification.started','verification.completed',
    'publication.prepared','publication.approved','publication.push_intent','publication.branch_published','publication.pr_intent','publication.published','publication.unknown','publication.blocked']),
  publicationId:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  publicationReason:z.enum(['operator_authorized','remote_observed','effect_intent','remote_uncertain','remote_conflict','stale_base','stale_approval','prepared']).optional(),
  operatorAction: z.enum(['run_now','pause','resume','retry','investigate','propose']).optional(),
  issueNumber: z.number().int().positive().optional(),
  deliveryAttempt: z.number().int().min(1).max(3).optional(),
  deliveryResolution: z.enum(['accepted','not_accepted']).optional(),
  childWorkflowId: Id.optional(), parentWorkflowId: Id.optional(), budget: InvocationBudgetSnapshot.optional(), issueIndex: z.number().int().min(0).max(4).optional(),
  stageKey: z.enum(['collection','issue_themes','pr_themes','health','actions','requirements','proposal','patch','review']).optional(),
  agent: z.enum(['bug-readiness', 'code-location', 'repository-themes','repository-health','maintenance-actions','feature-requirements','change-proposal','scoped-patch','change-review']).optional(), runId: Id.optional(), parentRunId: Id.optional(),
  recordVersion: z.number().int().positive().optional(), promptVersion: z.string().regex(/^[\w.-]+$/).optional(),
  runtimeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), inputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  provider: z.string().regex(/^[\w.-]+$/).optional(), model: z.string().regex(/^[\w./:-]+$/).optional(),
  step: z.number().int().nonnegative().optional(),
  tool: z.enum(['submit_assessment', 'search_repository', 'read_repository', 'submit_brief', 'submit_result']).optional(),
  failure: Failures.optional(), reason: z.enum(['not_eligible', 'readiness_failed', 'location_not_started', 'budget_exhausted', 'cancelled', 'prior_attempt_unfinished', 'not_started', 'selection_limit', 'no_data', 'disabled']).optional(),
  outcome: z.enum(['ready', 'needs_information', 'not_applicable', 'out_of_scope', 'located', 'not_located', 'proposal_ready', 'sufficient_for_proposal']).optional(),
  requestKind: z.enum(['bug_report', 'feature_request', 'support_question', 'other', 'unclear', 'unclassified_legacy']).optional(),
  scopeId:Id.optional(), receiptId:Id.optional(), treeHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  verificationPhase:z.enum(['baseline','candidate','probe']).optional(),
  verificationOutcome:z.enum(['passed','assertion_failed','capability_absent','setup_error','execution_error','timeout','output_limit','cancelled']).optional(),
  testSearch: z.enum(['completed', 'unfinished']).optional(), directTests: z.number().int().nonnegative().optional(),
  adjacentTests: z.number().int().nonnegative().optional(),
  usage: Usage.optional(), historicalUsage: Usage.optional(), originalStartedAt: z.iso.datetime().optional(),
  originalFinishedAt: z.iso.datetime().optional(),
}).strict().superRefine((event, ctx) => {
  if (event.type === 'workflow.budget_reserved' && (!event.budget || event.issueIndex === undefined && event.agent !== 'code-location' && event.stageKey === undefined))
    ctx.addIssue({ code: 'custom', message: 'Budget reservations require allowance and issue identity' });
  if (event.type === 'agent.reused' && event.usage) ctx.addIssue({ code: 'custom', message: 'Reused usage must be historical' });
  if (event.type.startsWith('agent.') && (!event.agent || !event.runId))
    ctx.addIssue({ code: 'custom', message: 'Agent events require identity' });
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
export const WorkflowEventExport = z.object({ schemaVersion: z.literal(1), kind: z.literal('workflow-events'),
  mode: z.literal('derived-snapshot'), workflowId: Id, events: z.array(WorkflowEvent),
}).strict().superRefine((value, ctx) => {
  if (value.events.some((event, index) => event.sequence !== index || event.workflowId !== value.workflowId))
    ctx.addIssue({ code: 'custom', message: 'Event sequence/workflow identity mismatch' });
});
export const usage = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null;
  return Usage.parse(Object.fromEntries(Object.keys(Usage.shape).map(key => [key, number(key)])));
};
export const failure = (raw: unknown): z.infer<typeof Failures> => Failures.safeParse(raw).success ? raw as z.infer<typeof Failures> : 'unknown_failure';
