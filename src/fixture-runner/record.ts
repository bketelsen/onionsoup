import {z} from 'zod';
import {hash} from '../repository-brief/contracts.ts';
import {Scope,Files,Runtime,Receipt,PatchResult,ReviewResult,POLICY,type FixtureCase} from './contracts.ts';
import {validateFixtureAgentRun,type FixtureAgentRun} from './agents.ts';
import {InvocationBudgetSnapshot} from '../invocation-budget.ts';
import type {ExecutionIntent} from './sandbox.ts';
import {checks} from './fixture.ts';
export type FixtureWorkflow={schemaVersion:1;kind:'fixture-change';workflowId:string;startedAt:string;finishedAt?:string;
  status:'running'|'completed'|'failed';mode:'baseline'|'patch';case:FixtureCase;runtime:Runtime;seed:string;
  execution:{provider:'copilot'|'codex';model:'gpt-5.6-terra'};scope?:Scope;before?:Files;after?:Files;
  baseline?:Receipt;candidate?:Receipt;pendingExecution?:ExecutionIntent;diff?:string;diffHash?:string;diffAppliedTreeHash?:string;
  budget:InvocationBudgetSnapshot;stages:Array<{agent:'scoped-patch'|'change-review';reservedAt:string;reservation:InvocationBudgetSnapshot;run?:FixtureAgentRun}>;
  outcome?:'baseline_observed'|'candidate_verified'|'needs_information'|'verification_failed'|'review_blocked'|'execution_failed';
  failure?:'execution_error'|'agent_failed'|'cancelled';publication:'not_authorized'};
