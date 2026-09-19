import type {TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MockLanguageModelV3,simulateReadableStream} from 'ai/test';
import {PatchInput,Runtime,POLICY,Receipt,type Files} from '../../src/fixture-runner/contracts.ts';
import {checks} from '../../src/fixture-runner/fixture.ts';
import {hash} from '../../src/repository-brief/contracts.ts';
import type {verifyFiles} from '../../src/fixture-runner/sandbox.ts';
export const runtime=Runtime.parse({schemaVersion:1,imageId:'sha256:'+'a'.repeat(64),nodePath:'/fixture/node',nodeHash:'b'.repeat(64),podmanVersion:'fixture'});
export function model(response:(input:any)=>unknown) {return new MockLanguageModelV3({doStream:async options=>{
  const prompt=options.prompt.find(m=>m.role==='user') as any;
  const input=JSON.parse(prompt.content.find((c:any)=>c.type==='text').text).task_evidence;
  return {stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[{type:'stream-start',warnings:[]},
    {type:'tool-call',toolCallId:randomUUID(),toolName:'submit_result',input:JSON.stringify(response(input))},
    {type:'finish',finishReason:{unified:'tool-calls',raw:'tool-calls'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}}]})};
}});}
export const review={schemaVersion:1,verdict:'no_blocking_findings',findings:[],limitations:['Finite scripted fixture; not semantic accuracy evidence.']};
export function patch(input:any) {
  const p=PatchInput.parse(input),content=p.scope.case==='bug'?p.files['tasks.mjs'].replace('task.done)','task.done === true)'):
    p.files['tasks.mjs']+'\nexport function exportTasks(tasks) { return JSON.stringify(tasks.map(({name}) => ({name}))); }\n';
  return {schemaVersion:1,status:'candidate',summary:'Scoped fixture candidate.',questions:[],edits:[{path:'tasks.mjs',beforeHash:p.fileHashes['tasks.mjs'],content},
    ...(p.scope.case==='feature'?[{path:'README.md',beforeHash:p.fileHashes['README.md'],content:p.files['README.md']+'\nexportTasks usage:\n```js\nexportTasks([]) // "[]"\n```\n'}]:[])]};
}
export const verify:typeof verifyFiles=async(files,scope,rt,options)=>{
  const id=randomUUID(),at=new Date().toISOString(),data=files as Files;
  const intent={receiptId:id,containerName:'onionsoup-fixture-'+id,phase:options.phase,startedAt:at,treeHash:hash(data),scopeHash:hash(scope),runtimeHash:hash(rt),policyHash:hash(POLICY),harnessHash:'c'.repeat(64)};
  await options.checkpoint?.(intent);
  const result=checks(scope.case,options.seed!).map(c=>({id:c.id,criterionIds:c.criterionIds,status:'passed' as 'passed'|'assertion_failed'|'capability_absent',reason:'matched' as 'matched'|'value_mismatch'|'export_absent'}));
  if(options.phase==='baseline') for(const c of result.filter(c=>c.criterionIds.includes('AC1'))) {c.status=scope.case==='bug'?'assertion_failed':'capability_absent';c.reason=scope.case==='bug'?'value_mismatch':'export_absent';}
  if(scope.case==='feature') result.push({id:'export-documentation',criterionIds:['AC3'],status:options.phase==='baseline'?'assertion_failed':'passed',reason:options.phase==='baseline'?'value_mismatch':'matched'});
  return Receipt.parse({schemaVersion:1,...intent,finishedAt:at,status:options.phase==='baseline'?(scope.case==='bug'?'assertion_failed':'capability_absent'):'passed',checks:result,
    exitCode:0,oomKilled:false,cleanup:'removed',caseSetHash:hash(checks(scope.case,options.seed!)),outputHash:'d'.repeat(64),outputBytes:30});
};
export async function fixture(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),'onionsoup-fixture-test-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const options={mode:'patch' as const,directory:join(root,'run'),provider:'copilot' as const,runtime,checkRuntime:async()=>runtime,verify,
    modelFactory:async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model(calls++===0?patch:()=>review)})};
  return {root,options,calls:()=>calls};
}
