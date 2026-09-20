import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createHomelabChatProfile, evidenceAge, HomelabChatMemory, type McpCaller } from '../src/index.ts';
const podId='r-'+'1'.repeat(64),ownerId='r-'+'2'.repeat(64),jobId=randomUUID(),sourceRunId=randomUUID();
const finding={podId,classification:'insufficient_evidence' as const,reason:'Owner status missing; do not infer recovery.',evidenceIds:[podId],nextInvestigation:'check_owner_status' as const};
function fixture(options:{old?:boolean;multiple?:boolean;memory?:unknown}={}){
  let memory=options.memory;const calls:string[]=[],now=new Date(Date.now()-(options.old?3600000:1000)).toISOString();
  const call:McpCaller=async(name,args)=>{calls.push(name);return {structuredContent:name==='discover_homelab'?{schemaVersion:1,targets:options.multiple?['one','two']:['one'],refreshSources:[],savedSources:0}:
    name==='investigate_workload_findings'?{schemaVersion:1,jobId,status:'admitted'}:
    {schemaVersion:1,jobId:args.jobId,status:'settled',resultStatus:'completed',runId:randomUUID(),sourceRunId,observedAt:now,sourceFinishedAt:now,sourceStatus:'completed',assessedAt:now,findings:[finding],eligible:1,omitted:0}};};
  const profile=createHomelabChatProfile({bindingHash:'a'.repeat(64),call,pollMs:0});memory??=profile.initialMemory();
  const turn=profile.turn({memory,at:new Date().toISOString(),signal:new AbortController().signal,checkpoint:async(m)=>{memory=z.json().parse(structuredClone(m));}});
  const invoke=async(name:string,args:unknown={})=>{const tool=turn.tools.find(t=>t.name===name)!;return tool.execute(tool.input.parse(args));};
  return {profile,turn,invoke,calls,memory:()=>memory};
}
test('a restarted profile can inspect owned evidence without admitting another job; stale evidence cannot support current answers',async()=>{
  const f=fixture();await f.invoke('discover_homelab');await f.invoke('investigate_workload_findings');
  const answer={kind:'answer' as const,text:'Owner evidence is missing.',basis:'current' as const,references:[{id:jobId}]};
  assert.equal((await f.turn.validateAnswer(answer) as any).evidence[0].findingCounts.insufficientEvidence,1);
  await assert.doesNotReject(f.turn.validateAnswer({...answer,references:[{id:jobId,findingId:podId}]}));
  const resumed=fixture({old:true,memory:f.memory()});await assert.rejects(resumed.turn.validateAnswer(answer),/INSPECT_FIRST/);
  await resumed.invoke('inspect_evidence',{jobId});await assert.rejects(resumed.turn.validateAnswer(answer),/STALE/);
  const historical=await resumed.turn.validateAnswer({...answer,basis:'snapshot'});assert.equal((historical as any).evidence[0].freshness[0].freshness,'stale');
  assert.equal(resumed.calls.filter(n=>n==='investigate_workload_findings').length,0);assert.equal(HomelabChatMemory.parse(resumed.memory()).admissions,1);
});
test('ambiguous targets, foreign jobs, arbitrary source IDs and session exhaustion are denied before remote admission',async()=>{
  const f=fixture({multiple:true});await f.invoke('discover_homelab');await assert.rejects(f.invoke('investigate_workload_findings'),/TARGET/);
  await assert.rejects(f.invoke('inspect_evidence',{jobId:randomUUID()}),/OWNED/);await assert.rejects(f.invoke('refresh_sources',{sourceIds:['foreign']}),/SOURCE/);
  assert.deepEqual(f.calls,['discover_homelab']);
  const exhausted=fixture({memory:{schemaVersion:1,profileVersion:'homelab-chat-v2',admissions:16,jobs:[]}});await exhausted.invoke('discover_homelab');await assert.rejects(exhausted.invoke('investigate_workload_findings'),/SESSION_ADMISSION/);assert.equal(exhausted.calls.length,1);
});
test('future and invalid source timing stay unknown; partial evidence and misleading prose cannot widen the tool set',async()=>{
  assert.equal(evidenceAge('2099-01-01T00:00:00Z','2099-01-01T00:00:00Z').freshness,'unknown');assert.equal(evidenceAge(new Date().toISOString(),undefined).freshness,'unknown');
  const f=fixture();assert.ok(!f.turn.tools.some(t=>/shell|write|restart|logs/.test(t.name)));
  const inspect=f.turn.tools.find(t=>t.name==='inspect_evidence')!;assert.throws(()=>inspect.input.parse({jobId,command:'sudo reboot'}));
  await f.turn.cleanup();
});

test('lost admission responses consume persisted allowance and do not create a replayable job',async()=>{
  let memory:unknown,admissions=0;
  const profile=createHomelabChatProfile({bindingHash:'a'.repeat(64),call:async name=>{
    if(name==='discover_homelab')return {structuredContent:{schemaVersion:1,targets:['one'],refreshSources:[],savedSources:0}};
    admissions++;throw Error('Connection lost after remote admission');
  }});
  const turn=profile.turn({memory:profile.initialMemory(),at:new Date().toISOString(),signal:new AbortController().signal,checkpoint:async m=>{memory=z.json().parse(structuredClone(m));}});
  await turn.tools.find(t=>t.name==='discover_homelab')!.execute({});await assert.rejects(turn.tools.find(t=>t.name==='investigate_workload_findings')!.execute({}));
  const saved=HomelabChatMemory.parse(memory);assert.equal(saved.admissions,1);assert.equal(saved.jobs.length,0);
  const restarted=profile.turn({memory:saved,at:new Date().toISOString(),signal:new AbortController().signal,checkpoint:async()=>{}});await restarted.cleanup();assert.equal(admissions,1);
});
