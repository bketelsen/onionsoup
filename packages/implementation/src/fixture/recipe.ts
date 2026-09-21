import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson} from '@onionsoup/runtime/storage';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {createInvocationBudget} from '@onionsoup/runtime/budget';
import {liveModel} from '@onionsoup/providers';
import {EVALUATION_MODEL} from '@onionsoup/providers/evaluation-policy';
import {FixtureCase,Runtime,PatchResult,ReviewResult,POLICY} from './contracts.ts';
import {createFixture,acceptedScope,git} from './fixture.ts';
import {verifyFiles,validateRuntime} from './sandbox.ts';
import {proposeScopedPatch,reviewChange} from './agents.ts';
import {agentInput,baselineEligible,validateFixtureWorkflow,type FixtureWorkflow} from './record.ts';
import {fixtureMarkdown} from './render.ts';
export type FixtureEvents=(workflow:unknown)=>unknown;
export async function renderFixture(directory:string,events?:FixtureEvents) {
  const w=validateFixtureWorkflow(await readJson(join(directory,'fixture.json')));
  await writeFile(join(directory,'fixture.md'),fixtureMarkdown(w),{mode:0o600});
  if(events) await atomicJson(join(directory,'events.json'),events(w));
  return w;
}
export async function runFixture(which:unknown,options:{mode:'baseline'|'patch';directory:string;runtime:Runtime;provider:'copilot'|'codex';signal?:AbortSignal;
  modelFactory?:typeof liveModel;verify?:typeof verifyFiles;checkRuntime?:typeof validateRuntime;persist?:(file:string,w:FixtureWorkflow)=>Promise<void>}) {
  const fixtureCase=FixtureCase.parse(which);Runtime.parse(options.runtime);await(options.checkRuntime??validateRuntime)(options.runtime);options.signal?.throwIfAborted();
  const directory=resolve(options.directory);await mkdir(directory,{mode:0o700});
  const budget=createInvocationBudget(2),w:FixtureWorkflow={schemaVersion:1,kind:'fixture-change',workflowId:randomUUID(),startedAt:new Date().toISOString(),status:'running',
    mode:options.mode,case:fixtureCase,runtime:options.runtime,seed:randomUUID(),execution:{provider:options.provider,model:EVALUATION_MODEL},budget:budget.snapshot(),stages:[],publication:'not_authorized'};
  let broken=false;
  const save=async()=>{try {await (options.persist??atomicJson)(join(directory,'fixture.json'),structuredClone(validateFixtureWorkflow(w)));}catch{broken=true;throw new Error('Fixture persistence failed; inspect saved artifacts');}};
  await save();
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(POLICY.workflowTimeoutMs)]);
  const verify=async(phase:'baseline'|'candidate')=>{
    signal.throwIfAborted();
    const r=await(options.verify??verifyFiles)(phase==='baseline'?w.before:w.after,w.scope!,w.runtime,{directory:join(directory,phase+'-verification'),phase,seed:w.seed,signal,
      checkpoint:async intent=>{w.pendingExecution=intent;await save();}});
    w[phase]=r;delete w.pendingExecution;await save();return r;
  };
  const agent=async(id:'scoped-patch'|'change-review')=>{
    signal.throwIfAborted();const reservation=budget.reserve();if(!reservation) throw new Error('Budget exhausted');
    const stage:FixtureWorkflow['stages'][number]={agent:id,reservedAt:new Date().toISOString(),reservation};w.stages.push(stage);w.budget=reservation;await save();
    const adapter=await(options.modelFactory??liveModel)(EVALUATION_MODEL,options.provider);
    if(adapter.provider!==options.provider||adapter.modelId!==EVALUATION_MODEL) throw new Error('Adapter mismatch');
    signal.throwIfAborted();
    stage.run=await(id==='scoped-patch'?proposeScopedPatch:reviewChange)(agentInput(w,id),{...adapter,signal,checkpoint:async r=>{stage.run=r;await save();}});
    if(stage.run.status!=='completed') throw new Error('Agent failed');return stage.run;
  };
  try {
    const f=await createFixture(join(directory,'base'));w.before=f.files;w.scope=acceptedScope(fixtureCase,f.files,f.commit);await save();
    await verify('baseline');
    if(!baselineEligible(w)) {w.outcome='execution_failed';w.failure='execution_error';}
    else if(options.mode==='baseline') w.outcome='baseline_observed';
    else {
      const patch=PatchResult.parse((await agent('scoped-patch')).result);
      if(patch.status==='needs_information') w.outcome='needs_information';
      else {
        // Only text replacements are materialized; model output never becomes a command or a path.
        w.after={...w.before,...Object.fromEntries(patch.edits.map(e=>[e.path,e.content]))};await save();
        await git(directory,['clone','--no-local','--quiet','--no-checkout',join(directory,'base'),join(directory,'candidate')]);
        await git(join(directory,'candidate'),['read-tree','HEAD']);
        for(const [path,content] of Object.entries(w.after)) await writeFile(join(directory,'candidate',path),content,{mode:0o600,flag:'wx'});
        w.diff=await git(join(directory,'candidate'),['diff','--no-ext-diff','--no-textconv','HEAD','--','tasks.mjs','README.md']);w.diffHash=hash(w.diff);
        await writeFile(join(directory,'candidate.patch'),w.diff,{mode:0o600,flag:'wx'});
        // Verify the exact exported patch reconstructs the candidate from the accepted base.
        const applied=join(directory,'patch-check');
        await git(directory,['clone','--no-local','--quiet',join(directory,'base'),applied]);
        await git(applied,['apply','--check',join(directory,'candidate.patch')]);
        await git(applied,['apply',join(directory,'candidate.patch')]);
        const reconstructed=Object.fromEntries(await Promise.all(Object.keys(w.after).map(async path=>[path,await readFile(join(applied,path),'utf8')])));
        if(hash(reconstructed)!==hash(w.after)) throw new Error('Diff does not reconstruct candidate');
        w.diffAppliedTreeHash=hash(reconstructed);
        const changed=(await git(applied,['diff','--name-only','HEAD'])).trim().split('\n');
        if(changed.some(path=>!w.scope!.allowedFiles.includes(path as 'tasks.mjs'|'README.md'))) throw new Error('Diff exceeds accepted scope');
        await save();
        await verify('candidate');
        if(w.candidate!.cleanup!=='removed'||!['passed','assertion_failed','capability_absent'].includes(w.candidate!.status)) {w.outcome='execution_failed';w.failure='execution_error';}
        else {
          const review=ReviewResult.parse((await agent('change-review')).result);
          w.outcome=w.candidate!.status!=='passed'?'verification_failed':review.verdict==='no_blocking_findings'?'candidate_verified':'review_blocked';
        }
      }
    }
    w.status=w.outcome==='execution_failed'?'failed':'completed';
  } catch {
    if(broken) throw new Error('Fixture persistence failed; inspect saved artifacts');
    w.status='failed';w.failure=signal.aborted?'cancelled':'execution_error';w.outcome='execution_failed';
  }
  w.finishedAt=new Date().toISOString();await save();await renderFixture(directory);return w;
}
