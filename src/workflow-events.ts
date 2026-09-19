import {validateProject} from './project-change/record.ts';
import {validateProjectAgentRun} from './project-change/agents.ts';
import {FixtureAgentId} from './fixture-runner/contracts.ts';
import {validateFixtureWorkflow} from './fixture-runner/record.ts';
import {validateFixtureAgentRun} from './fixture-runner/agents.ts';
import { ProposalAgentId } from './change-proposal/contracts.ts';
import { validateChangeWorkflow } from './change-proposal/record.ts';
import { validateProposalAgentRun } from './change-proposal/agents.ts';
import { OperatorRecord } from './console/contracts.ts';
import { DeliveryRecord } from './delivery/contracts.ts';
import { RepoAgentId, hash } from './repository-brief/contracts.ts';
import { validateRepositoryBrief, stageAgent } from './repository-brief/record.ts';
import { validateRepoAgentRun } from './repository-brief/agents.ts';
import { z } from 'zod';
import { validateBriefing } from './briefing-record.ts';
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
  agent: z.enum(['bug-readiness', 'code-location', ...RepoAgentId.options, ...ProposalAgentId.options, ...FixtureAgentId.options]).optional(), runId: Id.optional(), parentRunId: Id.optional(),
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
const usage = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null;
  return Usage.parse(Object.fromEntries(Object.keys(Usage.shape).map(key => [key, number(key)])));
};
const failure = (raw: unknown): z.infer<typeof Failures> => Failures.safeParse(raw).success ? raw as z.infer<typeof Failures> : 'unknown_failure';

