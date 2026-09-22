import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {model} from './helpers/owned-fixture.ts';
import {git} from '../src/fixture-runner/fixture.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {byteHash} from '../src/project-change/source.ts';
import {NodeRepositoryProfile,Task,NodeVerificationPlan,validateTask} from '../src/project-change/repository-profile.ts';
import {Runtime,NodeDependency,Verification,validateResult,applyProjectPatch,type Job} from '../src/project-change/contracts.ts';
import {nodeTaskInput,nodeTestEvidence,evaluateNodeTask} from '../src/project-change/node-task-verification.ts';
import {proposeProject,acceptProject} from '../src/project-change/proposal.ts';
import {executeProject} from '../src/project-change/recipe.ts';
import {verifyProject} from '../src/project-change/sandbox.ts';
import {projectInput,validateProject} from '../src/project-change/record.ts';
import {prepareProjectPublication} from '../src/project-change/publication.ts';
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const profile=NodeRepositoryProfile.parse(await json('examples/repository-profiles/onionsoup-delivery.json'));
const task=Task.parse(await json('examples/project-tasks/onionsoup-schedule-preview.json'));
const plan=NodeVerificationPlan.parse(await json('examples/project-tasks/onionsoup-schedule-preview-checks.json'));
const c=(text:string)=>({text,basis:'proposed',evidenceIds:['issue:body']});
const requirements={schemaVersion:1,status:'sufficient_for_proposal',userNeed:c('Preview schedules.'),scenarios:[c('Read upcoming dates.')],constraints:[],nonGoals:[],questions:[]};
const proposal={schemaVersion:1,status:'proposal_ready',outcome:c('Preview schedules.'),changes:[{...c('Add helper.'),evidenceIds:['source:1']}],nonGoals:[],acceptanceCriteria:[{id:'AC1',criterion:c('Preserve compatibility and implement preview with tests and docs.')}],verification:[{criterionIds:['AC1'],kind:'compatibility',check:c('Keep original behavior.'),baselineExpectation:'existing_behavior'},{criterionIds:['AC1'],kind:'acceptance',check:c('Run checks.'),baselineExpectation:'capability_absent'}],compatibility:c('Preserve existing helpers.'),migration:c('None.'),documentation:c('Document helper.'),questions:[],risks:[c('Finite checks.')]};
const prepareModel=async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(i=>'changeKind'in i?proposal:requirements)});
const mapping:Job['mapping']=[{criterionId:'AC1',checks:[...profile.verification.required,...task.checks.map(c=>c.id)]}];
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'onionsoup-node-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo');await mkdir(repo);
 for(const path of [...task.allowedFiles,'package.json','package-lock.json']){await mkdir(dirname(join(repo,path)),{recursive:true});await writeFile(join(repo,path),path.endsWith('.json')?'{}\n':'// Fixture\n');}
 await git(repo,['init','-q']);await git(repo,['remote','add','origin','https://github.com/bketelsen/onionsoup.git']);await git(repo,['add','.']);await git(repo,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Baseline']);
 const base=(await git(repo,['rev-parse','HEAD'])).trim(),digest=byteHash(await readFile(process.execPath));
 const p={...profile,execution:{...profile.execution,toolchain:{version:process.version,digest}}};
 const def={...task,repositoryProfileHash:hash(p),baseCommit:base,context:task.allowedFiles.map(path=>({path,startLine:1,endLine:1}))};
 const runtime=Runtime.parse({schemaVersion:1,imageId:'sha256:'+'a'.repeat(64),nodePath:process.execPath,nodeHash:digest,podmanVersion:'fixture'});
 const dependencies=NodeDependency.parse({schemaVersion:1,directory:'/fixture/modules',packageHash:hash('{}\n'),lockHash:hash('{}\n'),treeHash:'c'.repeat(64),nodeHash:digest,npmHash:'b'.repeat(64),npmVersion:'fixture',scripts:'disabled',registry:'https://registry.npmjs.org/',createdAt:new Date().toISOString()});
 const dir=join(root,'proposal');await proposeProject(repo,base,dir,{repositoryProfile:p,task:def,models:prepareModel});
 const job=await acceptProject(repo,dir,mapping,'Scripted boundary test.',{runtime,dependencies,verificationPlan:plan});return {root,repo,dir,job,runtime,dependencies,base};
}
test('Node profiles reject mixed adapters, task commands, altered test coverage and missing host exports',async()=>{
 validateTask(profile,task,plan);assert.equal(plan.source,await readFile('examples/project-tasks/onionsoup-schedule-preview-checks.mjs','utf8'));
 for(const path of ['package.json','package-lock.json','tsconfig.json','.npmrc','.github/build.yml','../escape'])assert.throws(()=>validateTask(profile,{...task,allowedFiles:[path]},plan));
 assert.throws(()=>validateTask({...profile,verification:{...profile.verification,testFiles:[]}},task,plan));
 assert.throws(()=>validateTask({...profile,verification:{...profile.verification,testFiles:['test/another.test.ts']}},task,plan));
 assert.throws(()=>NodeRepositoryProfile.parse({...profile,execution:{...profile.execution,command:'npm test'}}));
 const mixed={...plan,adapter:'go-module-v1'};assert.throws(()=>validateTask(profile,{...task,verificationHash:hash(mixed)},mixed));
 const absent={...plan,source:'// No exports'};assert.throws(()=>validateTask(profile,{...task,verificationHash:hash(absent)},absent));
});
const tap='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('Node selected-suite evidence rejects missing, skipped, cancelled, todo and duplicate summaries',()=>{
 assert.equal(nodeTestEvidence(tap),true);
 for(const output of ['',tap.replace('# tests 2','# tests 0'),tap.replace('# pass 2','# pass 1'),tap.replace('# skipped 0','# skipped 1'),tap.replace('# cancelled 0','# cancelled 1'),tap.replace('# todo 0','# todo 1'),tap+'# pass 2\n'])assert.equal(nodeTestEvidence(output),false);
});
test('Node tasks reuse acceptance, workers and publisher while keeping host assertions private',async t=>{
 const f=await fixture(t);let calls=0;
 const options={directory:join(f.root,'run'),runtime:f.runtime,dependencies:f.dependencies,provider:'copilot' as const,models:async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(()=>calls++===0?{schemaVersion:2,status:'candidate',summary:'Scripted helper.',edits:f.job.allowedFiles.map(path=>({path,beforeHash:hash(f.job.files[path]),...(path.endsWith('.test.ts')?{operation:'append',content:'\n// Added\n'}:{content:f.job.files[path]+'// Added\n'})})),questions:[]}:{schemaVersion:2,verdict:'no_blocking_findings',findings:[],limitations:['Scripted plumbing only.']})}),verify:async(...args:Parameters<typeof verifyProject>)=>{
 const [checkout,commit,j,rt,d,seeds,o]=args,at=new Date().toISOString();assert.deepEqual(seeds,[]);await o.checkpoint?.({phase:o.phase});
 return Verification.parse({schemaVersion:1,receiptId:randomUUID(),phase:o.phase,jobHash:hash(j),tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),runtimeHash:hash(rt),dependencyHash:hash(d),profileHash:j.profileHash,seedHash:hash(seeds),startedAt:at,finishedAt:at,status:o.phase==='baseline'?'checks_failed':'passed',checks:mapping[0].checks.map(id=>({id,status:o.phase==='baseline'&&task.checks.find(c=>c.id===id)?.baseline==='fail'?'failed':'passed'})),exitCode:0,cleanup:'removed',commandHash:'d'.repeat(64),outputHash:'e'.repeat(64),containerName:'onionsoup-project-'+randomUUID()});}};
 const w=await executeProject(f.repo,f.dir,options);assert.equal(w.outcome,'candidate_verified');assert.equal(calls,2);
 for(const id of ['scoped-patch','change-review'] as const)assert.equal(JSON.stringify(projectInput(w,id)).includes('2026-03-15T06:30:00.000Z'),false);
 const suffix='\n// Appended regression test\n';
 const edit={schemaVersion:2,status:'candidate',summary:'Append tests.',edits:[{path:'test/delivery.test.ts',beforeHash:hash(f.job.files['test/delivery.test.ts']),operation:'append',content:suffix}],questions:[]};
 assert.equal(applyProjectPatch(f.job,edit)['test/delivery.test.ts'],f.job.files['test/delivery.test.ts']+suffix);
 assert.throws(()=>applyProjectPatch(f.job,{...edit,edits:[{...edit.edits[0],beforeHash:'0'.repeat(64)}]}));
 assert.throws(()=>applyProjectPatch(f.job,{...edit,edits:[{...edit.edits[0],content:'x'.repeat(40000)}]}));
 assert.throws(()=>applyProjectPatch(f.job,{...edit,edits:[{...edit.edits[0],path:'src/delivery/schedule.ts',beforeHash:hash(f.job.files['src/delivery/schedule.ts'])}]}));
 const input=projectInput(w,'scoped-patch');assert.throws(()=>validateResult('scoped-patch',{schemaVersion:2,status:'candidate',summary:'Remove tests.',edits:[{path:'test/delivery.test.ts',beforeHash:hash(f.job.files['test/delivery.test.ts']),content:'// replaced'}],questions:[]},input));
 const altered=structuredClone(w);altered.verificationPlan!.source+='\n// changed';assert.throws(()=>validateProject(altered));
 await assert.rejects(executeProject(f.repo,f.dir,{...options,directory:join(f.root,'denied'),dependencies:{...f.dependencies,treeHash:'f'.repeat(64)}}));assert.equal(calls,2);
 const config={schemaVersion:1 as const,stateDirectory:join(f.root,'published'),targets:[{repository:profile.repository,repositoryId:profile.repositoryId,baseBranch:profile.baseBranch,baseCommit:f.base}]};
 const b=await prepareProjectPublication(config,options.directory,config.targets[0]);assert.equal(b.title,task.title);
 const nonce=randomUUID(),command={code:0,stdout:'',stderr:'',overflow:false},observations={nonce,typecheck:command,tests:{...command,stdout:tap},checks:nodeTaskInput(f.job,plan,nonce).checks.map(c=>({id:c.id,status:'passed'}))};
 assert.ok(evaluateNodeTask(f.job,plan,observations,nonce,w.after!).every(c=>c.status==='passed'));
 assert.throws(()=>evaluateNodeTask(f.job,plan,{...observations,nonce:'wrong'},nonce,w.after!));
 assert.throws(()=>evaluateNodeTask(f.job,plan,{...observations,checks:observations.checks.slice(1)},nonce,w.after!));
 assert.throws(()=>evaluateNodeTask(f.job,plan,{...observations,checks:[observations.checks[0],...observations.checks.slice(0,-1)]},nonce,w.after!));
 assert.equal(evaluateNodeTask(f.job,plan,{...observations,tests:{...observations.tests,code:1}},nonce,w.after!).find(c=>c.id==='node-tests')?.status,'failed');
});
test('real reusable Node adapter reports preview absence with complete selected-suite coverage',{skip:!process.env.ONIONSOUP_NODE_TASK_CHECKOUT},async t=>{
 const root=await mkdtemp(join(tmpdir(),'onionsoup-node-profile-real-'));t.after(()=>rm(root,{recursive:true,force:true}));const checkout=process.env.ONIONSOUP_NODE_TASK_CHECKOUT!,dir=join(root,'proposal');
 const runtime=Runtime.parse(await json(process.env.ONIONSOUP_FIXTURE_RUNTIME!)),dependencies=NodeDependency.parse(await json(process.env.ONIONSOUP_PROJECT_DEPENDENCIES!));
 await proposeProject(checkout,task.baseCommit,dir,{repositoryProfile:profile,task,models:prepareModel});const job=await acceptProject(checkout,dir,mapping,'Scripted sandbox qualification.',{runtime,dependencies,verificationPlan:plan});
 const r=await verifyProject(checkout,task.baseCommit,job,runtime,dependencies,[],{directory:join(root,'baseline'),phase:'baseline',verificationPlan:plan});
 assert.equal(r.status,'checks_failed');for(const id of ['node-typecheck','node-tests','task-existing-schedule'])assert.equal(r.checks.find(c=>c.id===id)?.status,'passed',id);
 for(const id of ['task-preview-basic','task-preview-dst','task-preview-validation'])assert.equal(r.checks.find(c=>c.id===id)?.status,'failed',id);assert.equal(r.cleanup,'removed');
});
