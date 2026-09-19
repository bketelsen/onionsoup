import {workflowEvents} from '../src/workflow-events.ts';
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {join} from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture,runtime,model} from './helpers/owned-fixture.ts';
import {fixtureModel} from '../src/fixture-model.ts';
import {runFixture} from '../src/fixture-runner/recipe.ts';
import {git} from '../src/fixture-runner/fixture.ts';
import {preparePublication,validateCommit} from '../src/publication/bundle.ts';
import {PublicationConfig,validateBundle} from '../src/publication/contracts.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {atomicJson,readJson} from '../src/batch-store.ts';
import {proposeProject,acceptProject,validateParent} from '../src/project-change/proposal.ts';
import {validateJob,validateResult,CheckId,Verification,Dependency,paths,type Job} from '../src/project-change/contracts.ts';
import {executeProject} from '../src/project-change/recipe.ts';
import {verifyProject} from '../src/project-change/sandbox.ts';
import {profileHash,seedsFrom,evaluateObservations} from '../src/project-change/profile.ts';
import {validateProject,projectInput} from '../src/project-change/record.ts';
import {prepareProjectPublication} from '../src/project-change/publication.ts';
import {snapshot,treeDigest} from '../src/project-change/source.ts';
const claim=(text:string,refs=['issue:body'])=>({text,basis:'proposed',evidenceIds:refs});
const requirements={schemaVersion:1,status:'sufficient_for_proposal',userNeed:claim('Filter history.'),scenarios:[claim('Select status.')],constraints:[],nonGoals:[],questions:[]};
const proposal={schemaVersion:1,status:'proposal_ready',outcome:claim('Filter publication history.'),changes:[claim('Add a bounded view.', ['source:1'])],nonGoals:[],
 acceptanceCriteria:[{id:'AC1',criterion:claim('Correct queries and selection.')},{id:'AC2',criterion:claim('Controls preserve compatible views and coverage.')},{id:'AC3',criterion:claim('Document the query.')}],
 verification:[{criterionIds:['AC1','AC3'],kind:'acceptance',check:claim('HTTP and docs checks.'),baselineExpectation:'capability_absent'},
 {criterionIds:['AC2'],kind:'compatibility',check:claim('Keep existing views.'),baselineExpectation:'existing_behavior'}],compatibility:claim('Keep authority.'),migration:claim('None.'),documentation:claim('Describe filter.'),questions:[],risks:[claim('Finite evidence.')]};
