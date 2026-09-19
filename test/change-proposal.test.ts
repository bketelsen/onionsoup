import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MockLanguageModelV3,simulateReadableStream} from 'ai/test';
import {validateResult, safeInput, type ProposalInput} from '../src/change-proposal/contracts.ts';
import {extractFeatureRequirements,draftChangeProposal} from '../src/change-proposal/agents.ts';
import {createChangeProposal,renderChangeProposal,featurePreparation} from '../src/change-proposal/recipe.ts';
import {eligiblePacket,validateChangeWorkflow,proposalResult} from '../src/change-proposal/record.ts';
import {createPacket} from '../src/packet.ts';
import {triage} from '../src/triage.ts';
import {fixtureModel} from '../src/fixture-model.ts';
import {atomicJson,readJson} from '../src/batch-store.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {workflowEvents} from '../src/workflow-events.ts';
import {fields} from '../src/contracts.ts';
const issue={schemaVersion:1 as const,repository:'example/widget',number:7,updatedAt:'2026-09-18T12:00:00Z',title:'Add list export',body:'Export the current list to JSON. Preserve existing list output.'};
const claim=(text:string,evidenceIds=['issue:body'])=>({text,basis:'proposed' as const,evidenceIds});
const requirements={schemaVersion:1,status:'sufficient_for_proposal',userNeed:claim('Export a list.'),scenarios:[claim('List exports JSON.')],constraints:[claim('Preserve list output.')],nonGoals:[],questions:[]};
const proposal={schemaVersion:1,status:'proposal_ready',outcome:claim('Export list as JSON.'),changes:[claim('Add JSON export.',['issue:body','source:1'])],nonGoals:[],
  acceptanceCriteria:[{id:'AC1',criterion:claim('JSON represents every listed entry.')}],verification:[
    {criterionIds:['AC1'],kind:'acceptance',check:claim('Compare parsed JSON entries to the fixture list.'),baselineExpectation:'capability_absent'},
    {criterionIds:['AC1'],kind:'compatibility',check:claim('Compare current list output unchanged.'),baselineExpectation:'existing_behavior'}],
  compatibility:claim('Preserve list output.'),migration:claim('Propose no migration.'),documentation:claim('Document export.'),questions:[],risks:[]};
