import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {model} from './helpers/owned-fixture.ts';
import {git} from '../src/fixture-runner/fixture.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {proposeProject,acceptProject,validateParent} from '../src/project-change/proposal.ts';
import {executeProject} from '../src/project-change/recipe.ts';
import {validateProject,projectInput} from '../src/project-change/record.ts';
import {GoRuntime,GoDependency,Verification,validateJob,validateResult,type Job} from '../src/project-change/contracts.ts';
import {GO_PROFILE,projectProfile} from '../src/project-change/profiles.ts';
import {snapshot,treeDigest} from '../src/project-change/source.ts';
import {evaluateGoOutput,goDocumentationSatisfied} from '../src/project-change/go-profile.ts';
import {validateGoManifests} from '../src/project-change/go-dependencies.ts';
import {verifyGoProject} from '../src/project-change/go-sandbox.ts';
import {prepareProjectPublication} from '../src/project-change/publication.ts';
import {validateCommit} from '../src/publication/bundle.ts';
import {workflowEvents} from '../src/workflow-events.ts';
const claim=(text:string)=>({text,basis:'proposed',evidenceIds:['issue:body']});
const requirements={schemaVersion:1,status:'sufficient_for_proposal',userNeed:claim('Configure fill.'),scenarios:[claim('Choose color.')],constraints:[],nonGoals:[],questions:[]};
const proposal={schemaVersion:1,status:'proposal_ready',outcome:claim('Configure fill.'),changes:[{...claim('Add option.'),evidenceIds:['source:1']}],nonGoals:[],acceptanceCriteria:[{id:'AC1',criterion:claim('Keep existing behavior.')},{id:'AC2',criterion:claim('Support colors and document them.')}],verification:[{criterionIds:['AC1'],kind:'compatibility',check:claim('Original tests.'),baselineExpectation:'existing_behavior'},{criterionIds:['AC2'],kind:'acceptance',check:claim('Color tests and docs.'),baselineExpectation:'capability_absent'}],compatibility:claim('Keep defaults.'),migration:claim('None.'),documentation:claim('Document.'),questions:[],risks:[claim('Finite tests.') ]};
const mapping:Job['mapping']=[{criterionId:'AC1',checks:['go-build','go-test','go-vet','gofmt','bubble-default']},{criterionId:'AC2',checks:['bubble-colors','bubble-invalid','documentation']}];
const prepareModel=async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(i=>'changeKind'in i?proposal:requirements)});
const runtime=GoRuntime.parse({schemaVersion:2,imageId:'sha256:'+'a'.repeat(64),goDirectory:'/fixture/go',goHash:'b'.repeat(64),goVersion:'go version go1.26.7 linux/amd64',podmanVersion:'fixture'});
async function setup(t:any){
 const root=await mkdtemp(join(tmpdir(),'onionsoup-go-'));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo');await mkdir(repo);
 await writeFile(join(repo,'main.go'),'package main\n\nfunc main() {}\n');await writeFile(join(repo,'README.md'),'# Go fixture\n');
 await writeFile(join(repo,'go.mod'),'module github.com/bketelsen/clippy\n\ngo 1.21\n');await writeFile(join(repo,'go.sum'),'');
 await mkdir(join(repo,'assets'));await writeFile(join(repo,'assets','image.bin'),Buffer.from([0,255,254,100]));
 await git(repo,['init','-q']);await git(repo,['remote','add','origin','https://github.com/bketelsen/clippy.git']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Base']);
 const base=(await git(repo,['rev-parse','HEAD'])).trim(),dir=join(root,'proposal');await proposeProject(repo,base,dir,'copilot',{profile:GO_PROFILE,modelFactory:prepareModel});
 const job=await acceptProject(repo,dir,mapping,'Scripted software test under fixture authority.');
 const deps=GoDependency.parse({schemaVersion:2,directory:'/fixture/modules',packageHash:job.packageHash,lockHash:job.lockHash,treeHash:'c'.repeat(64),goHash:runtime.goHash,goVersion:runtime.goVersion,registry:'https://proxy.golang.org',checksumDatabase:'sum.golang.org',createdAt:new Date().toISOString()});
 return {root,repo,dir,base,job,deps};
}
test('Go uses the same proposal, patch, review, publication and event functions with profile-specific authority',async t=>{
 const f=await setup(t);let calls=0;
 const w=await executeProject(f.repo,f.dir,{directory:join(f.root,'run'),runtime,dependencies:f.deps,provider:'copilot',modelFactory:async()=>({provider:'copilot',modelId:'gpt-5.6-terra',model:model(()=>calls++===0?{schemaVersion:2,status:'candidate',summary:'Scripted plumbing test.',edits:[{path:'main.go',beforeHash:hash(f.job.files['main.go']),content:f.job.files['main.go']+'// Fixture change.\n'}],questions:[]}:{schemaVersion:2,verdict:'no_blocking_findings',findings:[],limitations:['Scripted; no quality claim.']})}),
 verify:async(checkout,commit,j,rt,d,seeds,o)=>{const at=new Date().toISOString();await o.checkpoint?.({phase:o.phase});return Verification.parse({schemaVersion:1,receiptId:randomUUID(),phase:o.phase,jobHash:hash(j),tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),runtimeHash:hash(rt),dependencyHash:hash(d),profileHash:j.profileHash,seedHash:hash(seeds),startedAt:at,finishedAt:at,status:o.phase==='baseline'?'checks_failed':'passed',checks:projectProfile(GO_PROFILE).checks.map(id=>({id,status:o.phase==='baseline'&&['bubble-colors','documentation'].includes(id)?'failed':'passed'})),exitCode:0,cleanup:'removed',commandHash:'d'.repeat(64),outputHash:'e'.repeat(64),containerName:'onionsoup-project-'+randomUUID()});}});
 assert.equal(w.outcome,'candidate_verified');assert.equal(calls,2);assert.equal(w.appliedTree,w.headTree);assert.equal(workflowEvents(w).events.filter(e=>e.type==='verification.completed').length,2);
 const config={schemaVersion:1 as const,stateDirectory:join(f.root,'publications'),targets:[{repository:'bketelsen/clippy',repositoryId:172236427,baseBranch:'master',baseCommit:f.base}]};
 const bundle=await prepareProjectPublication(config,join(f.root,'run'),config.targets[0]);await validateCommit(config,bundle);assert.equal(bundle.headCommit,w.headCommit);
 assert.throws(()=>validateJob({...f.job,repository:'bketelsen/onionsoup'}));assert.throws(()=>validateJob({...f.job,allowedFiles:['main.go','go.mod']}));
 assert.throws(()=>validateJob({...f.job,mapping:[{criterionId:'AC1',checks:['typecheck']},mapping[1]]}));
 assert.throws(()=>validateResult('scoped-patch',{schemaVersion:2,status:'candidate',summary:'Wrong profile file.',edits:[{path:'src/console/server.ts',beforeHash:'a'.repeat(64),content:'wrong'}],questions:[]},projectInput(w,'scoped-patch')));
 assert.throws(()=>validateProject({...w,runtime:{schemaVersion:1,imageId:runtime.imageId,nodePath:'/node',nodeHash:'a'.repeat(64),podmanVersion:'fixture'}}));
 const bad=structuredClone(w);bad.candidate!.checks[0].id='typecheck';assert.throws(()=>validateProject(bad));
 assert.throws(()=>validateParent({...w.parent,repository:'bketelsen/onionsoup'}));
});
test('binary source export preserves bytes and refuses text-only or symlink escapes',async t=>{
 const f=await setup(t);await assert.rejects(snapshot(f.repo,f.base,join(f.root,'text')));
 const out=join(f.root,'binary');await snapshot(f.repo,f.base,out,true);assert.deepEqual(await readFile(join(out,'assets/image.bin')),Buffer.from([0,255,254,100]));await assert.rejects(readFile(join(out,'.git/config')));
 const {symlink}=await import('node:fs/promises');await symlink('/etc/passwd',join(f.repo,'escape'));await git(f.repo,['add','escape']);const tree=(await git(f.repo,['write-tree'])).trim();await assert.rejects(snapshot(f.repo,tree,join(f.root,'escaping'),true));
});
test('Go observations need exact check coverage; incomplete/duplicated markers and missing docs fail',()=>{
 const ids=projectProfile(GO_PROFILE).checks.filter(c=>c!=='documentation'),nonce=randomUUID(),output=ids.map(id=>`${nonce}:${id}:0`).join('\n');
 const docs='-bubble-color #RRGGBB or #RRGGBBAA. Default #FFFFBE; optional # prefix.';
 assert.ok(evaluateGoOutput(output,nonce,docs).every(c=>c.status==='passed'));
 assert.equal(goDocumentationSatisfied('`-bubble-color` accepts RGB (`RRGGBB`) or RGBA (`RRGGBBAA`); the leading `#` is optional. The default is `#FFFFBE`.'),true);
 for(const token of ['-bubble-color','RRGGBBAA','FFFFBE','optional'])assert.equal(goDocumentationSatisfied(docs.replace(token,'')),false);
 assert.throws(()=>evaluateGoOutput(output.split('\n').slice(1).join('\n'),nonce,docs));assert.throws(()=>evaluateGoOutput(output+'\n'+output.split('\n')[0],nonce,docs));
 assert.equal(evaluateGoOutput(output.replace(':go-test:0',':go-test:1'),nonce,docs).find(c=>c.id==='go-test')!.status,'failed');assert.equal(goDocumentationSatisfied('-bubble-color red'),false);
});
test('Go provisioning rejects replacement paths and modules without public checksums',()=>{
 const mod='module github.com/bketelsen/clippy\n\ngo 1.21\n',sum='github.com/fogleman/gg v1.3.0 h1:'+ 'a'.repeat(43)+'=\ngithub.com/fogleman/gg v1.3.0/go.mod h1:'+'b'.repeat(43)+'=\n';
 assert.equal(validateGoManifests(mod,sum).size,2);assert.throws(()=>validateGoManifests(mod+'replace example.com/private => /home/private\n',sum));assert.throws(()=>validateGoManifests(mod,sum.replace('h1:','sha256:')));assert.throws(()=>validateGoManifests(mod,sum+sum));
});
test('real Go profile preserves original tests and reports absent colors with unchanged embedded assets',{skip:!process.env.ONIONSOUP_GO_CHECKOUT},async t=>{
 const root=await mkdtemp(join(tmpdir(),'onionsoup-go-real-'));t.after(()=>rm(root,{recursive:true,force:true}));const checkout=process.env.ONIONSOUP_GO_CHECKOUT!,base=(await git(checkout,['rev-parse','HEAD'])).trim(),dir=join(root,'proposal');
 await proposeProject(checkout,base,dir,'copilot',{profile:GO_PROFILE,modelFactory:prepareModel});const job=await acceptProject(checkout,dir,mapping,'Explicit software integration preflight.');
 const rt=GoRuntime.parse(JSON.parse(await readFile(process.env.ONIONSOUP_GO_RUNTIME!,'utf8'))),deps=GoDependency.parse(JSON.parse(await readFile(process.env.ONIONSOUP_GO_DEPENDENCIES!,'utf8')));
 const r=await verifyGoProject(checkout,base,job,rt,deps,[],{directory:join(root,'baseline'),phase:'baseline'});
 assert.equal(r.status,'checks_failed');for(const id of projectProfile(GO_PROFILE).baseline)assert.equal(r.checks.find(c=>c.id===id)?.status,'passed',id);
 assert.equal(r.checks.find(c=>c.id==='bubble-colors')?.status,'failed');assert.equal(r.cleanup,'removed');
});
