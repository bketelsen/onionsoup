import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { triageWorkloads, validateTriageResult, classificationEvidence, TriageRun, workloadEvents } from '../src/index.ts';
import { fixture, cases, rid } from './fixtures.ts';
export function mock(result:unknown){return new MockLanguageModelV3({doStream:async()=>({stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[{type:'stream-start',warnings:[]},{type:'tool-call',toolCallId:'1',toolName:'submit_result',input:JSON.stringify(result)},
  {type:'finish',finishReason:{unified:'tool-calls',raw:'tool-calls'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:5,text:5,reasoning:0}}}]})})});}
const finding=(classification:string)=>({schemaVersion:1,findings:[{podId:rid(1),classification,reason:'Evidence supports this snapshot assessment.',evidenceIds:[rid(1),rid(2)],nextInvestigation:'observe_next_snapshot'}]});
test('classification gates distinguish recovery from age, missing access and active failure',()=>{
  const at=new Date();
  for(const [name,expected]of cases){const input=fixture(name,at),result=finding(expected);if(['missing-owner','incomplete'].includes(name))result.findings[0].evidenceIds=[rid(1)];assert.doesNotThrow(()=>validateTriageResult(result,input,at.toISOString()));
    if(expected!=='historical')assert.throws(()=>validateTriageResult(finding('historical'),input,at.toISOString()));}
  const old=fixture('replaced',at);const owner=old.facts[1];if(owner.kind==='ReplicaSet')owner.observedGeneration=1;
  assert.equal(classificationEvidence(old,rid(1),at.toISOString()).historical,false);
  const running=fixture('replaced',at);if(running.facts[0].kind==='Pod')running.facts[0].phase='Running';
  assert.equal(classificationEvidence(running,rid(1),at.toISOString()).historical,false);
  const wrongKind=fixture('replaced',at);wrongKind.facts[0].ownerKind='Other';assert.equal(classificationEvidence(wrongKind,rid(1),at.toISOString()).historical,false);
  const futureFact=fixture('completed-job',at);futureFact.facts[0].createdAt=new Date(at.getTime()+1000).toISOString();assert.equal(classificationEvidence(futureFact,rid(1),at.toISOString()).historical,false);
  const future=fixture('completed-job',new Date(at.getTime()+1000));assert.throws(()=>validateTriageResult(finding('historical'),future,at.toISOString()));
});
test('invented references, absent owner citations, duplicate/omitted findings and unsafe prose are rejected',()=>{
  const at=new Date(),input=fixture('completed-job',at);
  for(const result of [{schemaVersion:1,findings:[]},{schemaVersion:1,findings:[...finding('historical').findings,...finding('historical').findings]},
    {schemaVersion:1,findings:[{...finding('historical').findings[0],evidenceIds:[rid(1)]}]},
    {schemaVersion:1,findings:[{...finding('historical').findings[0],evidenceIds:[rid(1),rid(900)]}]},
    {schemaVersion:1,findings:[{...finding('historical').findings[0],reason:'<script>bad</script>'}]}])assert.throws(()=>validateTriageResult(result,input,at.toISOString()));
});
test('AgentLayer persists admission before model creation and records successful result, usage and events',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workload-agent-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'run');
  const result=await triageWorkloads(fixture('completed-job'),{directory,provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>{
    const saved=JSON.parse(await readFile(join(directory,'triage.json'),'utf8'));assert.equal(saved.status,'running');assert.equal(saved.modelInvoked,true);return mock(finding('historical'));
  }});
  assert.equal(result.status,'completed');assert.equal(result.steps,1);assert.deepEqual(result.tokenUsage,{input:10,output:5});assert.equal(result.events.at(-1)?.type,'completed');
  assert.deepEqual(TriageRun.parse(JSON.parse(await readFile(join(directory,'triage.json'),'utf8'))),result);
  const events=workloadEvents(result);assert.deepEqual(events,workloadEvents(result));assert.ok(!JSON.stringify(events).includes('Evidence supports'));assert.equal(events.events.find(e=>e.type==='agent.completed')?.parentRunId,result.input.runId);
  assert.throws(()=>TriageRun.parse({...result,inputHash:'0'.repeat(64)}));
});
test('invalid judgments exhaust the bounded loop; provider/cancellation/persistence failures never become assessments',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workload-agent-'));t.after(()=>rm(root,{recursive:true,force:true}));let n=0;
  const options=()=>({directory:join(root,String(n++)),provider:'copilot' as const,modelId:'gpt-5.6-terra',modelFactory:async()=>mock(finding('historical'))});
  const rejected=await triageWorkloads(fixture('missing-owner'),options());assert.equal(rejected.status,'failed');assert.equal(rejected.steps,3);assert.equal(rejected.result,undefined);assert.equal(rejected.events.filter(e=>e.type==='resultRejected').length,3);
  const failed=await triageWorkloads(fixture('completed-job'),{...options(),modelFactory:async()=>{throw new Error('private-token');}});assert.equal(failed.failure,'provider_error');assert.ok(!JSON.stringify(failed).includes('private-token'));
  const controller=new AbortController();controller.abort();let calls=0;
  const cancelled=await triageWorkloads(fixture('completed-job'),{...options(),signal:controller.signal,modelFactory:async()=>{calls++;return mock(finding('historical'));}});
  assert.equal(cancelled.failure,'cancelled_or_timed_out');assert.equal(calls,0);
  const occupied=join(root,'occupied');await writeFile(occupied,'occupied');await assert.rejects(triageWorkloads(fixture('completed-job'),{...options(),directory:occupied,modelFactory:async()=>{calls++;throw new Error('Must not start');}}));assert.equal(calls,0);
});

test('failed rejection checkpoint stops correction before another model step',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workload-storage-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'run');
  const model=mock(finding('historical'));let steps=0;const original=model.doStream.bind(model);model.doStream=async options=>{steps++;return original(options);};
  await assert.rejects(triageWorkloads(fixture('missing-owner'),{directory,provider:'copilot',modelId:'gpt-5.6-terra',modelFactory:async()=>{
    await rename(join(directory,'triage.json'),join(root,'admission.json'));await mkdir(join(directory,'triage.json'));return model;
  }}),/Persistence failed/);
  assert.equal(steps,1);assert.equal(JSON.parse(await readFile(join(root,'admission.json'),'utf8')).status,'running');
});
