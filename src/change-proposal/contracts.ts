import { z } from 'zod';
import { IssueSnapshot } from '../contracts.ts';
import { Commit, SourcePath } from '../location-contracts.ts';
import { contextText } from '../repository-brief/contracts.ts';
export const ProposalAgentId=z.enum(['feature-requirements','change-proposal']);
export type ProposalAgentId=z.infer<typeof ProposalAgentId>;
export const LIMITS={ invocations:2,steps:3,agentTimeoutMs:90000,timeoutMs:240000,inputChars:60000,sourceReads:3 } as const;
const text=z.string().min(1).max(800);
const refs=z.array(z.string().min(1).max(80)).min(1).max(12);
export const Claim=z.object({ text,basis:z.enum(['reported','proposed']),evidenceIds:refs }).strict();
export const Question=z.object({ question:text,blocking:z.boolean(),evidenceIds:refs }).strict();
export const SourceEvidence=z.object({ id:z.string().regex(/^source:[1-9][0-9]*$/),path:SourcePath,
  startLine:z.number().int().positive(),endLine:z.number().int().positive(),quote:z.string().min(1).max(6000),
  relevance:z.enum(['code_lead','direct_test','adjacent_test','unassessed_test','unassessed_search_lead']) }).strict().superRefine((e,ctx)=>{
  if(e.endLine<e.startLine||e.quote.split('\n').length!==e.endLine-e.startLine+1) ctx.addIssue({ code:'custom',message:'Source range mismatch' });
});
export const FeatureRequirements=z.object({ schemaVersion:z.literal(1),status:z.enum(['sufficient_for_proposal','needs_information']),
  userNeed:Claim,scenarios:z.array(Claim).max(6),constraints:z.array(Claim).max(6),nonGoals:z.array(Claim).max(6),
  questions:z.array(Question).max(8) }).strict();
export const RequirementsInput=z.object({ schemaVersion:z.literal(1),issue:IssueSnapshot }).strict();
const common={ schemaVersion:z.literal(1),packetId:z.uuid(),packetHash:z.string().regex(/^[a-f0-9]{64}$/),
  issue:IssueSnapshot,commit:Commit,sources:z.array(SourceEvidence).max(7),limitations:z.array(text).min(1).max(12) };
export const ProposalInput=z.discriminatedUnion('changeKind',[
  z.object({ ...common,changeKind:z.literal('bug_fix'),readinessSummary:text }).strict(),
  z.object({ ...common,changeKind:z.literal('feature'),requirements:FeatureRequirements }).strict(),
]);
export type ProposalInput=z.infer<typeof ProposalInput>;
export const Proposal=z.object({ schemaVersion:z.literal(1),status:z.enum(['proposal_ready','needs_information']),
  outcome:Claim,changes:z.array(Claim).max(8),nonGoals:z.array(Claim).max(6),
  acceptanceCriteria:z.array(z.object({ id:z.string().regex(/^AC[1-9][0-9]*$/),criterion:Claim }).strict()).max(8),
  verification:z.array(z.object({ criterionIds:z.array(z.string()).min(1).max(8),
    kind:z.enum(['regression','acceptance','compatibility','migration','documentation','manual']),check:Claim,
    baselineExpectation:z.enum(['reported_failure','capability_absent','existing_behavior','not_applicable','unknown']) }).strict()).max(12),
  compatibility:Claim,migration:Claim,documentation:Claim,
  questions:z.array(Question).max(8),risks:z.array(Claim).max(6),
}).strict();
export type Proposal=z.infer<typeof Proposal>;
export const inputSchema=(id:ProposalAgentId)=>id==='feature-requirements'?RequirementsInput:ProposalInput;
export const resultSchema=(id:ProposalAgentId)=>id==='feature-requirements'?FeatureRequirements:Proposal;
export function safeInput(id:ProposalAgentId,raw:unknown) {
  const input=inputSchema(id).parse(raw), serialized=JSON.stringify(input);
  if(serialized.length>LIMITS.inputChars) throw new Error('Context exceeds bound');
  if(contextText(serialized)!==serialized) throw new Error('Sensitive input must be removed before invocation');
  if(id==='change-proposal'&&new Set(ProposalInput.parse(input).sources.map(e=>e.id)).size!==ProposalInput.parse(input).sources.length) throw new Error('Duplicate source IDs');
  if(id==='change-proposal') { const p=ProposalInput.parse(input); if(p.changeKind==='feature') validateResult('feature-requirements',p.requirements,{schemaVersion:1,issue:p.issue}); }
  return input;
}
export function validateResult(id:ProposalAgentId,raw:unknown,input:unknown,requireScopedSource=true) {
  const parsed=safeInput(id,input),result=resultSchema(id).parse(raw);
  const known=new Set(['issue:title',...(parsed.issue.body?['issue:body']:[]),...(id==='change-proposal'?ProposalInput.parse(parsed).sources.map(s=>s.id):[])]);
  if('requirements' in parsed) known.add('requirements');
  if('readinessSummary' in parsed) known.add('readiness');
  const inspect=(value:unknown):void=>{
    if(!value||typeof value!=='object') return;
    if('evidenceIds' in value) {
      const ids=(value as {evidenceIds:string[]}).evidenceIds;
      if(new Set(ids).size!==ids.length||ids.some(ref=>!known.has(ref))) throw new Error('UNKNOWN_OR_DUPLICATE_EVIDENCE');
    }
    for(const child of Object.values(value)) if(Array.isArray(child)) child.forEach(inspect); else inspect(child);
  };inspect(result);
  const blocking=result.questions.some(q=>q.blocking);
  if(result.status==='needs_information'?!blocking:blocking) throw new Error('STATUS_QUESTION_MISMATCH');
  if('userNeed' in result) {
    if(result.status==='sufficient_for_proposal'&&!result.scenarios.length) throw new Error('SCENARIO_REQUIRED');
  } else {
    const p=ProposalInput.parse(parsed),ids=result.acceptanceCriteria.map(c=>c.id);
    if(new Set(ids).size!==ids.length) throw new Error('DUPLICATE_CRITERION');
    if(result.verification.some(v=>new Set(v.criterionIds).size!==v.criterionIds.length||v.criterionIds.some(id=>!ids.includes(id)))) throw new Error('UNKNOWN_CRITERION');
    if(p.changeKind==='feature'&&result.verification.some(v=>v.baselineExpectation==='reported_failure')) throw new Error('FEATURE_IS_NOT_REPRODUCED_BUG');
    if(result.status==='proposal_ready') {
      if(requireScopedSource&&![...result.changes,...result.verification.map(v=>v.check)].some(c=>c.evidenceIds.some(id=>id.startsWith('source:')))) throw new Error('SOURCE_SUPPORTED_SCOPE_REQUIRED');
      if(!p.sources.length||p.changeKind==='feature'&&p.requirements.status!=='sufficient_for_proposal') throw new Error('INSUFFICIENT_PREPARATION');
      if(!ids.length||!result.changes.length||ids.some(id=>!result.verification.some(v=>v.criterionIds.includes(id)))) throw new Error('CRITERION_COVERAGE_REQUIRED');
      if(!result.verification.some(v=>v.kind===(p.changeKind==='bug_fix'?'regression':'acceptance'))||p.changeKind==='feature'&&!result.verification.some(v=>v.kind==='compatibility')) throw new Error('VERIFICATION_PROFILE_REQUIRED');
    }
  }
  if(contextText(JSON.stringify(result))!==JSON.stringify(result)) throw new Error('SENSITIVE_RESULT');
  return result;
}
