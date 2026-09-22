import {EVALUATION_MODEL} from '@onionsoup/providers/evaluation-policy';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {atomicJson,readJson} from '@onionsoup/runtime/storage';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {git} from '../fixture/fixture.ts';
import {liveModel} from '@onionsoup/providers';
import {extractFeatureRequirements,draftChangeProposal,validateProposalAgentRun,type ProposalAgentRun} from '@onionsoup/maintenance/proposal/agents';
import {Proposal,FeatureRequirements} from '@onionsoup/maintenance/proposal/contracts';
import {sourceFiles} from './source.ts';
import {Job,validateJob,PROFILE,paths,GoRuntime,GoDependency,Runtime,NodeDependency,type Files} from './contracts.ts';
export {requestText} from './profiles.ts';
import {projectProfile,profiles,GO_PROFILE,type ProfileId} from './profiles.ts';
import {RepositoryProfile,Task,VerificationPlan,REPOSITORY_TASK,validateTask,profilePolicy} from './repository-profile.ts';
import {repositoryAdapterHash} from './task-verification.ts';
export type ProjectProposal={schemaVersion:1|2;repositoryProfile?:RepositoryProfile;task?:Task;kind:'operator-project-proposal';requestId:string;repository:string;commit:string;tree:string;files:Files;request:string;status:'running'|'completed'|'failed';reserved:number;requirements?:ProposalAgentRun;proposal?:ProposalAgentRun};
export function validateParent(raw:unknown):ProjectProposal {
  const p=raw as ProjectProposal;
  if(!p||![1,2].includes(p.schemaVersion)||p.kind!=='operator-project-proposal'||(p.schemaVersion===1&&!Object.values(profiles).some(v=>v.repository===p.repository&&v.request===p.request))||!z.uuid().safeParse(p.requestId).success||p.status!=='completed'||p.reserved!==2)throw new Error('Incomplete project proposal');
  if(p.schemaVersion===2){const {profile,task}=validateTask(p.repositoryProfile,p.task);if(p.repository!==profile.repository||p.request!==task.request||p.commit!==task.baseCommit||hash(Object.keys(p.files).sort())!==hash([...task.allowedFiles].sort()))throw new Error('Task proposal mismatch');}
  const r=validateProposalAgentRun(p.requirements),q=validateProposalAgentRun(p.proposal),input=q.input as any;
  if(r.agent!=='feature-requirements'||q.agent!=='change-proposal'||r.status!=='completed'||q.status!=='completed'||input.commit!==p.commit||input.packetId!==p.requestId||input.packetHash!==hash({requestId:p.requestId,text:p.request})||hash(input.requirements)!==hash(r.result)||hash(input.issue)!==hash((r.input as any).issue)||input.issue.repository!==p.repository||(r.input as any).issue.body!==p.request)throw new Error('Proposal handoff mismatch');
  for(const s of input.sources) {const text=p.files[s.path as keyof Files];if(typeof text!=='string'||text.split('\n').slice(s.startLine-1,s.endLine).join('\n')!==s.quote)throw new Error('Source citation changed');}
  return p;
}
export async function proposeProject(checkout:string,commit:string,directory:string,provider:'copilot'|'codex',options:{modelFactory?:typeof liveModel;profile?:ProfileId;repositoryProfile?:RepositoryProfile;task?:Task}={}) {
  const prepared=options.repositoryProfile||options.task?validateTask(options.repositoryProfile,options.task):undefined;
  if(prepared&&prepared.task.baseCommit!==commit)throw new Error('Task base mismatch');
  const profile=prepared?profilePolicy(prepared.profile,prepared.task):projectProfile(options.profile??PROFILE);
  const origin=(await git(checkout,['remote','get-url','origin'])).trim().replace(/^git@github\.com:/,'').replace(/^https:\/\/github\.com\//,'').replace(/\.git$/,'');
  if(origin!==profile.repository)throw new Error('Owned repository required');
  await mkdir(directory,{mode:0o700});const files=await sourceFiles(checkout,commit,profile.paths),p:ProjectProposal={schemaVersion:prepared?2:1,...(prepared?{repositoryProfile:prepared.profile,task:prepared.task}:{}),kind:'operator-project-proposal',requestId:randomUUID(),repository:profile.repository,commit,tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),files,request:profile.request,status:'running',reserved:0};
  const save=()=>atomicJson(join(directory,'proposal.json'),p);await save();
  const issue={schemaVersion:1,repository:p.repository,number:1,title:'Operator request: '+profile.title,body:p.request,updatedAt:new Date().toISOString()};
  // The existing snapshot envelope's number is a local request ordinal, never a GitHub issue identity.
  p.reserved++;await save();const adapter=await(options.modelFactory??liveModel)(EVALUATION_MODEL,provider);
  if(adapter.provider!==provider||adapter.modelId!==EVALUATION_MODEL)throw new Error('Provider mismatch');
  p.requirements=await extractFeatureRequirements({schemaVersion:1,issue},{...adapter,checkpoint:async r=>{p.requirements=r;await save();}});
  if(p.requirements.status!=='completed'||FeatureRequirements.parse(p.requirements.result).status!=='sufficient_for_proposal'){p.status='failed';await save();return p;}
  const sourcePaths=prepared?prepared.task.context.map(c=>c.path):[...profile.paths,...(profile.language==='go'?['main.go']:[])];
  const sources=sourcePaths.map((path,i)=>{
    const lines=files[path].split('\n');let start=path==='src/console/server.ts'?Math.max(0,lines.findIndex(l=>l.includes("parts[0]==='publications'"))-2):0;
    if(profile.language==='go'&&i===2)start=Math.max(0,lines.findIndex(l=>l.startsWith('func drawBubbleAndText')));
    if(prepared)start=prepared.task.context[i].startLine-1;
    const last=prepared?prepared.task.context[i].endLine:lines.length;
    if(last>lines.length||start>=last)throw new Error('Source selection outside file');
    let end=start,quote='';while(end<last&&(quote+lines[end]+'\n').length<=5500){quote+=(end===start?'':'\n')+lines[end];end++;}
    if(prepared&&end!==last)throw new Error('Source selection exceeds context bound');
    return {id:`source:${i+1}`,path,startLine:start+1,endLine:end,quote,relevance:'unassessed_search_lead'};
  });
  p.reserved++;await save();p.proposal=await draftChangeProposal({schemaVersion:1,packetId:p.requestId,packetHash:hash({requestId:p.requestId,text:p.request}),issue,commit,sources,
    limitations:['Operator-authored request with local ordinal 1, not a fetched GitHub issue.','Bounded pinned source excerpts; the host will inspect full allowed files before accepting. No execution or project acceptance yet.'],changeKind:'feature',requirements:p.requirements.result},
    {...adapter,checkpoint:async r=>{p.proposal=r;await save();}});
  p.status=p.proposal.status==='completed'?'completed':'failed';await save();return p;
}
export const proof=(r:ProposalAgentRun)=>({runId:r.runId,inputHash:r.inputHash,promptVersion:r.promptVersion,result:r.result});
export async function acceptProject(checkout:string,directory:string,mapping:Job['mapping'],reason:string,options:{runtime?:unknown;dependencies?:unknown;verificationPlan?:unknown}={}) {
  const p=validateParent(await readJson(join(directory,'proposal.json')));
  const prepared=p.schemaVersion===2?validateTask(p.repositoryProfile,p.task,options.verificationPlan):undefined;
  const profileId=prepared?REPOSITORY_TASK:p.repository==='bketelsen/clippy'?GO_PROFILE:PROFILE,profile=prepared?profilePolicy(prepared.profile,prepared.task):projectProfile(profileId);
  if(Proposal.parse(p.proposal!.result).status!=='proposal_ready'||hash(await sourceFiles(checkout,p.commit,profile.paths))!==hash(p.files))throw new Error('Ready matching proposal required');
  const proposal=proof(p.proposal!),requirements=proof(p.requirements!);
  let binding={};
  if(prepared){
    const runtime=Runtime.parse(options.runtime),dependencies=prepared.profile.execution.adapter==='go-module-v1'?GoDependency.parse(options.dependencies):NodeDependency.parse(options.dependencies),plan=VerificationPlan.parse(options.verificationPlan);
    validateTask(prepared.profile,prepared.task,plan);
    if(runtime.schemaVersion===2&&dependencies.schemaVersion===2){if(runtime.goHash!==prepared.profile.execution.toolchain.digest||runtime.goVersion!==prepared.profile.execution.toolchain.version||dependencies.goHash!==runtime.goHash||dependencies.goVersion!==runtime.goVersion||dependencies.packageHash!==hash(await git(checkout,['show',p.commit+':go.mod']))||dependencies.lockHash!==hash(await git(checkout,['show',p.commit+':go.sum'])))throw new Error('Resolved environment mismatch');}
    else if(runtime.schemaVersion===1&&dependencies.schemaVersion===1){
      const {readFile}=await import('node:fs/promises'),{byteHash}=await import('./source.ts');
      const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
      if(runtime.nodeHash!==prepared.profile.execution.toolchain.digest||byteHash(await readFile(runtime.nodePath))!==runtime.nodeHash||dependencies.nodeHash!==runtime.nodeHash||(await promisify(execFile)(runtime.nodePath,['--version'],{timeout:10000,env:{}})).stdout.trim()!==prepared.profile.execution.toolchain.version||dependencies.packageHash!==hash(await git(checkout,['show',p.commit+':package.json']))||dependencies.lockHash!==hash(await git(checkout,['show',p.commit+':package-lock.json'])))throw new Error('Resolved environment mismatch');
      if('testFiles'in prepared.profile.verification)await sourceFiles(checkout,p.commit,prepared.profile.verification.testFiles);
    }else throw new Error('Adapter environment mismatch');
    binding={repositoryProfile:prepared.profile,task:prepared.task,verificationSummary:plan.checks,runtimeHash:hash(runtime),dependencyHash:hash(dependencies)};
  }
  const j=validateJob({schemaVersion:prepared?2:1,...binding,kind:'accepted-project-job',jobId:randomUUID(),profile:profileId,repository:p.repository,baseCommit:p.commit,baseTree:p.tree,sourceHash:hash(p.files),files:p.files,parentHash:hash(p),
    proposal,proposalHash:hash(proposal),requirements,requirementsHash:hash(requirements),allowedFiles:profile.paths,mapping,
    packageHash:hash(await git(checkout,['show',p.commit+':'+profile.manifests[0]])),lockHash:hash(await git(checkout,['show',p.commit+':'+profile.manifests[1]])),profileHash:prepared?await repositoryAdapterHash(prepared.profile.execution.adapter):await (await import('./profile.ts')).profileHash(profileId),acceptedAt:new Date().toISOString(),authority:'explicit_user_session',acceptedBy:'assistant_under_user_authority',reason});
  // Explicit one-shot acceptance; no replacement of existing authority.
  const {writeFile}=await import('node:fs/promises');if(prepared)await writeFile(join(directory,'checks.json'),JSON.stringify(VerificationPlan.parse(options.verificationPlan),null,2)+'\n',{flag:'wx',mode:0o600});await writeFile(join(directory,'job.json'),JSON.stringify(j,null,2)+'\n',{flag:'wx',mode:0o600});return j;
}
