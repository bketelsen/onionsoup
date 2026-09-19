import {VerificationPlan,validateTask} from './repository-profile.ts';
import {z} from 'zod';
import {hash} from '../repository-brief/contracts.ts';
import {projectProfile} from './profiles.ts';
import {Runtime} from './contracts.ts';
import {Job,Files,Dependency,Verification,PatchResult,ReviewResult,validateJob,CheckId,jobPolicy,usesGo,type WorkerId} from './contracts.ts';
import {validateParent,proof,type ProjectProposal} from './proposal.ts';
import {validateProjectAgentRun,type ProjectAgentRun} from './agents.ts';
export type ProjectWorkflow={schemaVersion:1;kind:'project-change';workflowId:string;startedAt:string;finishedAt?:string;status:'running'|'completed'|'failed';
  parent:ProjectProposal;job:Job;verificationPlan?:VerificationPlan;runtime:Runtime;dependencies:Dependency;seedHash:string;baseline?:Verification;candidate?:Verification;after?:Files;headCommit?:string;headTree?:string;diff?:string;diffHash?:string;appliedTree?:string;
  stages:Array<{agent:WorkerId;reservedAt:string;run?:ProjectAgentRun}>;pendingExecution?:unknown;outcome?:'candidate_verified'|'needs_information'|'verification_failed'|'review_blocked'|'execution_failed'};
export function projectInput(w:ProjectWorkflow,id:WorkerId) {
  const base={schemaVersion:2,job:w.job,before:w.job.files,fileHashes:Object.fromEntries(Object.entries(w.job.files).map(([p,v])=>[p,hash(v)])),baseline:w.baseline};
  return id==='scoped-patch'?base:{...base,after:w.after,candidate:w.candidate,diff:w.diff,diffHash:w.diffHash};
}
export function baselineEligibleProject(w:ProjectWorkflow) {return !!w.baseline&&['passed','checks_failed'].includes(w.baseline.status)&&w.baseline.cleanup==='removed'&&jobPolicy(w.job).baseline.every(id=>w.baseline!.checks.find(c=>c.id===id)?.status==='passed')&&(w.job.schemaVersion===1||w.job.task.checks.filter(c=>c.baseline==='fail').every(c=>w.baseline!.checks.find(r=>r.id===c.id)?.status==='failed')); }
export function validateProject(raw:unknown):ProjectWorkflow {
  const w=raw as ProjectWorkflow;
  if(!w||w.schemaVersion!==1||w.kind!=='project-change'||!z.uuid().safeParse(w.workflowId).success||!z.iso.datetime().safeParse(w.startedAt).success||!['running','completed','failed'].includes(w.status)||!Array.isArray(w.stages)||w.stages.length>2)throw new Error('Invalid project workflow');
  const j=validateJob(w.job),parent=validateParent(w.parent);Runtime.parse(w.runtime);Dependency.parse(w.dependencies);
  if(j.parentHash!==hash(parent)||j.proposalHash!==hash(proof(parent.proposal!))||j.requirementsHash!==hash(proof(parent.requirements!))||j.baseCommit!==parent.commit||j.baseTree!==parent.tree||hash(parent.files)!==j.sourceHash||w.dependencies.lockHash!==j.lockHash||w.dependencies.packageHash!==j.packageHash)throw new Error('Parent or dependency binding changed');
  if(usesGo(j)!==(w.runtime.schemaVersion===2)||usesGo(j)!==(w.dependencies.schemaVersion===2))throw new Error('Language execution binding changed');
  if(w.runtime.schemaVersion===2&&w.dependencies.schemaVersion===2&&w.runtime.goHash!==w.dependencies.goHash)throw new Error('Toolchain changed');
  if(j.schemaVersion===2){validateTask(j.repositoryProfile,j.task,w.verificationPlan);if(!w.verificationPlan||hash(w.verificationPlan.checks)!==hash(j.verificationSummary)||hash(w.runtime)!==j.runtimeHash||hash(w.dependencies)!==j.dependencyHash||hash(j.repositoryProfile)!==hash(parent.repositoryProfile)||hash(j.task)!==hash(parent.task))throw new Error('Accepted task bindings changed');}
  for(const [phase,r] of [['baseline',w.baseline],['candidate',w.candidate]] as const)if(r){Verification.parse(r);
    if(r.phase!==phase||r.jobHash!==hash(j)||r.tree!==(phase==='baseline'?j.baseTree:w.headTree)||r.runtimeHash!==hash(w.runtime)||r.dependencyHash!==hash(w.dependencies)||r.profileHash!==j.profileHash||r.seedHash!==w.seedHash)throw new Error('Verification binding mismatch');
    if(['passed','checks_failed'].includes(r.status)&&(r.exitCode!==0||r.cleanup!=='removed'||hash(r.checks.map(c=>c.id).sort())!==hash([...jobPolicy(j).checks].sort())||r.status!==(r.checks.every(c=>c.status==='passed')?'passed':'checks_failed')))throw new Error('Incomplete check evidence');
  }
  for(const [i,s] of w.stages.entries()){
    if(s.agent!==(i===0?'scoped-patch':'change-review')||!z.iso.datetime().safeParse(s.reservedAt).success)throw new Error('Invalid reservation');
    if(s.run){const r=validateProjectAgentRun(s.run);if(r.inputHash!==hash(projectInput(w,s.agent))||r.agent!==s.agent||r.model!=='gpt-5.6-terra'||!['copilot','codex'].includes(r.provider))throw new Error('Worker input changed');}
  }
  if(w.after){Files.parse(w.after);const p=PatchResult.parse(w.stages[0]?.run?.result);if(p.status!=='candidate'||hash(w.after)!==hash({...j.files,...Object.fromEntries(p.edits.map(e=>[e.path,e.content]))}))throw new Error('Unbound patch');}
  if(w.diff!==undefined&&hash(w.diff)!==w.diffHash)throw new Error('Diff mismatch');
  if(w.status==='running'?w.finishedAt!==undefined||w.outcome!==undefined:!z.iso.datetime().safeParse(w.finishedAt).success||!w.outcome)throw new Error('Termination mismatch');
  if(w.outcome==='candidate_verified'&&(w.status!=='completed'||!baselineEligibleProject(w)||w.pendingExecution||!w.headCommit||!w.headTree||!w.diff||w.appliedTree!==w.headTree||w.candidate?.status!=='passed'||w.stages[1]?.run?.status!=='completed'||ReviewResult.parse(w.stages[1].run.result).verdict!=='no_blocking_findings'))throw new Error('Invalid verified candidate');
  return w;
}
