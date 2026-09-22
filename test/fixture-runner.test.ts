import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MockLanguageModelV3,simulateReadableStream} from 'ai/test';
import {runFixture,renderFixture} from '../src/fixture-runner/recipe.ts';
import {validateFixtureWorkflow,agentInput} from '../src/fixture-runner/record.ts';
import {validateResult,PatchInput,ReviewInput,Runtime,POLICY,Receipt,type Files} from '../src/fixture-runner/contracts.ts';
import {checks,git} from '../src/fixture-runner/fixture.ts';
import {hash} from '../src/repository-brief/contracts.ts';
import {atomicJson,readJson} from '../src/batch-store.ts';
import {workflowEvents} from '../src/workflow-events.ts';
import type {verifyFiles} from '../src/fixture-runner/sandbox.ts';
import {runtime,model,review,patch,verify,fixture} from './helpers/owned-fixture.ts';
test('one shared worker produces scope-limited bug and feature candidates with independently applicable diffs',async t=>{
  for(const which of ['bug','feature'] as const) {
    const f=await fixture(t),w=await runFixture(which,f.options);assert.equal(w.outcome,'candidate_verified');assert.equal(f.calls(),2);
    assert.equal(w.budget.consumed,2);assert.equal(w.publication,'not_authorized');assert.equal(w.baseline!.caseSetHash,w.candidate!.caseSetHash);
    const applied=join(f.root,'apply-again');await git(f.root,['clone','--quiet',join(f.options.directory,'base'),applied]);await git(applied,['apply',join(f.options.directory,'candidate.patch')]);
    for(const [path,content] of Object.entries(w.after!)) assert.equal(await readFile(join(applied,path),'utf8'),content);
    assert.ok(!w.diff!.includes('deleted file'));if(which==='bug') assert.ok(!w.diff!.includes('README.md'));
    const before=await readFile(join(f.options.directory,'fixture.json'),'utf8');await renderFixture(f.options.directory);assert.equal(await readFile(join(f.options.directory,'fixture.json'),'utf8'),before);
    await assert.rejects(runFixture(which,f.options));assert.equal(f.calls(),2);
    const trace=workflowEvents(w);assert.equal(trace.events.filter(e=>e.type==='verification.completed').length,2);assert.equal(trace.events.filter(e=>e.type==='agent.started').length,2);
    assert.ok(!JSON.stringify(trace).includes('tasks.filter'));assert.ok(!JSON.stringify(trace).includes(runtime.nodePath));
    const altered=structuredClone(w);altered.candidate!.treeHash='e'.repeat(64);assert.throws(()=>validateFixtureWorkflow(altered));
    const checksAltered=structuredClone(w);checksAltered.candidate!.checks[0].criterionIds=['AC999'];assert.throws(()=>validateFixtureWorkflow(checksAltered));
  }
});
test('patch boundary denies stale hashes, forbidden paths, duplicate/no-op edits and scope expansion',async t=>{
  const f=await fixture(t),w=await runFixture('bug',f.options),input=agentInput(w,'scoped-patch'),good=patch(input);
  for(const edits of [[{...good.edits[0],path:'../escape'}],[{...good.edits[0],path:'README.md',beforeHash:hash(w.before!['README.md'])}],
    [{...good.edits[0],beforeHash:'0'.repeat(64)}],[good.edits[0],good.edits[0]],[{...good.edits[0],content:w.before!['tasks.mjs']}]] )
    assert.throws(()=>validateResult('scoped-patch',{...good,edits},input));
  assert.throws(()=>validateResult('scoped-patch',{...good,command:'npm test'},input));
  assert.throws(()=>validateResult('scoped-patch',{...good,status:'needs_information'},input));
});
test('review cannot clear failing checks or cite invented lines/criteria; it receives no patch conversation',async t=>{
  const f=await fixture(t),w=await runFixture('feature',f.options),input=ReviewInput.parse(agentInput(w,'change-review'));
  assert.ok(!JSON.stringify(input).includes('messages'));assert.ok(!JSON.stringify(input).includes('toolCallId'));
  assert.throws(()=>validateResult('change-review',review,{...input,candidate:{...input.candidate,status:'assertion_failed'}}));
  assert.throws(()=>validateResult('change-review',{...review,findings:[{severity:'blocking',path:'tasks.mjs',line:999,criterionIds:['AC1'],explanation:'Bad'}]},input));
  assert.throws(()=>validateResult('change-review',{...review,verdict:'changes_requested'},input));
});
test('reservation or completed-child persistence failure stops later work without fabricated success',async t=>{
  for(const when of ['reservation','child']) {
    const f=await fixture(t);
    await assert.rejects(runFixture('bug',{...f.options,persist:async(file,w)=>{
      if(when==='reservation'&&w.budget.consumed===1||when==='child'&&w.stages[0]?.run?.status==='completed') throw new Error('Disk');await atomicJson(file,w);
    }}),/persistence failed/);
    assert.equal(f.calls(),when==='reservation'?0:1);const saved=await renderFixture(f.options.directory);assert.equal(saved.status,'running');
  }
});
test('baseline setup failure and failed candidate cleanup prevent model or review admission',async t=>{
  for(const phase of ['baseline','candidate']) {
    const f=await fixture(t),w=await runFixture('bug',{...f.options,verify:async(...args)=>{
      const r=await verify(...args);return args[3].phase===phase?{...r,status:'execution_error',checks:[],cleanup:'failed'}:r;
    }});assert.equal(w.status,'failed');assert.equal(f.calls(),phase==='baseline'?0:1);assert.equal(w.outcome,'execution_failed');
  }
});
test('review findings remain a blocked result even when the candidate checks passed',async t=>{
  const f=await fixture(t);let i=0;
  const w=await runFixture('bug',{...f.options,models:async()=>({provider:'copilot',modelId:'gpt-5.6-terra',model:model(i++===0?patch:()=>({schemaVersion:1,verdict:'changes_requested',
    findings:[{severity:'blocking',path:'tasks.mjs',line:2,criterionIds:['AC1'],explanation:'Requires further evidence.'}],limitations:['Scripted review boundary.']}))})});
  assert.equal(w.candidate!.status,'passed');assert.equal(w.outcome,'review_blocked');assert.equal(w.stages.length,2);
});
test('cancelled work and initialization failure spend no hidden retry',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(runFixture('bug',{...f.options,signal:controller.signal}));assert.equal(f.calls(),0);
  const g=await fixture(t);let calls=0;const w=await runFixture('feature',{...g.options,models:async()=>{calls++;throw new Error('Private auth failure');}});
  assert.equal(w.status,'failed');assert.equal(calls,1);assert.equal(w.budget.consumed,1);assert.ok(!JSON.stringify(w).includes('Private auth'));
});
test('fixture console history excludes conflicts and malformed records without executing anything',async t=>{
  const {fixtureHistory}=await import('../src/fixture-runner/console.ts');const f=await fixture(t),w=await runFixture('bug',f.options);
  const h=await fixtureHistory([f.root]);assert.equal(h.entries[0].record.workflowId,w.workflowId);
  await writeFile(join(f.options.directory,'fixture.json'),'{}');const bad=await fixtureHistory([f.root]);assert.equal(bad.entries.length,0);assert.equal(bad.invalid,1);
});