export function baselineEligible(w:FixtureWorkflow) {
  const r=w.baseline;if(!r||r.cleanup!=='removed') return false;
  return w.case==='bug'?r.status==='assertion_failed'&&r.checks.some(c=>c.criterionIds.includes('AC1')&&c.status==='assertion_failed')&&r.checks.filter(c=>c.criterionIds.includes('AC2')).every(c=>c.status==='passed'):
    r.status==='capability_absent'&&r.checks.filter(c=>c.criterionIds.includes('AC1')).every(c=>c.status==='capability_absent')&&r.checks.filter(c=>c.criterionIds.includes('AC2')).every(c=>c.status==='passed');
}
export function agentInput(w:FixtureWorkflow,id:'scoped-patch'|'change-review') {
  if(!w.scope||!w.before||!w.baseline||!baselineEligible(w)) throw new Error('Missing eligible baseline');
  return id==='scoped-patch'?{schemaVersion:1,scope:w.scope,files:w.before,fileHashes:Object.fromEntries(Object.entries(w.before).map(([p,s])=>[p,hash(s)])),baseline:w.baseline}:
    {schemaVersion:1,scope:w.scope,before:w.before,after:w.after,baseline:w.baseline,candidate:w.candidate,diff:w.diff,diffHash:w.diffHash};
}
export function validateFixtureWorkflow(raw:unknown):FixtureWorkflow {
  const w=raw as FixtureWorkflow;
  if(!w||w.schemaVersion!==1||w.kind!=='fixture-change'||!z.uuid().safeParse(w.workflowId).success||!z.uuid().safeParse(w.seed).success||
    !z.iso.datetime().safeParse(w.startedAt).success||!['running','completed','failed'].includes(w.status)||!['baseline','patch'].includes(w.mode)||
    !['bug','feature'].includes(w.case)||w.publication!=='not_authorized'||!['copilot','codex'].includes(w.execution?.provider)||w.execution.model!=='gpt-5.6-terra'||!Array.isArray(w.stages)) throw new Error('Invalid fixture workflow');
  Runtime.parse(w.runtime);InvocationBudgetSnapshot.parse(w.budget);
  if(w.budget.limit!==2||w.budget.consumed!==w.stages.length||w.stages.length>2) throw new Error('Budget mismatch');
  if(w.scope) {Scope.parse(w.scope);if(w.scope.case!==w.case||hash(Files.parse(w.before))!==w.scope.baseTree) throw new Error('Scope mismatch');}
  if(w.mode==='baseline'&&(w.stages.length||w.after||w.candidate)) throw new Error('Baseline workflow cannot contain a patch');
  if(w.after) Files.parse(w.after);
  if(w.diffAppliedTreeHash!==undefined&&w.diffAppliedTreeHash!==hash(w.after)) throw new Error('Applied diff tree mismatch');
  if(w.diff!==undefined&&w.diffHash!==hash(w.diff)) throw new Error('Diff changed');
  for(const [phase,r] of [['baseline',w.baseline],['candidate',w.candidate]] as const) if(r) {
    Receipt.parse(r);if(!w.scope||r.phase!==phase||r.treeHash!==hash(phase==='baseline'?w.before:w.after)||r.scopeHash!==hash(w.scope)||r.runtimeHash!==hash(w.runtime)||r.policyHash!==hash(POLICY)||r.caseSetHash!==hash(checks(w.case,w.seed))) throw new Error('Receipt binding mismatch');
    if(['passed','assertion_failed','capability_absent'].includes(r.status)) {
      const expectedIds=[...checks(w.case,w.seed).map(c=>c.id),...(w.case==='feature'?['export-documentation']:[])];
      if(hash(r.checks.map(c=>c.id))!==hash(expectedIds)||r.exitCode!==0||r.cleanup!=='removed') throw new Error('Incomplete checks');
      for(const c of r.checks) { const ids=c.id==='export-documentation'?['AC3']:checks(w.case,w.seed).find(e=>e.id===c.id)!.criterionIds; if(hash(c.criterionIds)!==hash(ids)||c.reason!==(c.status==='passed'?'matched':c.status==='capability_absent'?'export_absent':'value_mismatch')) throw new Error('Check mapping mismatch'); }
      const derived=r.checks.some(c=>c.status==='capability_absent')?'capability_absent':r.checks.some(c=>c.status==='assertion_failed')?'assertion_failed':'passed';
      if(r.status!==derived) throw new Error('False receipt success');
    }
  }
  if(w.pendingExecution&&(!w.scope||w.pendingExecution.scopeHash!==hash(w.scope)||w.pendingExecution.runtimeHash!==hash(w.runtime)||w.pendingExecution.policyHash!==hash(POLICY))) throw new Error('Execution intent mismatch');
  for(const [i,s] of w.stages.entries()) {
    if(s.agent!==(i===0?'scoped-patch':'change-review')||!z.iso.datetime().safeParse(s.reservedAt).success||hash(s.reservation)!==hash({limit:2,consumed:i+1,remaining:1-i})) throw new Error('Reservation mismatch');
    if(s.run) {const r=validateFixtureAgentRun(s.run);if(r.agent!==s.agent||r.inputHash!==hash(agentInput(w,s.agent))||r.provider!==w.execution.provider||r.model!==w.execution.model) throw new Error('Agent binding mismatch');}
  }
  const patch=w.stages[0]?.run?.result;
  if(w.after) {
    const result=PatchResult.parse(patch);
    if(w.stages[0].run?.status!=='completed'||result.status!=='candidate'||hash(w.after)!==hash({...w.before,...Object.fromEntries(result.edits.map(e=>[e.path,e.content]))})) throw new Error('Candidate not produced by saved patch');
  }
  if(w.status==='running'?(w.finishedAt!==undefined||w.outcome!==undefined):!z.iso.datetime().safeParse(w.finishedAt).success||!w.outcome) throw new Error('Termination mismatch');
  if(w.outcome==='baseline_observed'&&(w.mode!=='baseline'||!baselineEligible(w)||w.stages.length)) throw new Error('Invalid baseline success');
  if(w.outcome==='candidate_verified'&&(!w.after||w.diffAppliedTreeHash!==hash(w.after)||w.candidate?.status!=='passed'||w.stages[1]?.run?.status!=='completed'||ReviewResult.parse(w.stages[1].run.result).verdict!=='no_blocking_findings')) throw new Error('Invalid candidate success');
  if(w.status==='failed'&&(w.outcome!=='execution_failed'||!['execution_error','agent_failed','cancelled'].includes(w.failure??''))) throw new Error('Failure outcome mismatch');
  if(w.outcome==='needs_information'&&(w.after||w.stages[0]?.run?.status!=='completed'||PatchResult.parse(w.stages[0].run.result).status!=='needs_information')) throw new Error('Missing information outcome mismatch');
  if(w.status==='completed'&&!['baseline_observed','candidate_verified','needs_information','review_blocked','verification_failed'].includes(w.outcome??'')) throw new Error('Invalid completed outcome');
  return w;
}
