import { z } from 'zod';
import { validatePacket, type Packet } from '../packet.ts';
import { hash } from '@onionsoup/repository-analysis/contracts';
import { InvocationBudgetSnapshot } from '@onionsoup/runtime/budget';
import { ProposalInput, SourceEvidence, FeatureRequirements, Proposal, safeInput, LIMITS, ProposalAgentId } from './contracts.ts';
import { validateProposalAgentRun, type ProposalAgentRun } from './agents.ts';
export const Query=z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f]+$/);
export const Preparation=z.object({ sources:z.array(SourceEvidence).max(7),
  attempts:z.array(z.object({ operation:z.enum(['search','read']),status:z.enum(['completed','failed']),path:z.string().max(400).optional() }).strict()).max(4),
  limitations:z.array(z.string().min(1).max(800)).min(1).max(12) }).strict();
export type Preparation=z.infer<typeof Preparation>;
export type ChangeWorkflow={ schemaVersion:1;kind:'change-proposal';workflowId:string;startedAt:string;finishedAt?:string;
  status:'running'|'completed'|'failed';failure?:'execution_error'|'interrupted_or_timed_out'|'agent_failed';
  parent:Packet;parentHash:string;changeKind:'bug_fix'|'feature';query?:string;preparation?:Preparation;
  execution:{provider:'copilot'|'codex';model:string};acceptance:'not_recorded';verification:'not_executed';
  budget:InvocationBudgetSnapshot;stages:Array<{agent:ProposalAgentId;reservedAt:string;reservation:InvocationBudgetSnapshot;run?:ProposalAgentRun}> };
export function eligiblePacket(raw:unknown) {
  const p=validatePacket(raw),a=p.readiness?.assessment;
  if(!['completed','partial'].includes(p.status)||p.readiness?.status!=='completed'||!a||
    !(a.kind==='feature_request'||a.kind==='bug_report'&&a.bug_readiness==='ready')) throw new Error('Packet is not eligible for a change proposal');
  return p;
}
export function bugPreparation(p:Packet):Preparation {
  const b=p.location?.brief;
  return Preparation.parse({ sources:[...(b?.codePointers??[]).map(c=>({...c,relevance:'code_lead'})),
    ...(b?.testPointers??[]).map(c=>({...c,relevance:'relevance' in c?(c.relevance==='direct'?'direct_test':'adjacent_test'):'unassessed_test'}))]
    .map((c,i)=>({id:`source:${i+1}`,path:c.path,startLine:c.startLine,endLine:c.endLine,quote:c.quote,relevance:c.relevance})),attempts:[],
    limitations:['Pinned source may differ from the affected release. Locations are reading leads; no diagnosis or test execution is established.',
      ...(b?.uncertainties??[]),...(!b?.codePointers.length?['No inspected implementation context is available.']:[])] });
}
export function stageInput(w:ChangeWorkflow,id:ProposalAgentId) {
  if(id==='feature-requirements') return safeInput(id,{schemaVersion:1,issue:w.parent.issue});
  if(!w.preparation) throw new Error('Preparation missing');
  return ProposalInput.parse({ schemaVersion:1,packetId:w.parent.packetId,packetHash:w.parentHash,issue:w.parent.issue,
    commit:w.parent.repository.commit,sources:w.preparation.sources,limitations:w.preparation.limitations,changeKind:w.changeKind,
    ...(w.changeKind==='bug_fix'?{readinessSummary:w.parent.readiness!.assessment!.summary}:
      {requirements:FeatureRequirements.parse(w.stages.find(s=>s.agent==='feature-requirements')?.run?.result)}) });
}
export function validateChangeWorkflow(raw:unknown):ChangeWorkflow {
  const w=raw as ChangeWorkflow;
  if(!w||w.schemaVersion!==1||w.kind!=='change-proposal'||!z.uuid().safeParse(w.workflowId).success||
    !z.iso.datetime().safeParse(w.startedAt).success||!['running','completed','failed'].includes(w.status)||
    w.acceptance!=='not_recorded'||w.verification!=='not_executed'||!['copilot','codex'].includes(w.execution?.provider)||
    w.execution?.model!=='gpt-5.6-terra'||!Array.isArray(w.stages)) throw new Error('Invalid proposal workflow');
  const p=eligiblePacket(w.parent);
  if(hash(p)!==w.parentHash||w.changeKind!==(p.readiness!.assessment!.kind==='bug_report'?'bug_fix':'feature')) throw new Error('Parent mismatch');
  if(w.changeKind==='feature') Query.parse(w.query); else if(w.query!==undefined) throw new Error('Unexpected query');
  if(w.preparation) {
    Preparation.parse(w.preparation);
    if(w.changeKind==='bug_fix'&&hash(w.preparation)!==hash(bugPreparation(p))) throw new Error('Bug evidence mismatch');
    if(w.changeKind==='feature'&&(w.preparation.sources.length>LIMITS.sourceReads||w.preparation.sources.some(s=>s.relevance!=='unassessed_search_lead'))) throw new Error('Feature evidence mismatch');
  }
  const expected:ProposalAgentId[]=w.changeKind==='feature'?['feature-requirements','change-proposal']:['change-proposal'];
  InvocationBudgetSnapshot.parse(w.budget);
  if(w.budget.limit!==2||w.budget.consumed!==w.stages.length||w.stages.length>expected.length) throw new Error('Budget mismatch');
  for(const [i,s] of w.stages.entries()) {
    if(!w.preparation||s.agent!==expected[i]||!z.iso.datetime().safeParse(s.reservedAt).success||
      hash(s.reservation)!==hash({limit:2,consumed:i+1,remaining:1-i})||i>0&&w.stages[i-1].run?.status!=='completed') throw new Error('Invalid stage reservation');
    if(s.run) {
      const r=validateProposalAgentRun(s.run);
      if(r.agent!==s.agent||r.inputHash!==hash(safeInput(s.agent,stageInput(w,s.agent)))||r.provider!==w.execution.provider||r.model!==w.execution.model) throw new Error('Stage binding mismatch');
    }
  }
  if(w.status==='running'?(w.finishedAt!==undefined||w.failure!==undefined):!z.iso.datetime().safeParse(w.finishedAt).success) throw new Error('Termination mismatch');
  if(w.status==='completed'&&(w.failure||w.stages.length!==expected.length||w.stages.some(s=>s.run?.status!=='completed'))) throw new Error('Invalid completion');
  if(w.status==='failed'&&!['execution_error','interrupted_or_timed_out','agent_failed'].includes(w.failure??'')) throw new Error('Failure missing');
  return w;
}
export function proposalResult(w:ChangeWorkflow) {
  const run=w.stages.find(s=>s.agent==='change-proposal')?.run;
  return run?.status==='completed'?Proposal.parse(run.result):undefined;
}
