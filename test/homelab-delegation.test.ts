import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { proveHomelabDelegation, type McpCall } from '../scripts/lib/homelab-delegation.ts';
const investigation=randomUUID(),brief=randomUUID();
function model(actions:{tool:string;args:unknown}[]){let step=0;return new MockLanguageModelV3({doStream:async()=>{
  const action=actions[Math.min(step++,actions.length-1)];return {stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[{type:'stream-start',warnings:[]},
    {type:'tool-call',toolCallId:String(step),toolName:action.tool,input:JSON.stringify(action.args)},
    {type:'finish',finishReason:{unified:'tool-calls',raw:'tool-calls'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:5,text:5,reasoning:0}}}]})};}});}
const actions=[{tool:'discover_homelab',args:{}},{tool:'investigate_workload_findings',args:{targetId:'cluster'}},
  {tool:'create_homelab_brief',args:{investigationJobId:investigation}},
  {tool:'submit_answer',args:{summary:'The sampled workload findings require review; source coverage is limited.',investigationJobId:investigation,briefJobId:brief}}];
const fake:McpCall=async(name,args)=>({structuredContent:name==='discover_homelab'?{schemaVersion:1,targets:['cluster'],savedSources:0,limits:{maxJobs:2},effects:{serviceWrites:false},capability:{large:'omitted'}}:
  name==='investigate_workload_findings'||name==='create_homelab_brief'?{schemaVersion:1,jobId:name==='investigate_workload_findings'?investigation:brief,status:'admitted'}:
  {schemaVersion:1,jobId:args.jobId,status:'settled',runId:randomUUID(),...(args.jobId===investigation?{resultStatus:'completed',findings:[],eligible:0,omitted:0}:{markdown:'# Homelab brief\nIncomplete coverage.'})}});
test('model-selected delegation checkpoints effects and binds the answer to its completed child jobs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-chat-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'run'),calls:string[]=[];
  const result=await proveHomelabDelegation({directory,provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>model(actions),pollMs:0,call:async(name,args,signal)=>{
    const saved=JSON.parse(await readFile(join(directory,'delegation.json'),'utf8'));
    if(['investigate_workload_findings','create_homelab_brief'].includes(name))assert.ok(saved.events.some((e:any)=>e.tool===name&&e.stage==='intent'));
    calls.push(name);return fake(name,args,signal);
  }});
  assert.equal(result.status,'completed');assert.equal(result.steps,4);assert.equal(result.toolCalls,3);assert.deepEqual(result.tokenUsage,{input:40,output:20});
  assert.equal(result.answer?.briefJobId,brief);assert.deepEqual(result.answer?.findingCounts,{attentionNow:0,historical:0,insufficientEvidence:0,selected:0});assert.equal(calls.filter(n=>n==='investigate_workload_findings').length,1);
  assert.equal(result.events.filter(e=>e.stage==='admitted').length,2);assert.ok(!JSON.stringify(result).includes('large'));
});
test('unknown targets, foreign jobs, paths and repeated investigation cannot acquire authority or fake success',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-chat-'));t.after(()=>rm(root,{recursive:true,force:true}));let n=0;
  for(const sequence of [[actions[0],{tool:'investigate_workload_findings',args:{targetId:'foreign'}}],
    [actions[0],{tool:'investigate_workload_findings',args:{targetId:'cluster',command:'delete'}}],
    [{tool:'inspect_homelab_job',args:{jobId:randomUUID()}}],
    [actions[0],actions[1],actions[1]],
    [{tool:'submit_answer',args:{summary:'invented',investigationJobId:investigation,briefJobId:brief}}]]){
    let admissions=0;const result=await proveHomelabDelegation({directory:join(root,String(n++)),provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>model(sequence),pollMs:0,
      call:async(name,args,signal)=>{if(name==='investigate_workload_findings')admissions++;return fake(name,args,signal);}});
    assert.equal(result.status,'failed');assert.equal(result.answer,undefined);assert.ok(result.steps<=8);assert.equal(admissions,sequence.length===3?1:0);
  }
});
test('mismatched inspection identity, cancellation and persistence failure stop delegation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-chat-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const mismatch=await proveHomelabDelegation({directory:join(root,'mismatch'),provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>model(actions),pollMs:0,
    call:async(name,args,signal)=>name==='inspect_homelab_job'?{structuredContent:{schemaVersion:1,jobId:randomUUID(),status:'settled',resultStatus:'completed'}}:fake(name,args,signal)});
  assert.equal(mismatch.status,'failed');
  const controller=new AbortController();controller.abort();let calls=0;
  const cancelled=await proveHomelabDelegation({directory:join(root,'cancelled'),provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>{calls++;return model(actions);},call:fake,signal:controller.signal});
  assert.equal(cancelled.status,'failed');assert.equal(calls,0);
  const directory=join(root,'storage');
  await assert.rejects(proveHomelabDelegation({directory,provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>{
    await rename(join(directory,'delegation.json'),join(root,'admission.json'));await mkdir(join(directory,'delegation.json'));return model(actions);},call:async()=>{calls++;return {};}}),/PERSISTENCE_FAILED/);
  assert.equal(calls,0);
});


test('malformed brief fields are rejected locally and a corrected call can still use the reserved recipe',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-chat-'));t.after(()=>rm(root,{recursive:true,force:true}));let briefs=0;
  const sequence=[actions[0],actions[1],{tool:'create_homelab_brief',args:{investigationJobId:investigation,minItems:1,maxItems:1}},actions[2],actions[3]];
  const result=await proveHomelabDelegation({directory:join(root,'run'),provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>model(sequence),pollMs:0,
    call:async(name,args,signal)=>{if(name==='create_homelab_brief'){briefs++;assert.deepEqual(args,{investigationJobIds:[investigation]});}return fake(name,args,signal);}});
  assert.equal(result.status,'completed');assert.equal(briefs,1);assert.equal(result.steps,5);
  assert.ok(result.events.some(e=>e.stage==='rejected'&&(e.data as any).error==='INVALID_ARGUMENTS'));
  assert.ok(!JSON.stringify(result).includes('minItems'));
});

test('failed child terminates the parent without another model turn or another admission',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-chat-'));t.after(()=>rm(root,{recursive:true,force:true}));let admissions=0;
  const result=await proveHomelabDelegation({directory:join(root,'run'),provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>model(actions),pollMs:0,
    call:async(name,args,signal)=>{
      if(name==='investigate_workload_findings')admissions++;
      if(name==='inspect_homelab_job')return {structuredContent:{schemaVersion:1,jobId:investigation,status:'settled',runId:randomUUID(),resultStatus:'failed',failure:'no_valid_result'}};
      return fake(name,args,signal);
    }});
  assert.equal(result.status,'failed');assert.equal(result.failure,'child_investigation_failed');assert.equal(result.steps,2);assert.equal(admissions,1);
});