const missing={...proposal,changes:[],status:'needs_information',questions:[{question:'Which interface is intended?',blocking:true,evidenceIds:['issue:body']}]};
const source={id:'source:1',path:'widget.ts',startLine:1,endLine:1,quote:'export const list = [];',relevance:'unassessed_search_lead' as const};
const preparation={sources:[source],attempts:[{operation:'search' as const,status:'completed' as const},{operation:'read' as const,status:'completed' as const,path:source.path}],limitations:['Only one search lead, not verified relevance.']};
const input={schemaVersion:1,packetId:randomUUID(),packetHash:'a'.repeat(64),issue,commit:'a'.repeat(40),changeKind:'feature',requirements,sources:[source],limitations:preparation.limitations};
function model(responses:unknown[]) {
  let index=0;
  return new MockLanguageModelV3({doStream:async()=>{
    const r=responses[index++];if(r instanceof Error) throw r;if(!r) throw new Error('Fixture exhausted');
    return {stream:simulateReadableStream({initialDelayInMs:null,chunkDelayInMs:null,chunks:[{type:'stream-start',warnings:[]},
      {type:'tool-call',toolCallId:String(index),toolName:'submit_result',input:JSON.stringify(r)},
      {type:'finish',finishReason:{unified:'tool-calls',raw:'tool-calls'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}}]})};
  }});
}
async function fixture(t:TestContext,bug=false) {
  const root=await mkdtemp(join(tmpdir(),'onionsoup-proposal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const r=await triage(issue,{provider:'copilot',modelId:'gpt-5.6-terra',model:fixtureModel([{schemaVersion:2,kind:bug?'bug_report':'feature_request',bug_readiness:bug?'ready':'not_applicable',summary:'Reported behavior.',
    evidence:bug?fields.map(field=>({field,source:'body',quote:issue.body})):[],questions:[]}])});
  // A valid partial ready-bug packet intentionally has no location, so its proposal must ask for context.
  const packet=bug?{schemaVersion:1 as const,packetId:randomUUID(),createdAt:issue.updatedAt,finishedAt:issue.updatedAt,status:'partial' as const,stage:'done' as const,issue,inputHash:hash(issue),repository:{name:issue.repository,commit:'a'.repeat(40)},
    execution:{provider:'copilot' as const,model:'gpt-5.6-terra' as const},reusedReadiness:true,readiness:r,locationDisposition:'failed' as const}:
    await createPacket(issue,{directory:join(root,'packet'),checkout:'/unused',commit:'a'.repeat(40),provider:'copilot',readiness:r});
  let calls=0;
  const options={directory:join(root,'proposal'),provider:'copilot' as const,checkout:'/unused',...(bug?{}:{query:'list'}),prepareFeature:async()=>structuredClone(preparation),
    modelFactory:async()=>({provider:'copilot' as const,modelId:'gpt-5.6-terra',model:model([bug?missing:calls++===0?requirements:proposal])})};
  return {root,packet,options,calls:()=>calls};
}
test('feature and bug profiles enforce evidence, coverage, preparation and acceptance separation',()=>{
  assert.equal(validateResult('change-proposal',proposal,input).status,'proposal_ready');
  const invalid=[{...proposal,changes:[claim('Ungrounded scope')]},{...proposal,outcome:claim('Invented',['source:99'])},{...proposal,acceptanceCriteria:[...proposal.acceptanceCriteria,...proposal.acceptanceCriteria]},
    {...proposal,verification:[]},{...proposal,verification:[{...proposal.verification[0],criterionIds:['AC99']}]},
    {...proposal,verification:proposal.verification.map(v=>({...v,baselineExpectation:'reported_failure'}))},
    {...proposal,questions:missing.questions},{...proposal,accepted:true}];
  for(const r of invalid) assert.throws(()=>validateResult('change-proposal',r,input));
  assert.throws(()=>validateResult('change-proposal',proposal,{...input,sources:[]}));
  assert.throws(()=>validateResult('change-proposal',proposal,{...input,requirements:{...requirements,status:'needs_information',questions:missing.questions}}));
  assert.throws(()=>validateResult('change-proposal',{...proposal,status:'needs_information'},input));
  const {requirements:_,...bug}=input;
  assert.throws(()=>validateResult('change-proposal',proposal,{...bug,changeKind:'bug_fix',readinessSummary:'Reported bug'}));
  assert.equal(validateResult('change-proposal',{...proposal,verification:[{...proposal.verification[0],kind:'regression',baselineExpectation:'reported_failure'}]},
    {...bug,changeKind:'bug_fix',readinessSummary:'Reported bug'}).status,'proposal_ready');
});
test('ambiguous and mixed requirements preserve a blocking question; compatibility constraints remain claims',()=>{
  const ambiguous={...requirements,status:'needs_information',questions:missing.questions};
  assert.equal(validateResult('feature-requirements',ambiguous,{schemaVersion:1,issue:{...issue,body:'Improve export and fix its behavior.'}}).status,'needs_information');
  assert.throws(()=>validateResult('feature-requirements',{...ambiguous,status:'sufficient_for_proposal'},{schemaVersion:1,issue}));
  assert.throws(()=>validateResult('feature-requirements',{...requirements,scenarios:[]},{schemaVersion:1,issue}));
  assert.throws(()=>validateResult('feature-requirements',{...requirements,userNeed:claim('Unknown',['requirements'])},{schemaVersion:1,issue}));
});
test('invalid tool submission can be corrected within bounded steps; success needs validated submit',async()=>{
  const m=model([{...proposal,outcome:claim('Bad',['invented'])},proposal]);
  const r=await draftChangeProposal(input,{model:m,provider:'copilot',modelId:'gpt-5.6-terra'});
  assert.equal(r.status,'completed');assert.equal(m.doStreamCalls.length,2);
  const bad=await draftChangeProposal(input,{model:model(Array(3).fill({...proposal,verification:[]})),provider:'copilot',modelId:'gpt-5.6-terra'});
  assert.equal(bad.status,'failed');assert.equal(bad.result,undefined);
});
test('feature recipe persists two reservations, original classification, reusable artifacts and content-free trace',async t=>{
  const f=await fixture(t),w=await createChangeProposal(f.packet,f.options);
  assert.equal(w.status,'completed');assert.equal(f.calls(),2);assert.equal(w.budget.consumed,2);
  assert.equal(w.parent.readiness?.assessment?.bug_readiness,'not_applicable');assert.equal(w.acceptance,'not_recorded');assert.equal(w.verification,'not_executed');
  const events=workflowEvents(w);assert.deepEqual(events.events.filter(e=>e.type==='workflow.budget_reserved').map(e=>e.budget?.consumed),[1,2]);
  assert.ok(!JSON.stringify(events).includes(issue.body));assert.ok(events.events.every(e=>e.parentWorkflowId===w.parent.packetId));
  const before=await readFile(join(f.options.directory,'proposal.json'),'utf8');await renderChangeProposal(f.options.directory);
  assert.equal(await readFile(join(f.options.directory,'proposal.json'),'utf8'),before);assert.equal(f.calls(),2);
  await assert.rejects(createChangeProposal(f.packet,f.options));assert.equal(f.calls(),2);
  for(const change of [({...w,parentHash:'b'.repeat(64)}),({...w,acceptance:'accepted'}),({...w,budget:{limit:2,consumed:1,remaining:1}})]) assert.throws(()=>validateChangeWorkflow(change));
  const forged=structuredClone(w);(forged.stages[1].run!.input as ProposalInput).sources[0].quote='forged';assert.throws(()=>validateChangeWorkflow(forged));
});
test('ready bug with missing location uses the common proposal worker and remains needs information',async t=>{
  const f=await fixture(t,true),w=await createChangeProposal(f.packet,f.options);
  assert.equal(w.status,'completed');assert.equal(w.budget.consumed,1);assert.deepEqual(w.stages.map(s=>s.agent),['change-proposal']);
  assert.equal(proposalResult(w)?.status,'needs_information');assert.equal(w.preparation?.sources.length,0);
  const wrong=structuredClone(f.packet);wrong.readiness!.assessment!.kind='support_question';wrong.readiness!.assessment!.bug_readiness='not_applicable';
  assert.throws(()=>eligiblePacket(wrong));
});
test('reservation and child-final storage failures stop inference and preserve last durable unknown state',async t=>{
  for(const phase of ['reservation','child_final']) {
    const f=await fixture(t);
    await assert.rejects(createChangeProposal(f.packet,{...f.options,persist:async(file,w)=>{
      if(phase==='reservation'&&w.budget.consumed===1||phase==='child_final'&&w.stages[0]?.run?.status==='completed') throw new Error('disk');
      await atomicJson(file,w);
    }}),/persistence failed/);
    assert.equal(f.calls(),phase==='reservation'?0:1);
    const saved=await renderChangeProposal(f.options.directory);assert.equal(saved.status,'running');
  }
});
test('initialization failure, child failure and cancellation never advance to proposal',async t=>{
  t.mock.method(console,'error',()=>{});
  for(const mode of ['initialize','child','cancel']) {
    const f=await fixture(t),c=new AbortController();let calls=0;
    const w=await createChangeProposal(f.packet,{...f.options,signal:c.signal,modelFactory:async()=>{
      calls++;if(mode==='initialize') throw new Error('secret provider diagnostic');return {provider:'copilot',modelId:'gpt-5.6-terra',model:model([new Error('secret provider diagnostic')])};
    },persist:async(file,w)=>{await atomicJson(file,w);if(mode==='cancel'&&w.preparation) c.abort();}});
    assert.equal(w.status,'failed');assert.equal(calls,mode==='cancel'?0:1);assert.ok(w.stages.every(s=>s.agent==='feature-requirements'));
    assert.ok(!JSON.stringify(workflowEvents(w)).includes('secret provider diagnostic'));
  }
});
test('sensitive and oversized input is rejected before checkpoint or model invocation',async()=>{
  let saves=0;
  await assert.rejects(extractFeatureRequirements({schemaVersion:1,issue:{...issue,body:'ghp_'+'x'.repeat(36)}},{model:model([]),provider:'copilot',modelId:'gpt-5.6-terra',checkpoint:async()=>{saves++;}}),/Sensitive/);
  assert.equal(saves,0);
  assert.throws(()=>safeInput('change-proposal',{...input,sources:Array.from({length:7},(_,i)=>({...source,id:`source:${i+1}`,quote:'a'.repeat(6000)})),issue:{...issue,body:'x'.repeat(24000)}}),/Context exceeds/);
});
test('real Git feature preparation inspects at most three distinct files and rejects wrong origin/pin',async t=>{
  const f=await fixture(t),checkout=join(f.root,'source');await mkdir(checkout);
  for(const file of ['a.ts','b.ts','c.ts','d.ts']) await writeFile(join(checkout,file),'const list = [];\n');
  const git=(...args:string[])=>promisify(execFile)('git',['-C',checkout,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args]);
  await git('init','-q');await git('remote','add','origin','https://github.com/example/widget.git');await git('add','.');await git('commit','-qm','fixture');
  const commit=(await git('rev-parse','HEAD')).stdout.trim(),signal=new AbortController().signal;
  const p=await featurePreparation(checkout,issue.repository,commit,'list',signal);
  assert.equal(p.sources.length,3);assert.equal(p.attempts.length,4);assert.ok(p.sources.every(s=>s.quote==='const list = [];'&&s.relevance==='unassessed_search_lead'));
  assert.equal((await featurePreparation(checkout,issue.repository,commit,'absent',signal)).sources.length,0);
  await assert.rejects(featurePreparation(checkout,'wrong/repo',commit,'list',signal));
  await assert.rejects(featurePreparation(checkout,issue.repository,'f'.repeat(40),'list',signal));
});

test('historical prompt v1 stays readable without silently granting current grounding qualification',async()=>{
  const {validateProposalAgentRun}=await import('../src/change-proposal/agents.ts');
  const r=await draftChangeProposal(input,{model:model([proposal]),provider:'copilot',modelId:'gpt-5.6-terra'});
  const historical={...r,promptVersion:'change-proposal-v1',result:{...proposal,changes:[claim('Issue-only proposed scope')]}};
  assert.equal(validateProposalAgentRun(historical).promptVersion,'change-proposal-v1');
  assert.throws(()=>validateProposalAgentRun({...historical,promptVersion:'change-proposal-v3'}),/SOURCE_SUPPORTED/);
  assert.throws(()=>validateProposalAgentRun({...r,promptVersion:'unknown'}));
});
