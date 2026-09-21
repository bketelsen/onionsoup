import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
import { openJobHost, listenJobHost, tokenHash, type Capability, type JobHost } from '../src/index.ts';
import { createJobClient } from '../src/client.ts';
const token='a'.repeat(40),otherToken='b'.repeat(40);
const invokers=[{id:'chat',tokenHash:tokenHash(token),capabilities:['fixture.read'],maxJobs:4},{id:'schedule',tokenHash:tokenHash(otherToken),capabilities:['fixture.read'],maxJobs:4}];
function capability(execute:Capability['execute']):Capability{return {id:'fixture.read',version:'v1',description:'Read fixture',input:z.object({value:z.number().int()}).strict(),output:z.object({value:z.number().int()}).strict(),metadata:{},effects:['local_artifacts'],timeoutMs:10000,execute};}
const request=(key='first-key',value=1)=>({capability:'fixture.read',input:{value},idempotencyKey:key});
async function settled(host:JobHost,owner:string,id:string){for(let n=0;n<200;n++){const j=await host.inspect(owner,id);if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,5));}throw Error('Timeout');}
test('HTTP authentication, strict inputs, owner isolation and concurrent idempotency precede effects',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'job-host-'));let effects=0;
  const host=await openJobHost({directory,binding:{},invokers,capabilities:[capability(async input=>{effects++;return input;})]});
  const server=await listenJobHost(host);t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  const client=createJobClient({url:server.url,token}),other=createJobClient({url:server.url,token:otherToken});
  assert.equal((await fetch(server.url+'/v1/capabilities')).status,401);
  assert.equal((await fetch(server.url+'/v1/capabilities',{headers:{Authorization:`Bearer ${token}`,Origin:'https://example.invalid'}})).status,403);
  assert.equal((await client.discover()).remainingAdmissions,4);assert.equal(effects,0);
  await assert.rejects(client.submit({...request(),input:{value:1,command:'delete'}}));
  await assert.rejects(client.submit({...request(),capability:'fixture.write'}));assert.equal(effects,0);
  const [a,b]=await Promise.all([client.submit(request()),client.submit(request())]);assert.equal(a.jobId,b.jobId);assert.notEqual(a.reused,b.reused);
  const done=await settled(host,'chat',a.jobId);assert.equal(done.status,'completed');assert.deepEqual(done.result,{value:1});assert.equal(effects,1);
  await assert.rejects(client.submit(request('first-key',2)));await assert.rejects(other.inspect(a.jobId));await assert.rejects(other.cancel(a.jobId));
  assert.equal((await client.discover()).remainingAdmissions,3);assert.deepEqual(done.events.map(e=>e.status),['queued','running','completed']);
  const ledger=await readFile(join(directory,'ledger.json'),'utf8');assert.ok(!ledger.includes(token));assert.ok(!ledger.includes(otherToken));
});
test('restart retains quotas and results, rejects changed bindings and never replays interrupted jobs',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'job-restart-'));let effects=0;
  const options={directory,binding:{profile:1},invokers:[{...invokers[0],maxJobs:1}],capabilities:[capability(async input=>{effects++;return input;})]};
  let host=await openJobHost(options);t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
  const admitted=await host.submit('chat',request());await settled(host,'chat',admitted.jobId);await host.close();
  await assert.rejects(openJobHost({...options,binding:{profile:2}}));host=await openJobHost(options);
  assert.equal((await host.submit('chat',request())).jobId,admitted.jobId);await assert.rejects(host.submit('chat',request('second-key')),/admission_limit/);assert.equal(effects,1);
  await host.close();const path=join(directory,'ledger.json'),ledger=JSON.parse(await readFile(path,'utf8'));
  ledger.jobs[0].status='running';ledger.jobs[0].events.pop();delete ledger.jobs[0].resultHash;await writeFile(path,JSON.stringify(ledger));
  host=await openJobHost(options);assert.equal((await host.inspect('chat',admitted.jobId)).status,'interrupted');assert.equal((await host.submit('chat',request())).reused,true);assert.equal(effects,1);
});
test('queued cancellation and cooperative running cancellation preserve spent admission',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'job-cancel-'));let started!:()=>void;const entered=new Promise<void>(r=>started=r);
  const host=await openJobHost({directory,binding:{},invokers,capabilities:[capability(async(_,ctx)=>{started();await new Promise<void>(r=>{if(ctx.signal.aborted)r();else ctx.signal.addEventListener('abort',()=>r(),{once:true});});ctx.signal.throwIfAborted();return {value:0};})]});
  t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
  const first=await host.submit('chat',request());await entered;const second=await host.submit('chat',request('second-key'));
  assert.equal((await host.cancel('chat',second.jobId)).status,'cancelled');await host.cancel('chat',first.jobId);
  assert.equal((await settled(host,'chat',first.jobId)).status,'cancelled');assert.equal(host.discover('chat').remainingAdmissions,2);
});
test('failed result persistence stops queued effects and rejects further admission',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'job-storage-'));let effects=0;
  const host=await openJobHost({directory,binding:{},invokers,capabilities:[capability(async input=>{effects++;return input;})],persist:async(path,value)=>{if(path.endsWith('result.json'))throw Error('private storage detail');await atomicJson(path,value);}});
  t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
  const j=await host.submit('chat',request());assert.equal((await settled(host,'chat',j.jobId)).status,'failed');await assert.rejects(host.submit('chat',request('second-key')),/host_unavailable/);assert.equal(effects,1);
  assert.ok(!(await readFile(join(directory,'ledger.json'),'utf8')).includes('private storage detail'));
});
test('invalid results fail; foreign parents and modified artifacts are rejected',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'job-validation-'));
  const host=await openJobHost({directory,binding:{},invokers,capabilities:[capability(async input=>input.value===0?{unexpected:true}:input)]});t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
  const bad=await host.submit('chat',request('bad-result',0));assert.equal((await settled(host,'chat',bad.jobId)).status,'failed');
  const good=await host.submit('chat',request('good-result'));await settled(host,'chat',good.jobId);
  await assert.rejects(host.submit('schedule',{...request(),parentJobId:good.jobId}),/job_not_found/);
  await writeFile(join(directory,good.jobId,'result.json'),JSON.stringify({value:2}));await assert.rejects(host.inspect('chat',good.jobId),/result_mismatch/);
});
