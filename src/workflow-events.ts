import { z } from 'zod';
import { InvocationBudgetSnapshot } from './invocation-budget.ts';
import { validateLocationHandoff } from './location-handoff.ts';
import { validateReadinessWorkflow } from './readiness-workflow.ts';
import { validateReadinessRun } from './readiness-record.ts';
import { validatePacket } from './packet.ts';
import { validateLocationRun } from './location-record.ts';
import type { StoredRunRecord } from './assessment-view.ts';
import type { LocationRun } from './location-agent.ts';

const Id = z.string().uuid();
const Count = z.number().finite().nonnegative().nullable();
const Usage = z.object({ inputTokens: Count, outputTokens: Count, cacheReadTokens: Count,
  cacheWriteTokens: Count, reasoningTokens: Count, estimatedCostUsd: Count }).strict();
const Failures = z.enum(['provider_error', 'no_valid_assessment', 'no_valid_brief', 'interrupted_or_timed_out',
  'execution_error', 'stage_execution_or_persistence_error', 'unknown_failure']);
export const WorkflowEvent = z.object({
  schemaVersion: z.literal(1), workflowId: Id, sequence: z.number().int().nonnegative(), at: z.iso.datetime(),
  type: z.enum(['workflow.started', 'workflow.completed', 'workflow.partial', 'workflow.failed', 'workflow.unfinished',
    'agent.started', 'agent.completed', 'agent.failed', 'agent.unfinished', 'agent.reused',
    'agent.step_started', 'agent.step_finished', 'agent.tool_requested', 'stage.skipped', 'stage.failed',
    'stage.unfinished', 'workflow.budget_reserved']),
  parentWorkflowId: Id.optional(), budget: InvocationBudgetSnapshot.optional(), issueIndex: z.number().int().min(0).max(4).optional(),
  agent: z.enum(['bug-readiness', 'code-location']).optional(), runId: Id.optional(), parentRunId: Id.optional(),
  recordVersion: z.number().int().positive().optional(), promptVersion: z.string().regex(/^[\w.-]+$/).optional(),
  runtimeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), inputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  provider: z.string().regex(/^[\w.-]+$/).optional(), model: z.string().regex(/^[\w./:-]+$/).optional(),
  step: z.number().int().nonnegative().optional(),
  tool: z.enum(['submit_assessment', 'search_repository', 'read_repository', 'submit_brief']).optional(),
  failure: Failures.optional(), reason: z.enum(['not_eligible', 'readiness_failed', 'location_not_started', 'budget_exhausted', 'cancelled', 'prior_attempt_unfinished', 'not_started']).optional(),
  outcome: z.enum(['ready', 'needs_information', 'not_applicable', 'out_of_scope', 'located', 'not_located']).optional(),
  requestKind: z.enum(['bug_report', 'feature_request', 'support_question', 'other', 'unclear', 'unclassified_legacy']).optional(),
  testSearch: z.enum(['completed', 'unfinished']).optional(), directTests: z.number().int().nonnegative().optional(),
  adjacentTests: z.number().int().nonnegative().optional(),
  usage: Usage.optional(), historicalUsage: Usage.optional(), originalStartedAt: z.iso.datetime().optional(),
  originalFinishedAt: z.iso.datetime().optional(),
}).strict().superRefine((event, ctx) => {
  if (event.type === 'workflow.budget_reserved' && (!event.budget || event.issueIndex === undefined && event.agent !== 'code-location'))
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
const usage = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null;
  return Usage.parse(Object.fromEntries(Object.keys(Usage.shape).map(key => [key, number(key)])));
};
const failure = (raw: unknown): z.infer<typeof Failures> => Failures.safeParse(raw).success ? raw as z.infer<typeof Failures> : 'unknown_failure';

// The original records remain the truth. No provider calls, new timestamps, or raw content.
export function workflowEvents(raw: unknown) {
  const candidate = raw as Record<string, unknown>;
  const handoff = candidate?.kind === 'location-handoff' ? validateLocationHandoff(raw) : undefined;
  const workflow = candidate?.kind === 'readiness-workflow' ? validateReadinessWorkflow(raw) : undefined;
  const packet = candidate?.packetId ? validatePacket(raw) : undefined;
  const run = packet || workflow || handoff ? undefined : candidate?.agent === 'code-location' ? validateLocationRun(raw) : validateReadinessRun(raw);
  const workflowId = handoff?.workflowId ?? workflow?.workflowId ?? packet?.packetId ?? run!.runId;
  const events: WorkflowEvent[] = [];
  const add = (event: Omit<WorkflowEvent, 'schemaVersion' | 'workflowId' | 'sequence'>) => {
    events.push(WorkflowEvent.parse({ schemaVersion: 1, workflowId, sequence: events.length, ...(handoff?.readinessWorkflowId ? { parentWorkflowId: handoff.readinessWorkflowId } : {}), ...event }));
  };
  const appendRun = (record: StoredRunRecord | LocationRun, reusedAt?: string, issueIndex?: number) => {
    const location = record.agent === 'code-location' ? record : undefined;
    const base = { ...(issueIndex !== undefined ? { issueIndex } : {}), agent: record.agent, runId: record.runId, recordVersion: record.schemaVersion,
      promptVersion: record.promptVersion, provider: record.provider, model: record.model,
      inputHash: location ? location.input.parent.inputHash : (record as StoredRunRecord).inputHash,
      ...(location ? { parentRunId: location.input.parent.runId, runtimeHash: location.runtimeHash,
        repositoryCommit: location.input.repository.commit } : {}) };
    const totals = usage(record.tokenUsage?.totals);
    const result: Partial<WorkflowEvent> = {};
    if (record.status === 'completed') {
      if (record.agent === 'bug-readiness' && record.assessment) {
        result.outcome = 'bug_readiness' in record.assessment ? record.assessment.bug_readiness : record.assessment.disposition;
        result.requestKind = 'kind' in record.assessment ? record.assessment.kind : 'unclassified_legacy';
      } else if (location?.brief) {
        result.outcome = location.brief.status;
        if (location.brief.schemaVersion === 3) {
          result.testSearch = location.brief.testSearch.status;
          result.directTests = location.brief.testPointers.filter(p => p.relevance === 'direct').length;
          result.adjacentTests = location.brief.testPointers.filter(p => p.relevance === 'adjacent').length;
        }
      }
    }
    if (reusedAt) {
      add({ ...base, ...result, type: 'agent.reused', at: reusedAt, historicalUsage: totals,
        originalStartedAt: record.startedAt, originalFinishedAt: record.finishedAt });
      return;
    }
    add({ ...base, type: 'agent.started', at: record.startedAt });
    for (const item of record.events ?? []) {
      const parsed = z.object({ type: z.enum(['stepStart', 'stepFinish', 'toolInputStart']), at: z.iso.datetime(),
        step: z.number().int().nonnegative().optional(), tool: z.string().optional() }).safeParse(item);
      if (!parsed.success) continue;
      const itemType = parsed.data.type === 'stepStart' ? 'agent.step_started' : parsed.data.type === 'stepFinish' ? 'agent.step_finished' : 'agent.tool_requested';
      const tool = WorkflowEvent.shape.tool.safeParse(parsed.data.tool);
      add({ ...base, type: itemType, at: parsed.data.at, step: parsed.data.step, tool: tool.success ? tool.data : undefined });
    }
    add({ ...base, ...result, type: record.status === 'running' ? 'agent.unfinished' : record.status === 'completed' ? 'agent.completed' : 'agent.failed',
      at: record.finishedAt ?? record.events?.filter(e => z.iso.datetime().safeParse(e.at).success).at(-1)?.at ?? record.startedAt,
      failure: record.status === 'failed' ? failure(record.failure) : undefined, usage: totals });
  };
  add({ type: 'workflow.started', at: handoff?.startedAt ?? workflow?.startedAt ?? packet?.createdAt ?? run!.startedAt,
    ...(handoff ? { budget: handoff.budgetAtStart } : workflow ? { budget: workflow.budgetAtStart } : {}) });
  if (handoff) {
    appendRun(handoff.readiness, handoff.startedAt);
    const base = { agent: 'code-location' as const, parentRunId: handoff.readiness.runId,
      inputHash: handoff.readiness.inputHash, repositoryCommit: handoff.repository.commit };
    if (handoff.reservation) add({ ...base, type: 'workflow.budget_reserved', at: handoff.reservedAt!, budget: handoff.reservation });
    if (handoff.location) appendRun(handoff.location);
    else if (handoff.disposition === 'failed') add({ ...base, type: 'stage.failed', at: handoff.finishedAt!,
      failure: handoff.reason === 'cancelled' ? 'interrupted_or_timed_out' : 'execution_error' });
    else if (handoff.disposition === 'not_attempted') add({ ...base, type: 'stage.skipped', at: handoff.finishedAt!,
      reason: handoff.reason as 'cancelled' | 'budget_exhausted' });
    else add({ ...base, type: 'stage.unfinished', at: handoff.reservedAt ?? handoff.startedAt, reason: 'not_started' });
    add({ type: handoff.status === 'running' ? 'workflow.unfinished' : `workflow.${handoff.status}`,
      at: handoff.finishedAt ?? events.at(-1)!.at, budget: handoff.budget });
  } else if (workflow) {
    for (const [issueIndex, item] of workflow.items.entries()) {
      const base = { issueIndex, inputHash: item.inputHash, at: item.updatedAt, agent: 'bug-readiness' as const };
      if (item.reservation) add({ ...base, type: 'workflow.budget_reserved', at: item.reservedAt!, budget: item.reservation });
      if (item.run) appendRun(item.run, undefined, issueIndex);
      else if (item.status === 'failed') add({ ...base, type: 'stage.failed',
        failure: item.reason === 'cancelled' ? 'interrupted_or_timed_out' : 'execution_error' });
      else if (item.status === 'not_attempted') add({ ...base, type: 'stage.skipped',
        reason: item.reason as 'budget_exhausted' | 'cancelled' | 'prior_attempt_unfinished' });
      else add({ ...base, type: 'stage.unfinished', reason: 'not_started' });
    }
    add({ type: workflow.status === 'running' ? 'workflow.unfinished' : `workflow.${workflow.status}`,
      at: workflow.finishedAt ?? [workflow.startedAt, ...workflow.items.map(i => i.updatedAt)].sort().at(-1)!, budget: workflow.budget });
  } else if (packet) {
    if (packet.readiness) appendRun(packet.readiness, packet.reusedReadiness ? packet.createdAt : undefined);
    if (packet.location) appendRun(packet.location);
    else if (packet.status !== 'running') add({ agent: 'code-location', at: packet.finishedAt!,
      type: packet.locationDisposition === 'failed' ? 'stage.failed' : 'stage.skipped',
      ...(packet.locationDisposition === 'failed' ? { failure: failure(packet.failure) } :
        { reason: packet.locationDisposition === 'not_eligible' ? 'not_eligible' : packet.status === 'failed' ? 'readiness_failed' : 'location_not_started' }) });
    add({ type: packet.status === 'running' ? 'workflow.unfinished' : `workflow.${packet.status}`,
      at: packet.finishedAt ?? events.at(-1)!.at,
      failure: packet.status === 'failed' || packet.status === 'partial' && packet.failure ? failure(packet.failure) : undefined });
  } else {
    appendRun(run!);
    add({ type: run!.status === 'running' ? 'workflow.unfinished' : `workflow.${run!.status}`,
      at: run!.finishedAt ?? events.at(-1)!.at });
  }
  return WorkflowEventExport.parse({ schemaVersion: 1, kind: 'workflow-events', mode: 'derived-snapshot', workflowId, events });
}
