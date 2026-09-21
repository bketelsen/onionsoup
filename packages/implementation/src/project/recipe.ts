import {VerificationPlan,validateTask} from './repository-profile.ts';
import {repositoryAdapterHash} from './task-verification.ts';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson} from '@onionsoup/runtime/storage';
import {git} from '../fixture/fixture.ts';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {Runtime} from './contracts.ts';
import {projectProfile,GO_PROFILE} from './profiles.ts';
import {verifyGoProject} from './go-sandbox.ts';
import {liveModel} from '@onionsoup/providers';
import {Dependency,validateJob,PatchResult,ReviewResult,PROFILE_LIMITS,paths,type WorkerId,jobPolicy,usesGo,applyProjectPatch} from './contracts.ts';
import {patchProject,reviewProject} from './agents.ts';
import {verifyProject} from './sandbox.ts';
import {sourceFiles} from './source.ts';
import {validateParent} from './proposal.ts';
import {seedsFrom,profileHash} from './profile.ts';
import {projectInput,validateProject,baselineEligibleProject,type ProjectWorkflow} from './record.ts';
export async function executeProject(checkout:string,proposalDirectory:string,options:{directory:string;runtime:Runtime;dependencies:Dependency;seedBundle?:unknown;provider:'copilot'|'codex';modelFactory?:typeof liveModel;verify?:typeof verifyProject;signal?:AbortSignal;persist?:typeof atomicJson}) {
  const job=validateJob(await readJson(join(proposalDirectory,'job.json'))),parent=validateParent(await readJson(join(proposalDirectory,'proposal.json')));
  if(job.profileHash!==(job.schemaVersion===2?await repositoryAdapterHash(job.repositoryProfile.execution.adapter):await profileHash(job.profile))||hash(await sourceFiles(checkout,job.baseCommit,job.allowedFiles))!==job.sourceHash)throw new Error('Frozen project inputs changed');
  const verificationPlan=job.schemaVersion===2?VerificationPlan.parse(await readJson(join(proposalDirectory,'checks.json'))):undefined;
  if(job.schemaVersion===2){validateTask(job.repositoryProfile,job.task,verificationPlan);if(hash(options.runtime)!==job.runtimeHash||hash(options.dependencies)!==job.dependencyHash)throw new Error('Accepted execution environment changed');}
  const dir=resolve(options.directory);await mkdir(dir,{mode:0o700});const seeds=job.schemaVersion===2||usesGo(job)?[]:seedsFrom(options.seedBundle);await atomicJson(join(dir,'seeds.json'),seeds);
  const w:ProjectWorkflow={schemaVersion:1,kind:'project-change',workflowId:randomUUID(),startedAt:new Date().toISOString(),status:'running',parent,job,runtime:options.runtime,dependencies:options.dependencies,seedHash:hash(seeds),...(verificationPlan?{verificationPlan}:{}),stages:[]};
  let broken=false;const save=async()=>{try{await(options.persist??atomicJson)(join(dir,'project.json'),structuredClone(validateProject(w)));}catch{broken=true;throw new Error('Project persistence failed');}};await save();
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(PROFILE_LIMITS.workflowMs)]);
  const verify=async(phase:'baseline'|'candidate')=>{
    signal.throwIfAborted();w[phase]=await(options.verify??(usesGo(job)?verifyGoProject:verifyProject))(phase==='baseline'?checkout:join(dir,'candidate'),phase==='baseline'?job.baseCommit:w.headCommit!,job,w.runtime,w.dependencies,seeds,
      {directory:join(dir,phase+'-verification'),phase,signal,verificationPlan,checkpoint:async intent=>{w.pendingExecution=intent;await save();}});delete w.pendingExecution;await save();
  };
  const agent=async(id:WorkerId)=>{
    signal.throwIfAborted();if(w.stages.length>=2)throw new Error('Budget exhausted');const stage:ProjectWorkflow['stages'][number]={agent:id,reservedAt:new Date().toISOString()};w.stages.push(stage);await save();
    const adapter=await(options.modelFactory??liveModel)('gpt-5.6-terra',options.provider);if(adapter.provider!==options.provider||adapter.modelId!=='gpt-5.6-terra')throw new Error('Provider mismatch');
    stage.run=await(id==='scoped-patch'?patchProject:reviewProject)(projectInput(w,id),{...adapter,signal,checkpoint:async r=>{stage.run=r;await save();}});if(stage.run.status!=='completed')throw new Error('Worker failed');return stage.run.result;
  };
  try {
    await verify('baseline');
    // Existing behavior and setup must pass. Missing new feature assertions remain explicit gaps.
    if(!baselineEligibleProject(w))throw new Error('Ineligible project baseline');
    const patch=PatchResult.parse(await agent('scoped-patch'));
    if(patch.status==='needs_information')w.outcome='needs_information';
    else {
      w.after=applyProjectPatch(job,patch);await save();
      const candidate=join(dir,'candidate');await git(dir,['clone','--no-local','--quiet','--no-checkout',resolve(checkout),candidate]);await git(candidate,['read-tree',job.baseCommit]);
      for(const path of job.allowedFiles){await mkdir(join(candidate,path,'..'),{recursive:true});await writeFile(join(candidate,path),w.after[path],{flag:'wx',mode:0o600});}
      await git(candidate,['add','--',...job.allowedFiles]);
      w.diff=await git(candidate,['diff','--cached','--no-ext-diff','--no-textconv',job.baseCommit]);w.diffHash=hash(w.diff);w.headTree=(await git(candidate,['write-tree'])).trim();
      const changed=(await git(candidate,['diff','--cached','--name-only',job.baseCommit])).trim().split('\n');if(changed.some(p=>!job.allowedFiles.includes(p as any)))throw new Error('Patch exceeds scope');
      w.headCommit=(await git(candidate,['-c','user.name=Onionsoup Agent','-c','user.email=agent@example.invalid','commit-tree',w.headTree,'-p',job.baseCommit,'-m',jobPolicy(job).title])).trim();
      await git(candidate,['update-ref','refs/heads/codex/candidate',w.headCommit]);
      await writeFile(join(dir,'candidate.patch'),w.diff,{flag:'wx',mode:0o600});
      const applied=join(dir,'apply-check');await git(dir,['clone','--no-local','--quiet','--no-checkout',candidate,applied]);await git(applied,['read-tree',job.baseCommit]);await git(applied,['apply','--cached',join(dir,'candidate.patch')]);w.appliedTree=(await git(applied,['write-tree'])).trim();if(w.appliedTree!==w.headTree)throw new Error('Diff does not reconstruct candidate');await save();
      await verify('candidate');
      if(w.candidate!.status!=='passed')w.outcome='verification_failed';
      else {const review=ReviewResult.parse(await agent('change-review'));w.outcome=review.verdict==='no_blocking_findings'?'candidate_verified':'review_blocked';}
    }
    w.status='completed';
  }catch{if(broken)throw new Error('Project persistence failed; inspect artifacts');w.status='failed';w.outcome='execution_failed';}
  w.finishedAt=new Date().toISOString();await save();return w;
}
