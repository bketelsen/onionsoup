import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson } from '@onionsoup/runtime/storage';
import { hash } from '@onionsoup/repository-analysis/contracts';
import { LocationSource } from '../location-source.ts';
import { createInvocationBudget } from '@onionsoup/runtime/budget';
import type { ModelResolver } from '@onionsoup/providers';
import { LIMITS, safeInput, type ProposalAgentId } from './contracts.ts';
import { extractFeatureRequirements, draftChangeProposal } from './agents.ts';
import { eligiblePacket, bugPreparation, stageInput, validateChangeWorkflow, Query, type ChangeWorkflow, type Preparation } from './record.ts';
import { proposalMarkdown } from './render.ts';
const at=()=>new Date().toISOString();
export async function featurePreparation(checkout:string,repository:string,commit:string,query:string,signal:AbortSignal):Promise<Preparation> {
  Query.parse(query);
  const source=await LocationSource.open(checkout,repository,commit,signal);
  const p:Preparation={sources:[],attempts:[],limitations:[
    'Source context is the first three distinct file matches from one operator-selected literal search. Relevance is unassessed; other implementations and tests may be missing.',
    'Pinned source may differ from the affected release. Nothing was executed. Compatibility and migration behavior remain unverified.']};
  let matches:Array<{path:string;line:number}>=[];
  try { const found=await source.search({query,scope:'all',pathPrefix:''});matches=found.matches;p.attempts.push({operation:'search',status:'completed'}); }
  catch {p.attempts.push({operation:'search',status:'failed'});p.limitations.push('The source search failed.');}
  const unique=matches.filter((m,i)=>matches.findIndex(n=>n.path===m.path)===i).slice(0,LIMITS.sourceReads);
  for(const m of unique) {
    signal.throwIfAborted();
    try {
      await source.read({path:m.path,startLine:Math.max(1,m.line-8),endLine:m.line+16});
      const e=source.excerpts.at(-1)!;
      p.sources.push({id:`source:${p.sources.length+1}`,path:e.path,startLine:e.startLine,endLine:e.endLine,quote:e.lines.join('\n'),relevance:'unassessed_search_lead'});
      p.attempts.push({operation:'read',path:m.path,status:'completed'});
    } catch {p.attempts.push({operation:'read',path:m.path,status:'failed'});}
  }
  if(!p.sources.length) p.limitations.push('No inspected source context is available. The proposal must remain needs_information.');
  return p;
}
export type EventsFor=(w:ChangeWorkflow)=>unknown;
export async function renderChangeProposal(directory:string,events?:EventsFor) {
  const w=validateChangeWorkflow(await readJson(join(directory,'proposal.json')));
  if(events) await atomicJson(join(directory,'events.json'),events(w));
  await writeFile(join(directory,'proposal.md'),proposalMarkdown(w),{mode:0o600});return w;
}
export async function createChangeProposal(raw:unknown,options:{directory:string;models:ModelResolver;checkout?:string;query?:string;
  signal?:AbortSignal;prepareFeature?:typeof featurePreparation;persist?:(file:string,w:ChangeWorkflow)=>Promise<void>;events?:EventsFor}) {
  const parent=structuredClone(eligiblePacket(raw)),changeKind=parent.readiness!.assessment!.kind==='bug_report'?'bug_fix':'feature';
  const query=changeKind==='feature'?Query.parse(options.query):undefined;
  if(changeKind==='feature'&&!options.checkout||changeKind==='bug_fix'&&options.query!==undefined) throw new Error('Invalid source selection');
  safeInput('feature-requirements',{schemaVersion:1,issue:parent.issue});options.signal?.throwIfAborted();
  const budget=createInvocationBudget(2),w:ChangeWorkflow={schemaVersion:1,kind:'change-proposal',workflowId:randomUUID(),startedAt:at(),status:'running',
    parent,parentHash:hash(parent),changeKind,query,acceptance:'not_recorded',verification:'not_executed',budget:budget.snapshot(),stages:[]};
  await mkdir(options.directory,{mode:0o700});let storageBroken=false;
  const save=async()=>{
    try {await (options.persist??atomicJson)(join(options.directory,'proposal.json'),structuredClone(validateChangeWorkflow(w)));}
    catch {storageBroken=true;throw new Error('Proposal persistence failed; inspect saved artifacts');}
  };await save();
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(LIMITS.timeoutMs)]);
  try {
    w.preparation=changeKind==='bug_fix'?bugPreparation(parent):await (options.prepareFeature??featurePreparation)(options.checkout!,parent.repository.name,parent.repository.commit,query!,signal);
    await save();
    const agents:ProposalAgentId[]=changeKind==='feature'?['feature-requirements','change-proposal']:['change-proposal'];
    for(const agent of agents) {
      signal.throwIfAborted();const input=safeInput(agent,stageInput(w,agent));
      const reservation=budget.reserve();if(!reservation) throw new Error('Budget exhausted');
      const stage:ChangeWorkflow['stages'][number]={agent,reservation,reservedAt:at()};w.stages.push(stage);w.budget=reservation;await save();
      const adapter=await options.models(agent);
      signal.throwIfAborted();
      stage.run=await (agent==='feature-requirements'?extractFeatureRequirements:draftChangeProposal)(input,{...adapter,signal,checkpoint:async r=>{stage.run=r;await save();}});
      if(stage.run.status!=='completed') {w.failure='agent_failed';break;}
    }
    w.status=w.failure?'failed':'completed';
  } catch {
    if(storageBroken) throw new Error('Proposal persistence failed; inspect saved artifacts');
    w.status='failed';w.failure=signal.aborted?'interrupted_or_timed_out':'execution_error';
  }
  w.finishedAt=at();await save();await renderChangeProposal(options.directory,options.events);return w;
}