// The original records remain the truth. No provider calls, new timestamps, or raw content.
export function workflowEvents(raw: unknown): z.infer<typeof WorkflowEventExport> {
  const candidate = raw as Record<string, unknown>;
  if(candidate?.kind==='project-change'||candidate?.schemaVersion===2&&FixtureAgentId.safeParse(candidate?.agent).success) {
    const w=candidate.kind==='project-change'?validateProject(raw):undefined;
    const standalone=w?undefined:validateProjectAgentRun(raw),workflowId=w?.workflowId??standalone!.runId,events:WorkflowEvent[]=[];
    const add=(event:Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>)=>events.push(WorkflowEvent.parse({...event,schemaVersion:1,workflowId,sequence:events.length,...(w?{scopeId:w.job.jobId,repositoryCommit:w.job.baseCommit,parentWorkflowId:w.parent.requestId}:{})}));
    const receipt=(r:NonNullable<ReturnType<typeof validateProject>['baseline']>)=>{
      const base={receiptId:r.receiptId,inputHash:r.jobHash,runtimeHash:r.runtimeHash,verificationPhase:r.phase};
      add({...base,type:'verification.started',at:r.startedAt});add({...base,type:'verification.completed',at:r.finishedAt,verificationOutcome:r.status==='checks_failed'?'assertion_failed':r.status});
    };
    const append=(r:ReturnType<typeof validateProjectAgentRun>)=>{const base={agent:r.agent,runId:r.runId,inputHash:r.inputHash,promptVersion:r.promptVersion,provider:r.provider,model:r.model,recordVersion:2};
      add({...base,type:'agent.started',at:r.startedAt});add({...base,type:r.status==='running'?'agent.unfinished':`agent.${r.status}`,at:r.finishedAt??r.startedAt,usage:usage(r.tokenUsage?.totals),failure:r.failure});};
    add({type:'workflow.started',at:w?.startedAt??standalone!.startedAt});
    if(w){if(w.baseline)receipt(w.baseline);for(const [i,s] of w.stages.entries()){
      if(s.agent==='change-review'&&w.candidate)receipt(w.candidate);
      add({type:'workflow.budget_reserved',at:s.reservedAt,agent:s.agent,stageKey:s.agent==='scoped-patch'?'patch':'review',budget:{limit:2,consumed:i+1,remaining:1-i}});if(s.run)append(s.run);
    }if(w.candidate&&!w.stages.some(s=>s.agent==='change-review'))receipt(w.candidate);
    }else append(standalone!);
    const r=w??standalone!;add({type:r.status==='running'?'workflow.unfinished':`workflow.${r.status}`,at:r.finishedAt??r.startedAt});
    return WorkflowEventExport.parse({schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId,events});
  }

  if(candidate?.kind==='fixture-change'||FixtureAgentId.safeParse(candidate?.agent).success) {
    const w=candidate.kind==='fixture-change'?validateFixtureWorkflow(raw):undefined;
    const standalone=w?undefined:validateFixtureAgentRun(raw),workflowId=w?.workflowId??standalone!.runId,events:WorkflowEvent[]=[];
    const add=(event:Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>)=>events.push(WorkflowEvent.parse({
      ...event,schemaVersion:1,workflowId,sequence:events.length,...(w?.scope?{scopeId:w.scope.scopeId,repositoryCommit:w.scope.baseCommit}:{})}));
    add({type:'workflow.started',at:w?.startedAt??standalone!.startedAt});
    const append=(r:ReturnType<typeof validateFixtureAgentRun>)=>{
      const base={agent:r.agent,runId:r.runId,inputHash:r.inputHash,promptVersion:r.promptVersion,provider:r.provider,model:r.model,recordVersion:1};
      add({...base,type:'agent.started',at:r.startedAt});
      for(const e of r.events) if(z.iso.datetime().safeParse(e.at).success&&['stepStart','stepFinish','toolInputStart'].includes(e.type)) add({...base,
        type:e.type==='stepStart'?'agent.step_started':e.type==='stepFinish'?'agent.step_finished':'agent.tool_requested',at:e.at,step:e.step,...(e.tool==='submit_result'?{tool:'submit_result' as const}:{})});
      add({...base,type:r.status==='running'?'agent.unfinished':`agent.${r.status}`,at:r.finishedAt??r.startedAt,usage:usage(r.tokenUsage?.totals),failure:r.failure});
    };
    const receipt=(r:NonNullable<ReturnType<typeof validateFixtureWorkflow>['baseline']>)=>{
      const base={receiptId:r.receiptId,treeHash:r.treeHash,inputHash:r.scopeHash,runtimeHash:r.runtimeHash,verificationPhase:r.phase};
      add({...base,type:'verification.started',at:r.startedAt});add({...base,type:'verification.completed',at:r.finishedAt,verificationOutcome:r.status});
    };
    if(w) {
      if(w.baseline) receipt(w.baseline);
      for(const s of w.stages) {
        if(s.agent==='change-review'&&w.candidate) receipt(w.candidate);
        add({type:'workflow.budget_reserved',at:s.reservedAt,agent:s.agent,stageKey:s.agent==='scoped-patch'?'patch':'review',budget:s.reservation});
        if(s.run) append(s.run);
      }
      if(w.candidate&&!w.stages.some(s=>s.agent==='change-review')) receipt(w.candidate);
      if(w.pendingExecution) add({type:'verification.started',at:w.pendingExecution.startedAt,receiptId:w.pendingExecution.receiptId,treeHash:w.pendingExecution.treeHash,verificationPhase:w.pendingExecution.phase});
    } else append(standalone!);
    const record=w??standalone!;
    add({type:record.status==='running'?'workflow.unfinished':`workflow.${record.status}`,at:record.finishedAt??record.startedAt,...(w?{budget:w.budget}:{})});
    return WorkflowEventExport.parse({schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId,events});
  }
  if(candidate?.kind==='change-proposal'||ProposalAgentId.safeParse(candidate?.agent).success) {
    const w=candidate.kind==='change-proposal'?validateChangeWorkflow(raw):undefined;
    const standalone=w?undefined:validateProposalAgentRun(raw),workflowId=w?.workflowId??standalone!.runId,events:WorkflowEvent[]=[];
    const add=(event:Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>)=>events.push(WorkflowEvent.parse({
      ...event,schemaVersion:1,workflowId,sequence:events.length,...(w?{parentWorkflowId:w.parent.packetId,repositoryCommit:w.parent.repository.commit}:{}) }));
    add({type:'workflow.started',at:w?.startedAt??standalone!.startedAt});
    const append=(r:ReturnType<typeof validateProposalAgentRun>)=>{
      const base={agent:r.agent,runId:r.runId,inputHash:r.inputHash,promptVersion:r.promptVersion,provider:r.provider,model:r.model,recordVersion:1};
      add({...base,type:'agent.started',at:r.startedAt});
      for(const e of r.events) if(z.iso.datetime().safeParse(e.at).success&&['stepStart','stepFinish','toolInputStart'].includes(e.type))
        add({...base,type:e.type==='stepStart'?'agent.step_started':e.type==='stepFinish'?'agent.step_finished':'agent.tool_requested',at:e.at,step:e.step,
          ...(e.tool==='submit_result'?{tool:'submit_result' as const}:{})});
      add({...base,type:r.status==='running'?'agent.unfinished':`agent.${r.status}`,at:r.finishedAt??r.startedAt,usage:usage(r.tokenUsage?.totals),
        ...(r.result?{outcome:(r.result as {status:'proposal_ready'|'needs_information'|'sufficient_for_proposal'}).status}:{}),failure:r.failure});
    };
    if(w) for(const s of w.stages) {
      add({type:'workflow.budget_reserved',at:s.reservedAt,agent:s.agent,stageKey:s.agent==='feature-requirements'?'requirements':'proposal',budget:s.reservation});
      if(s.run) append(s.run);
      else add({type:w.status==='running'?'stage.unfinished':'stage.failed',agent:s.agent,at:w.finishedAt??s.reservedAt});
    } else append(standalone!);
    const record=w??standalone!;
    add({type:record.status==='running'?'workflow.unfinished':`workflow.${record.status}`,at:record.finishedAt??record.startedAt,...(w?{budget:w.budget}:{})});
    return WorkflowEventExport.parse({schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId,events});
  }
  if (candidate?.kind === 'operator-action') {
    const r=OperatorRecord.parse(raw), q=r.request;
    const base={ schemaVersion:1 as const,workflowId:r.workflowId,operatorAction:q.action,inputHash:r.inputHash,
      ...(q.action==='investigate'?{ parentWorkflowId:q.briefId,issueNumber:q.number }:q.action==='propose'?{parentWorkflowId:q.packetId}:{}),repositoryCommit:r.commit };
    return WorkflowEventExport.parse({ schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId:r.workflowId,events:[
      { ...base,sequence:0,type:'operator.requested',at:r.startedAt },
      { ...base,sequence:1,type:r.status==='running'?'operator.unfinished':`operator.${r.status}`,at:r.finishedAt??r.startedAt,
        ...(r.result && 'workflowId' in r.result?{ childWorkflowId:r.result.workflowId }:{}) },
    ] });
  }
  if (candidate?.kind === 'brief-delivery') {
    const r=DeliveryRecord.parse(raw), events:WorkflowEvent[]=[];
    const add=(event:Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>)=>events.push(WorkflowEvent.parse({
      ...event,schemaVersion:1,workflowId:r.workflowId,sequence:events.length }));
    add({ type:'workflow.started',at:r.createdAt });
    if (r.analysisFailure) add({ type:'workflow.failed',at:r.analysisFailure.at,failure:'execution_error' });
    if (r.message) add({ type:'delivery.prepared',at:r.message.preparedAt,parentWorkflowId:r.brief!.workflowId,inputHash:r.message.hash });
    for (const [index,a] of r.attempts.entries()) {
      const base={ deliveryAttempt:index+1,parentWorkflowId:r.brief!.workflowId,inputHash:r.message!.hash };
      add({ ...base,type:'delivery.attempted',at:a.startedAt });
      add({ ...base,type:a.outcome==='sending'?'delivery.unknown':`delivery.${a.outcome}`,at:a.finishedAt??a.startedAt });
      if (a.resolution) add({ ...base,type:'delivery.reconciled',at:a.resolution.at,deliveryResolution:a.resolution.outcome });
    }
    return WorkflowEventExport.parse({ schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId:r.workflowId,events });
  }
  if (candidate?.kind === 'repository-brief' || RepoAgentId.safeParse(candidate?.agent).success) {
    const b = candidate?.kind === 'repository-brief' ? validateRepositoryBrief(raw) : undefined;
    const standalone = b ? undefined : validateRepoAgentRun(raw);
    const workflowId = b?.workflowId ?? standalone!.runId, events: WorkflowEvent[] = [];
    const add = (e: Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>) => {
      events.push(WorkflowEvent.parse({ ...e, schemaVersion: 1, workflowId, sequence: events.length }));
    };
    const append = (r: ReturnType<typeof validateRepoAgentRun>, stageKey?: WorkflowEvent['stageKey']) => {
      const base = { stageKey, agent: r.agent, runId: r.runId, inputHash: r.inputHash, promptVersion: r.promptVersion,
        recordVersion: r.schemaVersion, provider: r.provider, model: r.model };
      add({ ...base, type: 'agent.started', at: r.startedAt });
      for (const e of r.events) {
        const type = e.type === 'stepStart' ? 'agent.step_started' : e.type === 'stepFinish' ? 'agent.step_finished' : e.type === 'toolInputStart' ? 'agent.tool_requested' : undefined;
        if (type && z.iso.datetime().safeParse(e.at).success) add({ ...base, type, at: e.at, step: e.step,
          tool: e.tool === 'submit_result' ? 'submit_result' : undefined });
      }
      add({ ...base, type: r.status === 'running' ? 'agent.unfinished' : r.status === 'completed' ? 'agent.completed' : 'agent.failed',
        at: r.finishedAt ?? r.events.at(-1)?.at ?? r.startedAt, failure: r.failure,
        usage: usage(r.tokenUsage?.totals) });
    };
    add({ type: 'workflow.started', at: b?.startedAt ?? standalone!.startedAt,
      ...(b ? { budget: { limit: 4, consumed: 0, remaining: 4 } } : {}) });
    if (b) {
      add({ type: b.snapshot ? 'stage.completed' : b.failure ? 'stage.failed' : 'stage.unfinished', stageKey: 'collection',
        at: b.snapshot?.finishedAt ?? b.finishedAt ?? b.startedAt, inputHash: b.snapshotHash ?? hash(b.request) });
      for (const stage of b.stages) {
        const base = { stageKey: stage.key, agent: stageAgent[stage.key], at: stage.updatedAt };
        if (stage.reservation) add({ ...base, type: 'workflow.budget_reserved', at: stage.reservedAt!, budget: stage.reservation });
        if (stage.run) append(stage.run,stage.key);
        else add({ ...base, type: stage.status === 'failed' ? 'stage.failed' : stage.status === 'not_attempted' ? 'stage.skipped' : 'stage.unfinished',
          ...(stage.status === 'failed' ? { failure: 'execution_error' as const } : { reason: stage.reason as 'no_data'|'disabled'|'cancelled'|'prior_attempt_unfinished'|undefined ?? 'not_started' }) });
      }
      add({ type: b.status === 'running' ? 'workflow.unfinished' : `workflow.${b.status}`, at: b.finishedAt ?? events.at(-1)!.at, budget: b.budget });
    } else { append(standalone!); add({ type: standalone!.status === 'running' ? 'workflow.unfinished' : `workflow.${standalone!.status}`, at: standalone!.finishedAt ?? events.at(-1)!.at }); }
    return WorkflowEventExport.parse({ schemaVersion: 1, kind: 'workflow-events', mode: 'derived-snapshot', workflowId, events });
  }
  if (candidate?.kind === 'maintenance-briefing') {
    const b = validateBriefing(raw), events: WorkflowEvent[] = [];
    const add = (event: Omit<WorkflowEvent, 'schemaVersion' | 'workflowId' | 'sequence'>) => {
      events.push(WorkflowEvent.parse({ ...event, schemaVersion: 1, workflowId: b.workflowId, sequence: events.length }));
    };
    add({ type: 'workflow.started', at: b.startedAt, budget: { limit: 7, consumed: 0, remaining: 7 } });
    const append = (child: unknown, issueIndex?: number) => {
      const export_ = workflowEvents(child);
      for (const e of export_.events) {
        if (e.type.startsWith('workflow.') && e.type !== 'workflow.budget_reserved') continue;
        add({ ...e, childWorkflowId: export_.workflowId, ...(issueIndex !== undefined ? { issueIndex } : {}) });
      }
    };
    if (b.readiness) append(b.readiness);
    for (const [issueIndex, slot] of b.locations.entries()) {
      if (slot.handoff) append(slot.handoff, issueIndex);
      else add({ type: slot.disposition === 'pending' ? 'stage.unfinished' : 'stage.skipped',
        at: b.finishedAt ?? b.readiness?.finishedAt ?? b.startedAt, agent: 'code-location', issueIndex,
        parentRunId: b.readiness?.items[issueIndex].run?.runId,
        reason: slot.disposition === 'pending' ? 'not_started' : slot.disposition === 'readiness_unavailable' ? 'readiness_failed' :
          slot.disposition as 'not_eligible' | 'selection_limit' | 'cancelled' | 'prior_attempt_unfinished' });
    }
    add({ type: b.status === 'running' ? 'workflow.unfinished' : `workflow.${b.status}`,
      at: b.finishedAt ?? events.at(-1)!.at, budget: b.budget, failure: b.failure ? b.failure === 'cancelled' ? 'interrupted_or_timed_out' : 'execution_error' : undefined });
    return WorkflowEventExport.parse({ schemaVersion: 1, kind: 'workflow-events', mode: 'derived-snapshot', workflowId: b.workflowId, events });
  }
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
