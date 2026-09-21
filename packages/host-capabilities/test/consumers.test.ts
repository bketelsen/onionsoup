import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { openJobHost, listenJobHost, tokenHash, digest } from '@onionsoup/job-host';
import { createJobClient } from '@onionsoup/job-host/client';
import { createHomelabChatProfile } from '@onionsoup/homelab-chat';
import { openChatSession, chatTurn, closeChatSession } from '@onionsoup/chat';
import { digest as targetDigest } from '@onionsoup/kubernetes-source/workloads';
import { ContainerTarget } from '@onionsoup/container-source';
import { createRepositoryBrief } from '@onionsoup/repository-brief';
import { tick } from '@onionsoup/brief-delivery/runtime';
import { remoteBriefGenerator } from '@onionsoup/brief-delivery/remote';
import { registeredCapabilities } from '../src/index.ts';
import { homelabJobCaller } from '../src/consumers.ts';
const target=ContainerTarget.parse({schemaVersion:1,assetId:'containers',host:'example.invalid',user:'operator',engines:['docker']});
function model(actions:()=>{tool:string;args:unknown}){return new MockLanguageModelV3({doStream:async()=>{const a=actions();return {stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[{type:'stream-start',warnings:[]},{type:'tool-call',toolCallId:randomUUID(),toolName:a.tool,input:JSON.stringify(a.args)},
  {type:'finish',finishReason:{unified:'tool-calls',raw:'tool-calls'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}}]})};}});}
test('chat and scheduled delivery consume one shared HTTP host with separate grants and retained domain results',async t=>{
  const root=await mkdtemp(join(tmpdir(),'shared-consumers-'));let refreshes=0,generations=0,sends=0;
  const capabilities=registeredCapabilities({schemaVersion:1,provider:'copilot',repositories:['example/widget'],homelab:{schemaVersion:1,provider:'copilot',runsDirectory:'unused',observations:[],targets:[],refreshSources:[{sourceId:'containers',kind:'containers',target}]}},{
    refresh:async()=>{refreshes++;const at=new Date().toISOString();return {schemaVersion:1,kind:'container-inventory',runId:randomUUID(),assetId:target.assetId,targetHash:targetDigest(target),commandVersion:'ssh-container-states-v1',readOnlyCommands:true,startedAt:at,finishedAt:at,status:'partial',queries:[{engine:'docker',scope:'local-default-docker-socket',commandHash:'a'.repeat(64),status:'unavailable',failure:'cli_unavailable'}]};},
    repositoryBrief:async(input,options)=>{generations++;return createRepositoryBrief(input,{...options,reader:async endpoint=>endpoint==='repos/example/widget'?{full_name:'example/widget',default_branch:'main'}:endpoint.includes('/actions/runs')?{total_count:0,workflow_runs:[]}:{total_count:0,incomplete_results:false,items:[]},modelFactory:async()=>({provider:'copilot',modelId:'gpt-5.6-terra',model:model(()=>({tool:'submit_result',args:{schemaVersion:1,observations:[],limitations:['No activity.']}}))})});},
  });
  const token='a'.repeat(40),scheduledToken='b'.repeat(40),host=await openJobHost({directory:join(root,'host'),binding:{fixture:1},capabilities,invokers:[{id:'chat',tokenHash:tokenHash(token),capabilities:['homelab.investigate','homelab.refresh','homelab.brief'],maxJobs:5},{id:'schedule',tokenHash:tokenHash(scheduledToken),capabilities:['repository.brief'],maxJobs:5}]});
  const server=await listenJobHost(host),client=createJobClient({url:server.url,token}),scheduled=createJobClient({url:server.url,token:scheduledToken});
  const profile=createHomelabChatProfile({bindingHash:'a'.repeat(64),call:homelabJobCaller(client),pollMs:1}),session=await openChatSession({directory:join(root,'chat'),profile,provider:'copilot',modelId:'gpt-5.6-terra'});
  t.after(async()=>{await closeChatSession(session);await server.close();await rm(root,{recursive:true,force:true});});let step=0;
  const turn=await chatTurn(session,'Refresh containers and summarize coverage.',{modelFactory:async()=>model(()=>{
    if(step++===0)return {tool:'discover_homelab',args:{}};
    if(step===2)return {tool:'refresh_sources',args:{sourceIds:['containers']}};
    const jobId=(session.session.memory as any).jobs[0].id;return {tool:'submit_answer',args:{kind:'answer',text:'Docker coverage is unavailable.',basis:'current',references:[{id:jobId}]}};
  })});
  assert.equal(turn.status,'completed');assert.equal(refreshes,1);assert.equal((turn.evidence as any).evidence[0].sourceStatus,'partial');
  const config={schemaVersion:1,jobId:'test-schedule',repository:'example/widget',provider:'copilot',days:1,maxSuggestions:0,schedule:{timeZone:'America/New_York',time:'08:00',weekdays:[0,1,2,3,4,5,6],catchUpHours:2},from:'brief@example.invalid',to:'owner@example.invalid',smtp:{host:'127.0.0.1',port:2525,security:'loopback'}};
  const options={stateDirectory:join(root,'delivery'),now:new Date('2026-09-21T12:05:00Z'),generate:remoteBriefGenerator(scheduled),sender:async()=>{sends++;return 'accepted' as const;}};
  const first=await tick(config,options),second=await tick(config,options);assert.deepEqual(second,first);assert.equal(first.status,'accepted');assert.equal(generations,1);assert.equal(sends,1);
  const receipt=JSON.parse(await readFile(join((first as any).directory,'analysis','host-job.json'),'utf8'));const j=await scheduled.inspect(receipt.jobId);assert.equal(j.capability,'repository.brief');assert.equal(j.status,'completed');
  await assert.rejects(client.inspect(receipt.jobId));await assert.rejects(client.submit({capability:'repository.brief',input:{},idempotencyKey:'not-allowed'}));
  assert.equal((await client.discover()).remainingAdmissions,4);assert.equal((await scheduled.discover()).remainingAdmissions,4);
});
