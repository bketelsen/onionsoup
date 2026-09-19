import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {readJson} from '../batch-store.ts';
import {hash} from '../repository-brief/contracts.ts';
import {providerName} from '../providers.ts';
import {Runtime,GoRuntime} from './contracts.ts';
import {profiles,type ProfileId} from './profiles.ts';
import {pinGoRuntime,provisionGoDependencies} from './go-dependencies.ts';
import {proposeProject,acceptProject} from './proposal.ts';
import {provisionDependencies} from './dependencies.ts';
import {executeProject} from './recipe.ts';
import {Dependency} from './contracts.ts';
import {prepareProjectPublication} from './publication.ts';
import {loadPublicationConfig} from '../publication/bundle.ts';
globalThis.AI_SDK_LOG_WARNINGS=false;
try {
 const {positionals,values:v}=parseArgs({allowPositionals:true,options:{profile:{type:'string'},image:{type:'string'},'go-directory':{type:'string'},checkout:{type:'string'},commit:{type:'string'},output:{type:'string'},proposal:{type:'string'},mapping:{type:'string'},reason:{type:'string'},runtime:{type:'string'},dependencies:{type:'string'},seed:{type:'string'},provider:{type:'string'},config:{type:'string'},project:{type:'string'},'target-index':{type:'string'}}});
 const command=positionals[0];if(positionals.length!==1)throw new Error('Arguments');let result:unknown;
 if(v.profile&&!Object.hasOwn(profiles,v.profile))throw new Error('Unknown profile');
 if(command==='propose'&&v.checkout&&v.commit&&v.output&&v.provider){const r=await proposeProject(resolve(v.checkout),v.commit,resolve(v.output),providerName(v.provider),{profile:v.profile as ProfileId|undefined});result={requestId:r.requestId,status:r.status,result:r.proposal?.result};}
 else if(command==='accept'&&v.checkout&&v.proposal&&v.mapping&&v.reason){const j=await acceptProject(resolve(v.checkout),resolve(v.proposal),await readJson(v.mapping) as any,v.reason);result={jobId:j.jobId,jobHash:hash(j)};}
 else if(command==='pin-go'&&v.image&&v['go-directory']&&v.output){result=await pinGoRuntime(v.image,v['go-directory']);const {writeFile}=await import('node:fs/promises');await writeFile(v.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});}
 else if(command==='go-dependencies'&&v.checkout&&v.commit&&v.output&&v.runtime)result=await provisionGoDependencies(resolve(v.checkout),v.commit,resolve(v.output),GoRuntime.parse(await readJson(v.runtime)));
 else if(command==='dependencies'&&v.checkout&&v.commit&&v.output)result=await provisionDependencies(resolve(v.checkout),v.commit,resolve(v.output));
 else if(command==='execute'&&v.checkout&&v.proposal&&v.output&&v.runtime&&v.dependencies&&v.provider){const w=await executeProject(resolve(v.checkout),resolve(v.proposal),{directory:resolve(v.output),runtime:Runtime.parse(await readJson(v.runtime)),dependencies:Dependency.parse(await readJson(v.dependencies)),seedBundle:v.seed?await readJson(v.seed):undefined,provider:providerName(v.provider)});result={workflowId:w.workflowId,status:w.status,outcome:w.outcome,stages:w.stages.length};if(w.outcome!=='candidate_verified')process.exitCode=1;}
 else if(command==='prepare-publication'&&v.config&&v.project&&/^\d+$/.test(v['target-index']??'')){const c=await loadPublicationConfig(v.config),b=await prepareProjectPublication(c,resolve(v.project),c.targets[Number(v['target-index'])]);result={publicationId:b.publicationId,bundleHash:hash(b),headCommit:b.headCommit};}
 else throw new Error('Arguments');process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch{process.stderr.write('Project command failed. Inspect saved artifacts; no automatic replay. Commands: propose (--profile ID), accept, dependencies, pin-go, go-dependencies, execute, prepare-publication.\n');process.exitCode=1;}
