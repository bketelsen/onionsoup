import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {join} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fixture} from './helpers/owned-fixture.ts';
import {runFixture} from '../src/fixture-runner/recipe.ts';
import {git} from '../src/fixture-runner/fixture.ts';
import {PublicationConfig,validateBundle,type Bundle,type Pull} from '../src/publication/contracts.ts';
import {preparePublication,loadState,loadBundle,validateCommit,directory} from '../src/publication/bundle.ts';
import {approvePublication,publish} from '../src/publication/runtime.ts';
import {publicationEvents} from '../src/publication/events.ts';
import {type PublisherTransport,type Remote} from '../src/publication/github.ts';
import {atomicJson} from '../src/batch-store.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {ConsoleConfig} from '../src/console/config.ts';
import {Operator} from '../src/console/actions.ts';
import {consoleServer} from '../src/console/server.ts';
import {PublicationOperator} from '../src/publication/console.ts';
function transport(b:Bundle) {
  const view:Remote={repositoryId:b.target.repositoryId,baseCommit:b.target.baseCommit,pulls:[]};let pushes=0,creates=0;
  const pr=():Pull=>({number:1,url:`https://github.com/${b.target.repository}/pull/1`,repositoryId:b.target.repositoryId,headRepositoryId:b.target.repositoryId,baseRepositoryId:b.target.repositoryId,
    head:b.branch,headCommit:b.headCommit,base:b.target.baseBranch,baseCommit:b.target.baseCommit,title:b.title,body:b.body,draft:true,state:'open',merged:false});
  const api:PublisherTransport={inspect:async()=>structuredClone(view),push:async()=>{pushes++;view.headCommit=b.headCommit;},create:async()=>{creates++;view.pulls=[pr()];return pr();}};
  return {view,api,pr,counts:()=>({pushes,creates})};
}
async function setup(t:TestContext,which:'bug'|'feature'='bug') {
  const f=await fixture(t),w=await runFixture(which,f.options),target={repository:'bketelsen/onionsoup-fixtures',repositoryId:42,baseBranch:which+'-base',baseCommit:w.scope!.baseCommit};
  const c=PublicationConfig.parse({schemaVersion:1,stateDirectory:join(f.root,'publications'),targets:[target]});
  const b=await preparePublication(c,f.options.directory,target),remote=transport(b);
  const approve=()=>approvePublication(c,b.publicationId,hash(b),{authority:'explicit_user_session',reason:'Authorized owned-fixture trial in test.'});
  return {...f,w,c,b,remote,approve,send:(deps={})=>publish(c,b.publicationId,hash(b),{transport:remote.api,...deps})};
}
test('bug and feature bundles preserve exact base, diff, commit and evidence; duplicate preparation reuses bundle',async t=>{
  for(const which of ['bug','feature'] as const) {
    const f=await setup(t,which);assert.equal(f.b.diff,f.w.diff);assert.equal(f.b.fixtureHash,hash(f.w));
    assert.match(f.b.body,/Human code acceptance: not recorded/);assert.match(f.b.body,new RegExp(`baseline \\*\\*${f.w.baseline!.status}`));
    assert.deepEqual(await preparePublication(f.c,f.options.directory,f.c.targets[0]),f.b);
    const repo=await validateCommit(f.c,f.b);assert.equal(await git(repo,['show',f.b.headCommit+':tasks.mjs']),f.w.after!['tasks.mjs']);
    await assert.rejects(f.send());assert.deepEqual(f.remote.counts(),{pushes:0,creates:0});
    await f.approve();assert.equal((await f.send()).status,'published');assert.equal((await f.send()).status,'published');
    assert.deepEqual(f.remote.counts(),{pushes:1,creates:1});
    const trace=publicationEvents(f.b,await loadState(f.c,f.b));assert.equal(trace.events.at(-1)!.type,'publication.published');
    assert.ok(!JSON.stringify(trace).includes('tasks.filter'));assert.ok(!JSON.stringify(trace).includes('Authorized owned'));
  }
});
test('denies third-party destination, stale bundle, changed configuration, unverified work and changed Git commits',async t=>{
  const f=await setup(t);assert.throws(()=>PublicationConfig.parse({...f.c,targets:[{...f.c.targets[0],repository:'get-bb/bb'}]}));
  await assert.rejects(approvePublication(f.c,f.b.publicationId,'0'.repeat(64),{authority:'console_operator',reason:'stale'}));
  await assert.rejects(approvePublication({...f.c,targets:[{...f.c.targets[0],repositoryId:99}]},f.b.publicationId,hash(f.b),{authority:'console_operator',reason:'changed'}));
  await atomicJson(join(f.options.directory,'fixture.json'),{...f.w,outcome:'review_blocked'});
  await assert.rejects(preparePublication(f.c,f.options.directory,f.c.targets[0]));
  const corrupted={...f.b,headCommit:'a'.repeat(40)};await assert.rejects(validateCommit(f.c,corrupted));
  assert.throws(()=>validateBundle({...f.b,diff:f.b.diff+'injected'}));
  assert.deepEqual(f.remote.counts(),{pushes:0,creates:0});
});
test('stale base, expired approval and conflicting branch prevent remote writes',async t=>{
  for(const mode of ['base','expiry','head']) {
    const f=await setup(t);await f.approve();
    if(mode==='base')f.remote.view.baseCommit='a'.repeat(40);
    if(mode==='head')f.remote.view.headCommit='b'.repeat(40);
    const s=await f.send(mode==='expiry'?{now:()=>new Date('2100-01-01T00:00:00Z')}:{});
    assert.equal(s.status,'blocked');assert.deepEqual(f.remote.counts(),{pushes:0,creates:0});
  }
});
test('lost push and PR responses reconcile to exactly the observed draft without replay',async t=>{
  const f=await setup(t);await f.approve();const push=f.remote.api.push,create=f.remote.api.create;
  f.remote.api.push=async(...a)=>{await push(...a);throw new Error('Lost response');};
  f.remote.api.create=async(...a)=>{await create(...a);throw new Error('Lost response');};
  assert.equal((await f.send()).status,'published');await f.send();assert.deepEqual(f.remote.counts(),{pushes:1,creates:1});
});
test('unobserved create stays unknown forever; late visible result can reconcile after approval expiry',async t=>{
  const f=await setup(t);await f.approve();let creates=0;
  f.remote.api.create=async()=>{creates++;throw new Error('Timeout before or after effect');};
  assert.equal((await f.send()).status,'unknown');assert.equal((await f.send()).status,'unknown');assert.equal(creates,1);
  f.remote.view.pulls=[f.remote.pr()];assert.equal((await f.send({now:()=>new Date('2100-01-01T00:00:00Z')})).status,'published');assert.equal(creates,1);
});
test('checkpoint failure before effects prevents writes; failure after create reconciles without replay',async t=>{
  for(const phase of ['push_intent','pr_intent','published']) {
    const f=await setup(t);await f.approve();
    await assert.rejects(f.send({persist:async(file:string,raw:any)=>{if(raw.status===phase)throw new Error('disk');await atomicJson(file,raw);}}));
    const counts=f.remote.counts();assert.equal(counts.creates,phase==='published'?1:0);assert.equal(counts.pushes,phase==='push_intent'?0:1);
    assert.equal((await f.send()).status,'published');assert.deepEqual(f.remote.counts(),{pushes:1,creates:1});
  }
});
test('closed, non-draft, changed body/head/repository and duplicate PRs block instead of replacing',async t=>{
  for(const mode of ['closed','draft','body','head','repo','duplicate']) {
    const f=await setup(t);await f.approve();await f.send();const p=f.remote.view.pulls[0];
    if(mode==='closed')p.state='closed';if(mode==='draft')p.draft=false;if(mode==='body')p.body+='changed';if(mode==='head')p.headCommit='a'.repeat(40);if(mode==='repo')p.headRepositoryId=43;
    if(mode==='duplicate')f.remote.view.pulls.push({...p,number:2});
    assert.equal((await f.send()).status,'blocked');assert.deepEqual(f.remote.counts(),{pushes:1,creates:1});
  }
});
test('base race after PR creation records conflict and preserves remote receipt',async t=>{
  const f=await setup(t);await f.approve();const create=f.remote.api.create;
  f.remote.api.create=async(...a)=>{const p=await create(...a);f.remote.view.baseCommit='a'.repeat(40);return p;};
  const s=await f.send();assert.equal(s.status,'blocked');assert.equal(s.pull?.number,1);await f.send();assert.equal(f.remote.counts().creates,1);
});
test('exclusive lock prevents concurrent consumers and a stale lock is never stolen',async t=>{
  const f=await setup(t);await f.approve();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),push=f.remote.api.push;
  f.remote.api.push=async(...a)=>{entered();await gate;await push(...a);};
  const pending=f.send();await ready;await assert.rejects(f.send());release();await pending;
  await mkdir(join(f.c.stateDirectory,'.publication.lock'));await assert.rejects(f.send());assert.equal(f.remote.counts().creates,1);
});
test('console binds approval to saved bundle, rejects forged inputs, publishes asynchronously and escapes content',async t=>{
  const f=await setup(t),file=join(f.root,'publication-config.json');await atomicJson(file,f.c);
  const c=ConsoleConfig.parse({schemaVersion:1,stateDirectory:join(f.root,'console'),publicationConfig:file,jobs:[{id:'fixture',deliveryConfig:'unused',deliveryState:'unused'}]});
  const publisher=new PublicationOperator(file,f.remote.api),server=consoleServer(new Operator(c),publisher);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`,page=await(await fetch(origin+'/publications/'+f.b.publicationId)).text();
  const csrf=page.match(/name="csrf" value="([a-f0-9]+)"/)![1];assert.match(page,/Exact draft PR body/);assert.match(page,/Approve this exact bundle/);
  assert.ok(!page.includes('<!-- onionsoup-publication:'));assert.match(page,/&lt;!-- onionsoup/);
  const post=(raw:Record<string,string>,headers={})=>fetch(origin+'/publication-actions',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({csrf,id:f.b.publicationId,bundleHash:hash(f.b),...raw})});
  for(const raw of [{action:'approve',repository:'get-bb/bb'},{action:'approve',bundleHash:'a'.repeat(64)},{action:'approve',csrf:'bad'},{action:'publish'}] as Record<string,string>[]) assert.equal((await post(raw)).status,409);
  assert.equal((await post({action:'approve'},{Origin:'https://evil.invalid'})).status,409);
  assert.equal((await post({action:'approve'})).status,303);assert.equal((await post({action:'publish'})).status,303);await publisher.idle();
  assert.equal((await loadState(f.c,f.b)).status,'published');assert.equal((await fetch(origin+'/publications/'+f.b.publicationId+'/events')).status,200);
  assert.deepEqual(f.remote.counts(),{pushes:1,creates:1});
});

test('approval expiring during push cannot authorize a subsequent PR creation',async t=>{
  const f=await setup(t);await f.approve();let now=new Date(),push=f.remote.api.push;
  f.remote.api.push=async(...args)=>{await push(...args);now=new Date('2100-01-01T00:00:00Z');};
  assert.equal((await f.send({now:()=>now})).status,'blocked');assert.deepEqual(f.remote.counts(),{pushes:1,creates:0});
});
