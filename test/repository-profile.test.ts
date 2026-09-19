import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {model} from './helpers/owned-fixture.ts';
import {git} from '../src/fixture-runner/fixture.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {RepositoryProfile,GoRepositoryProfile,Task,VerificationPlan,validateTask,standardGoChecks} from '../src/project-change/repository-profile.ts';
import {GoRuntime,GoDependency,Verification,validateJob,validateResult,type Job} from '../src/project-change/contracts.ts';
import {proposeProject,acceptProject} from '../src/project-change/proposal.ts';
import {executeProject} from '../src/project-change/recipe.ts';
import {validateProject,projectInput} from '../src/project-change/record.ts';
import {evaluateTaskOutput,taskHarness} from '../src/project-change/task-verification.ts';
import {prepareProjectPublication} from '../src/project-change/publication.ts';
import {validateCommit} from '../src/publication/bundle.ts';
import {verifyGoProject} from '../src/project-change/go-sandbox.ts';
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const profile=GoRepositoryProfile.parse(await json('examples/repository-profiles/clippy.json'));
const task=Task.parse(await json('examples/project-tasks/clippy-no-clobber.json'));
const plan=VerificationPlan.parse(await json('examples/project-tasks/clippy-no-clobber-checks.json'));
const c=(text:string)=>({text,basis:'proposed',evidenceIds:['issue:body']});
const requirements={schemaVersion:1,status:'sufficient_for_proposal',userNeed:c('Protect files.'),scenarios:[c('Select flag.')],constraints:[],nonGoals:[],questions:[]};
const proposal={schemaVersion:1,status:'proposal_ready',outcome:c('Protect files.'),changes:[{...c('Add option.'),evidenceIds:['source:1']}],nonGoals:[],acceptanceCriteria:[{id:'AC1',criterion:c('Keep existing behavior.')},{id:'AC2',criterion:c('Implement requested behavior, tests and docs.')}],verification:[{criterionIds:['AC1'],kind:'compatibility',check:c('Original checks.'),baselineExpectation:'existing_behavior'},{criterionIds:['AC2'],kind:'acceptance',check:c('Task checks.'),baselineExpectation:'capability_absent'}],compatibility:c('Keep defaults.'),migration:c('None.'),documentation:c('Document.'),questions:[],risks:[c('Finite checks.')]};
const mapping:Job['mapping']=[{criterionId:'AC1',checks:[...standardGoChecks,'task-overwrite-compatibility']},{criterionId:'AC2',checks:task.checks.filter(c=>c.id!=='task-overwrite-compatibility').map(c=>c.id)}];
const prepareModel=async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(i=>'changeKind'in i?proposal:requirements)});
const runtime=GoRuntime.parse({schemaVersion:2,imageId:'sha256:'+'a'.repeat(64),goDirectory:'/fixture/go',goHash:profile.execution.toolchain.digest,goVersion:profile.execution.toolchain.version,podmanVersion:'fixture'});
async function setup(t:any){
 const root=await mkdtemp(join(tmpdir(),'onionsoup-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo');await mkdir(repo);
 for(const [p,content] of Object.entries({'main.go':'package main\n\nfunc main() {}\n','main_test.go':'package main\n','README.md':'# Fixture\n','go.mod':'module github.com/bketelsen/clippy\n\ngo 1.21\n','go.sum':''}))await writeFile(join(repo,p),content);
 await git(repo,['init','-q']);await git(repo,['remote','add','origin','https://github.com/bketelsen/clippy.git']);await git(repo,['add','.']);await git(repo,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Baseline']);
 const base=(await git(repo,['rev-parse','HEAD'])).trim(),def={...task,baseCommit:base,context:task.allowedFiles.map(path=>({path,startLine:1,endLine:1}))},dir=join(root,'proposal');
 const parent=await proposeProject(repo,base,dir,'copilot',{repositoryProfile:profile,task:def,modelFactory:prepareModel});assert.equal(parent.status,'completed');
 const deps=GoDependency.parse({schemaVersion:2,directory:'/fixture/modules',packageHash:hash(await readFile(join(repo,'go.mod'),'utf8')),lockHash:hash(''),treeHash:'c'.repeat(64),goHash:runtime.goHash,goVersion:runtime.goVersion,registry:'https://proxy.golang.org',checksumDatabase:'sum.golang.org',createdAt:new Date().toISOString()});
 const job=await acceptProject(repo,dir,mapping,'Scripted software test authority.',{runtime,dependencies:deps,verificationPlan:plan});
 return {root,repo,base,def,dir,deps,job};
}
test('repository/task definitions reject authority expansion, unbound checks and altered profiles',()=>{
 validateTask(profile,task,plan);
 for(const path of ['go.mod','.github/test.yml','resources/font.ttf','../outside','main.go;echo'])assert.throws(()=>validateTask(profile,{...task,allowedFiles:[path]},plan));
 assert.throws(()=>validateTask({...profile,repository:'bketelsen/another'},task,plan));
 assert.throws(()=>validateTask(profile,{...task,checks:[...task.checks,task.checks[0]]},plan));
 assert.throws(()=>validateTask(profile,task,{...plan,source:plan.source+'\n// changed'}));
 assert.throws(()=>RepositoryProfile.parse({...profile,execution:{...profile.execution,command:'rm -rf /'}}));
 const absent={...plan,checks:[{id:'task-missing',kind:'go-test',test:'TestNotPresent'}]};assert.throws(()=>validateTask(profile,{...task,checks:[{id:'task-missing',baseline:'pass'}],verificationHash:hash(absent)},absent));
});
test('one unchanged profile accepts both feature task artifacts without feature-specific adapters',async()=>{
 const bubble=Task.parse(await json('examples/project-tasks/clippy-bubble-color.json')),checks=VerificationPlan.parse(await json('examples/project-tasks/clippy-bubble-color-checks.json'));
 validateTask(profile,bubble,checks);validateTask(profile,task,plan);
 assert.equal(bubble.repositoryProfileHash,task.repositoryProfileHash);assert.notEqual(bubble.verificationHash,task.verificationHash);
 assert.equal(plan.source,await readFile('examples/project-tasks/clippy-no-clobber-tests.go.txt','utf8'));
});
test('shared workflow binds a v2 task and keeps independent tests out of worker context',async t=>{
 const f=await setup(t);let calls=0;
 const options={directory:join(f.root,'run'),runtime,dependencies:f.deps,provider:'copilot' as const,modelFactory:async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(()=>calls++===0?{schemaVersion:2,status:'candidate',summary:'Scripted plumbing test.',edits:f.job.allowedFiles.map(path=>({path,beforeHash:hash(f.job.files[path]),content:f.job.files[path]+'\n// Added fixture line.\n'})),questions:[]}:{schemaVersion:2,verdict:'no_blocking_findings',findings:[],limitations:['Scripted boundary test only.']})}),
 verify:async(...args:Parameters<typeof verifyGoProject>)=>{const [checkout,commit,j,rt,d,seeds,o]=args,at=new Date().toISOString();await o.checkpoint?.({phase:o.phase});return Verification.parse({schemaVersion:1,receiptId:randomUUID(),phase:o.phase,jobHash:hash(j),tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),runtimeHash:hash(rt),dependencyHash:hash(d),profileHash:j.profileHash,seedHash:hash(seeds),startedAt:at,finishedAt:at,status:o.phase==='baseline'?'checks_failed':'passed',checks:[...standardGoChecks,...task.checks.map(c=>c.id)].map(id=>({id,status:o.phase==='baseline'&&id.startsWith('task-')&&id!=='task-overwrite-compatibility'?'failed':'passed'})),exitCode:0,cleanup:'removed',commandHash:'d'.repeat(64),outputHash:'e'.repeat(64),containerName:'onionsoup-project-'+randomUUID()});}};
 const w=await executeProject(f.repo,f.dir,options);assert.equal(w.outcome,'candidate_verified');assert.equal(calls,2);assert.equal(w.job.schemaVersion,2);
 assert.equal(JSON.stringify(projectInput(w,'scoped-patch')).includes('preserve every byte'),false);
 assert.equal(JSON.stringify(projectInput(w,'change-review')).includes('preserve every byte'),false);
 // Existing fake file contains only a package line, so replace it outright too.
 assert.throws(()=>validateResult('scoped-patch',{schemaVersion:2,status:'candidate',summary:'Weaken tests.',edits:[{path:'main_test.go',beforeHash:hash(f.job.files['main_test.go']),content:'// removed\npackage main\n'}],questions:[]},projectInput(w,'scoped-patch')));
 const changed=structuredClone(w);changed.verificationPlan!.source+='\n// tampered';assert.throws(()=>validateProject(changed));
 const accepted=f.job;if(accepted.schemaVersion!==2)throw new Error('Expected task');assert.throws(()=>validateJob({...accepted,task:{...accepted.task,baseCommit:'0'.repeat(40)}}));
 await assert.rejects(executeProject(f.repo,f.dir,{...options,directory:join(f.root,'denied'),runtime:{...runtime,goHash:'f'.repeat(64)}}));assert.equal(calls,2);
 const config={schemaVersion:1 as const,stateDirectory:join(f.root,'published'),targets:[{repository:profile.repository,repositoryId:profile.repositoryId,baseBranch:profile.baseBranch,baseCommit:f.base}]};
 const b=await prepareProjectPublication(config,options.directory,config.targets[0]);await validateCommit(config,b);assert.equal(b.title,task.title);
 await assert.rejects(prepareProjectPublication({...config,targets:[{...config.targets[0],repositoryId:123}]},options.directory,{...config.targets[0],repositoryId:123}));
});
test('task verification requires a named passing test and exact marker coverage',async t=>{
 const f=await setup(t),nonce=randomUUID();let output='';
 for(const id of [...standardGoChecks,...plan.checks.filter(c=>c.kind==='go-test').map(c=>c.id)]){
  const def=plan.checks.find(c=>c.id===id);if(def?.kind==='go-test')output+=JSON.stringify({Action:'pass',Test:def.test})+'\n';output+=`${nonce}:${id}:0\n`;
 }
 const files=Object.fromEntries(Object.entries(f.job.files).map(([p,v])=>[p,v+'\n// changed']));
 assert.ok(evaluateTaskOutput(f.job,plan,output,nonce,files).every(c=>c.status==='passed'));
 const missing=output.split('\n').filter(l=>!l.includes('"Test":"TestOnionsoupNoClobberStdout"')).join('\n');assert.equal(evaluateTaskOutput(f.job,plan,missing,nonce,files).find(c=>c.id==='task-no-clobber-stdout')!.status,'failed');
 assert.throws(()=>evaluateTaskOutput(f.job,plan,output+`${nonce}:go-test:0\n`,nonce,files));assert.ok(taskHarness(f.job,plan).includes('-json -overlay='));
});
test('real reusable Go adapter rejects absent feature while preserving standard checks',{skip:!process.env.ONIONSOUP_GO_CHECKOUT},async t=>{
 const root=await mkdtemp(join(tmpdir(),'onionsoup-profile-real-'));t.after(()=>rm(root,{recursive:true,force:true}));const checkout=process.env.ONIONSOUP_GO_CHECKOUT!,dir=join(root,'proposal');
 const rt=GoRuntime.parse(await json(process.env.ONIONSOUP_GO_RUNTIME!)),deps=GoDependency.parse(await json(process.env.ONIONSOUP_GO_DEPENDENCIES!));
 await proposeProject(checkout,task.baseCommit,dir,'copilot',{repositoryProfile:profile,task,modelFactory:prepareModel});const job=await acceptProject(checkout,dir,mapping,'Scripted integration preflight.',{runtime:rt,dependencies:deps,verificationPlan:plan});
 const r=await verifyGoProject(checkout,task.baseCommit,job,rt,deps,[],{directory:join(root,'baseline'),phase:'baseline',verificationPlan:plan});
 assert.equal(r.status,'checks_failed');for(const id of [...standardGoChecks,'task-overwrite-compatibility'])assert.equal(r.checks.find(c=>c.id===id)?.status,'passed',id);
 for(const id of ['task-no-clobber-files','task-no-clobber-stdout'])assert.equal(r.checks.find(c=>c.id===id)?.status,'failed',id);assert.equal(r.cleanup,'removed');
});