const mapping:Job['mapping']=[{criterionId:'AC1',checks:['default-history','status-filter','invalid-filter','typecheck']},{criterionId:'AC2',checks:['filter-controls','coverage-preserved','detail-unchanged','adjacent-console']},{criterionId:'AC3',checks:['documentation']}];
async function setup(t:TestContext) {
 const f=await fixture(t),w=await runFixture('bug',f.options),fc=PublicationConfig.parse({schemaVersion:1,stateDirectory:join(f.root,'fixture-publications'),targets:[{repository:'bketelsen/onionsoup-fixtures',repositoryId:42,baseBranch:'main',baseCommit:w.scope!.baseCommit}]});
 const seed=await preparePublication(fc,f.options.directory,fc.targets[0]),dir=join(f.root,'proposal'),base=(await git(process.cwd(),['rev-parse','HEAD'])).trim();
 const parent=await proposeProject(process.cwd(),base,dir,'copilot',{modelFactory:async()=>({provider:'copilot',modelId:'gpt-5.6-terra',model:model(input=>'changeKind' in input?proposal:requirements)})});
 assert.equal(parent.status,'completed');const job=await acceptProject(process.cwd(),dir,mapping,'Scripted accepted proposal for software tests.');
 const deps=Dependency.parse({schemaVersion:1,directory:'/fixture/dependencies',packageHash:job.packageHash,lockHash:job.lockHash,treeHash:'a'.repeat(64),nodeHash:runtime.nodeHash,npmHash:'b'.repeat(64),npmVersion:'fixture',scripts:'disabled',registry:'https://registry.npmjs.org/',createdAt:new Date().toISOString()});
 let calls=0;
 const modelFactory=async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(()=>calls++===0?{schemaVersion:2,status:'candidate',summary:'Scripted edit, not quality evidence.',questions:[],edits:[{path:paths[0],beforeHash:hash(job.files[paths[0]]),content:job.files[paths[0]]+'\n// Scripted profile candidate.\n'}]}:{schemaVersion:2,verdict:'no_blocking_findings',findings:[],limitations:['Scripted boundary test; not a real filtering implementation.'] })});
 const verify:typeof verifyProject=async(checkout,commit,j,rt,d,seeds,o)=>{
  const at=new Date().toISOString();await o.checkpoint?.({phase:o.phase});
  return Verification.parse({schemaVersion:1,receiptId:randomUUID(),phase:o.phase,jobHash:hash(j),tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),runtimeHash:hash(rt),dependencyHash:hash(d),profileHash:j.profileHash,seedHash:hash(seeds),startedAt:at,finishedAt:at,status:o.phase==='candidate'?'passed':'checks_failed',checks:CheckId.options.map(id=>({id,status:o.phase==='baseline'&&['status-filter','filter-controls','invalid-filter','documentation'].includes(id)?'failed':'passed'})),exitCode:0,cleanup:'removed',commandHash:'c'.repeat(64),outputHash:'d'.repeat(64),containerName:'onionsoup-project-'+randomUUID()});
 };
 const options={directory:join(f.root,'project'),runtime,dependencies:deps,seedBundle:seed,provider:'copilot' as const,modelFactory,verify};
 return {...f,dir,parent,job,seed,options,calls:()=>calls};
}
test('acceptance binds a real proposal and all criteria; models receive compact results rather than conversations',async t=>{
 const f=await setup(t);assert.equal(validateParent(f.parent).proposal!.agent,'change-proposal');assert.ok(!JSON.stringify({proposal:f.job.proposal,requirements:f.job.requirements}).includes('messages'));
 assert.throws(()=>validateJob({...f.job,mapping:[]}));assert.throws(()=>validateJob({...f.job,proposalHash:'0'.repeat(64)}));
 await assert.rejects(acceptProject(process.cwd(),f.dir,mapping,'Cannot replace existing acceptance.'));
 const bad=structuredClone(f.parent);(bad.proposal!.input as any).sources[0].quote='invented';assert.throws(()=>validateParent(bad));
});
test('shared project patch/review produces exact commits and version-2 publication without changing fixture compatibility',async t=>{
 const f=await setup(t),w=await executeProject(process.cwd(),f.dir,f.options);assert.equal(w.outcome,'candidate_verified');assert.equal(f.calls(),2);assert.equal(w.appliedTree,w.headTree);const trace=workflowEvents(w);assert.equal(trace.events.filter(e=>e.type==='verification.completed').length,2);assert.ok(!JSON.stringify(trace).includes('task_evidence'));
 const c=PublicationConfig.parse({schemaVersion:1,stateDirectory:join(f.root,'project-publications'),targets:[{repository:'bketelsen/onionsoup',repositoryId:12,baseBranch:'main',baseCommit:w.job.baseCommit}]});
 const b=await prepareProjectPublication(c,f.options.directory,c.targets[0]);assert.equal(b.schemaVersion,2);assert.equal(b.headCommit,w.headCommit);await validateCommit(c,b);assert.equal(validateBundle(f.seed).schemaVersion,1);
 const changed=structuredClone(w);changed.candidate!.tree='a'.repeat(40);assert.throws(()=>validateProject(changed));
 const input=projectInput(w,'scoped-patch');assert.throws(()=>validateResult('scoped-patch',{schemaVersion:2,status:'candidate',summary:'escape',edits:[{path:'package.json',beforeHash:'a'.repeat(64),content:'{}'}],questions:[]},input));
});
test('failed setup, candidate checks and persistence prevent later agents and publication',async t=>{
 for(const phase of ['baseline','candidate','reservation']){
  const f=await setup(t);
  const opts={...f.options,verify:async(...args:Parameters<typeof verifyProject>)=>{const r=await f.options.verify(...args);return args[6].phase===phase?{...r,status:'execution_error' as const,checks:[]}:r;},
   persist:async(file:string,raw:any)=>{if(phase==='reservation'&&raw.stages.length===1)throw new Error('disk');await atomicJson(file,raw);}};
  if(phase==='reservation'){await assert.rejects(executeProject(process.cwd(),f.dir,opts));assert.equal(f.calls(),0);}
  else {const w=await executeProject(process.cwd(),f.dir,opts);assert.notEqual(w.outcome,'candidate_verified');assert.equal(f.calls(),phase==='baseline'?0:1);}
 }
});
test('dependency digest rejects escaping symlinks and snapshot excludes Git metadata',async t=>{
 const f=await setup(t),dir=join(f.root,'export');await snapshot(process.cwd(),f.job.baseCommit,dir);await assert.rejects(readFile(join(dir,'.git/config')));
 const {symlink}=await import('node:fs/promises');const d=join(f.root,'dep');await mkdir(d);await writeFile(join(d,'x'),'pinned');const before=await treeDigest(d);await writeFile(join(d,'x'),'changed');assert.notEqual(await treeDigest(d),before);await symlink('/etc/passwd',join(d,'escape'));await assert.rejects(treeDigest(d));
});
test('real project sandbox baseline preserves compatibility and reports missing filtering', {skip:!process.env.ONIONSOUP_PROJECT_DEPENDENCIES},async t=>{
 const f=await setup(t),rt=await readJson(process.env.ONIONSOUP_FIXTURE_RUNTIME!),deps=Dependency.parse(await readJson(process.env.ONIONSOUP_PROJECT_DEPENDENCIES!));
 const r=await verifyProject(process.cwd(),f.job.baseCommit,f.job,rt as any,deps,seedsFrom(f.seed),{directory:join(f.root,'real'),phase:'baseline'});
 assert.equal(r.status,'checks_failed');for(const id of ['default-history','coverage-preserved','detail-unchanged','typecheck','adjacent-console'])assert.equal(r.checks.find(c=>c.id===id)?.status,'passed',id);
 assert.equal(r.checks.find(c=>c.id==='status-filter')?.status,'failed');assert.equal(r.cleanup,'removed');
});
