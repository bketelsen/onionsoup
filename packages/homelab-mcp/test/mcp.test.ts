import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { parseWorkloadProjection, type WorkloadTransport } from '@onionsoup/kubernetes-source/workloads';
import { createHomelabMcpServer } from '../src/index.ts';
const pod='11111111-1111-4111-8111-111111111111|private-ns|private-pod|2026-09-01T00:00:00Z||Job|22222222-2222-4222-8222-222222222222|Failed|False||main,0,false,,Error,1,2026-09-10T00:00:00Z,,,;\n';
const job='22222222-2222-4222-8222-222222222222|private-ns|private-job|2026-09-01T00:00:00Z||||True||0|1|1|\n';
const podId=parseWorkloadProjection('pods','v1\n'+pod).facts[0].id,ownerId=parseWorkloadProjection('jobs','v1\n'+job).facts[0].id;
const transport:WorkloadTransport=async(_,section)=>({code:0,stdout:'v1\n'+(section==='pods'?pod:section==='jobs'?job:'')});
const result={schemaVersion:1,findings:[{podId,classification:'historical',reason:'The owning Job is complete.',evidenceIds:[podId,ownerId],nextInvestigation:'none'}]};
const model=()=>new MockLanguageModelV3({doStream:async()=>({stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[{type:'stream-start',warnings:[]},{type:'tool-call',toolCallId:'1',toolName:'submit_result',input:JSON.stringify(result)},
  {type:'finish',finishReason:{unified:'tool-calls',raw:'tool-calls'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:5,text:5,reasoning:0}}}]})})});
async function setup(t:TestContext,overrides:{transport?:WorkloadTransport;maxJobs?:number}={}){
  const root=await mkdtemp(join(tmpdir(),'homelab-mcp-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const config={schemaVersion:1,provider:'copilot',runsDirectory:root,observations:[],targets:[{schemaVersion:1,assetId:'cluster',host:'example.invalid',user:'operator'}],maxJobs:overrides.maxJobs??4};
  const options={transport:overrides.transport??transport,modelFactory:async()=>{calls++;return model();}};
  const host=createHomelabMcpServer(config,options),client=new Client({name:'fixture-orchestrator',version:'1.0.0'});
  const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();await host.server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await host.shutdown();await client.close();});
  const call=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});return {error:r.isError,body:r.structuredContent as any};};
  return {root,config,options,host,client,call,calls:()=>calls};
}
async function finished(call:Awaited<ReturnType<typeof setup>>['call'],jobId:string){for(let n=0;n<200;n++){const r=await call('inspect_homelab_job',{jobId});if(r.body.status!=='running')return r.body;await new Promise(r=>setTimeout(r,5));}throw new Error('Timeout');}
test('MCP discovers without credentials, rejects client authority changes, runs shared recipe and composes Attention',async t=>{
  const f=await setup(t);assert.equal((await f.client.listTools()).tools.length,5);const discovery=(await f.call('discover_homelab')).body;
  assert.deepEqual(discovery.targets,['cluster']);assert.equal(f.calls(),0);assert.ok(!JSON.stringify(discovery).includes('example.invalid'));
  assert.equal((await f.call('investigate_workload_findings',{targetId:'unknown'})).body.error,'target_not_allowed');
  assert.equal((await f.call('investigate_workload_findings',{targetId:'cluster',command:'delete'})).error,true);
  const submitted=await f.call('investigate_workload_findings',{targetId:'cluster'});const final=await finished(f.call,submitted.body.jobId);
  assert.equal(final.resultStatus,'completed');assert.equal(final.findings[0].classification,'historical');assert.equal(f.calls(),1);
  assert.ok(!JSON.stringify(final).includes('private-pod'));assert.ok(!JSON.stringify(final).includes(f.root));
  const brief=await f.call('create_homelab_brief',{investigationJobIds:[submitted.body.jobId]});const rendered=await finished(f.call,brief.body.jobId);
  assert.match(rendered.markdown,/### Attention/);assert.match(rendered.markdown,/historical/);assert.equal(f.calls(),1);
  assert.equal((await f.call('create_homelab_brief',{observations:['/etc/passwd']})).error,true);
});
test('busy, lifetime budget and cancellation prevent hidden additional work',async t=>{
  let starts=0;const f=await setup(t,{maxJobs:1,transport:async(_t,_s,signal)=>{starts++;await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));return {code:null,stdout:'',failure:'cancelled'};}});
  const job=(await f.call('investigate_workload_findings',{targetId:'cluster'})).body.jobId;
  assert.equal((await f.call('investigate_workload_findings',{targetId:'cluster'})).body.error,'busy');
  // Allow the fixture transport to enter its cooperative wait before cancelling.
  for(let i=0;i<50&&!starts;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal((await f.call('cancel_homelab_job',{jobId:job})).body.status,'cancellation_requested');
  const end=await finished(f.call,job);assert.equal(end.resultStatus,'failed');assert.equal(end.failure,'cancelled_or_timed_out');assert.equal(starts,1);assert.equal(f.calls(),0);
  assert.equal((await f.call('investigate_workload_findings',{targetId:'cluster'})).body.error,'job_limit');
});
test('restart inspection does not replay and rejects changed configuration, provenance and symlink substitutions',async t=>{
  const f=await setup(t);const job=(await f.call('investigate_workload_findings',{targetId:'cluster'})).body.jobId;await finished(f.call,job);await f.host.shutdown();await f.client.close();
  const connect=async(config:unknown)=>{const h=createHomelabMcpServer(config,{modelFactory:async()=>{throw new Error('No model on inspect');}});const c=new Client({name:'restart',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await h.server.connect(a);await c.connect(b);t.after(async()=>{await h.shutdown();await c.close();});return async()=>c.callTool({name:'inspect_homelab_job',arguments:{jobId:job}});};
  const inspect=await connect(f.config);assert.equal(((await inspect()).structuredContent as any).resultStatus,'completed');
  const changed=await connect({...f.config,provider:'codex'});assert.equal((await changed()).isError,true);
  const path=join(f.root,job,'investigation/triage/triage.json'),original=await readFile(path,'utf8');
  await writeFile(path,JSON.stringify({...JSON.parse(original),inputHash:'0'.repeat(64)}));assert.equal((await inspect()).isError,true);
  await writeFile(path,original);const outside=join(f.root,'outside.json');await rename(path,outside);await symlink(outside,path);assert.equal((await inspect()).isError,true);
});
