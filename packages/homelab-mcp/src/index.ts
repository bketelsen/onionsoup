import { randomUUID } from 'node:crypto';
import { mkdir, realpath, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KubernetesTarget } from '@onionsoup/kubernetes-source';
import { digest, type WorkloadTransport } from '@onionsoup/kubernetes-source/workloads';
import { investigateWorkloads, TriageRun, findingCounts, workloadEvents, workloadCapabilityManifest, type TriageOptions } from '@onionsoup/workload-triage';
import { composeHomelabBrief, renderHomelabBrief, readHomelabObservation, HomelabBrief } from '@onionsoup/homelab-brief';
import { atomicJson } from '@onionsoup/runtime/storage';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
export const HomelabMcpConfig=z.object({schemaVersion:z.literal(1),provider:z.enum(['copilot','codex']),runsDirectory:z.string().min(1),
  observations:z.array(z.string().min(1)).max(16),targets:z.array(KubernetesTarget).max(10),maxJobs:z.number().int().min(1).max(10).default(4)}).strict()
  .refine(c=>new Set(c.targets.map(t=>t.assetId)).size===c.targets.length,'Duplicate targets');
export type HomelabMcpConfig=z.infer<typeof HomelabMcpConfig>;
const Job=z.object({schemaVersion:z.literal(1),jobId:z.uuid(),configHash:z.string().length(64),kind:z.enum(['brief','investigation']),targetId:z.string().optional(),
  investigationJobIds:z.array(z.uuid()).max(10),createdAt:z.iso.datetime(),status:z.enum(['admitted','settled','execution_failed']),finishedAt:z.iso.datetime().optional()}).strict();
type Job=z.infer<typeof Job>;
const reply=(body:Record<string,unknown>,isError=false)=>({isError,content:[{type:'text' as const,text:JSON.stringify(body)}],structuredContent:body});
export function createHomelabMcpServer(raw:unknown,options:{modelFactory:TriageOptions['modelFactory'];transport?:WorkloadTransport}){
  const config=HomelabMcpConfig.parse(raw),root=resolve(config.runsDirectory),configHash=digest(config);
  const targets=new Map(config.targets.map(t=>[t.assetId,t]));
  let active=false,admitted=0,stopped=false;
  const pending=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  const home=(id:string)=>join(root,z.uuid().parse(id));
  async function readSaved(id:string,relative:string){
    const file=join(home(id),relative);
    // Saved host state is private; reject symlink substitution even inside this root.
    const actual=await realpath(file);const base=await realpath(root);
    if(actual!==join(base,id,relative))throw new Error('Artifact path mismatch');
    const handle=await open(actual,'r');
    try{if(!(await handle.stat()).isFile())throw new Error('Not a file');const buffer=Buffer.alloc(2*1024*1024+1);let offset=0;
      while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
      if(offset>2*1024*1024)throw new Error('Artifact limit');return JSON.parse(buffer.subarray(0,offset).toString('utf8'));
    }finally{await handle.close();}
  }
  async function readJob(id:string){const job=Job.parse(await readSaved(id,'job.json'));if(job.jobId!==id||job.configHash!==configHash)throw new Error('Job mismatch');return job;}
  async function readTriage(id:string){const job=await readJob(id);if(job.kind!=='investigation'||job.status!=='settled')throw new Error('Investigation unfinished');
    const triage=TriageRun.parse(await readSaved(id,'investigation/triage/triage.json')),target=targets.get(job.targetId!);
    if(!target||triage.input.targetHash!==digest(target)||triage.assetId!==job.targetId||triage.provider!==config.provider||triage.model!==EVALUATION_MODEL)throw new Error('Target mismatch');
    return triage;
  }
  const server=new McpServer({name:'onionsoup-homelab',version:'0.1.0'});
  server.registerTool('discover_homelab',{description:'Discover configured target IDs, saved-source brief and bounded workload investigation. No credentials or paths are returned.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,openWorldHint:false}},async()=>reply({schemaVersion:1,targets:[...targets.keys()],savedSources:config.observations.length,
    capability:workloadCapabilityManifest(),limits:{maxJobs:config.maxJobs,admitted,concurrentJobs:1,active,maxInvestigationsPerBrief:10},
    effects:{configuredSshReads:true,modelCalls:true,localArtifacts:true,serviceWrites:false},lifecycle:{durableInspection:true,resume:false,admissionAllowance:'per-process; restart resets allowance'}}));
  async function submit(kind:Job['kind'],targetId?:string,investigationJobIds:string[]=[]){
    if(stopped)return reply({error:'host_stopping'},true);if(active)return reply({error:'busy'},true);if(admitted>=config.maxJobs)return reply({error:'job_limit'},true);
    if(kind==='investigation'&&!targets.has(targetId!))return reply({error:'target_not_allowed'},true);
    if(new Set(investigationJobIds).size!==investigationJobIds.length)return reply({error:'duplicate_investigation'},true);
    active=true;admitted++;const job:Job={schemaVersion:1,jobId:randomUUID(),configHash,kind,...(targetId?{targetId}:{}),investigationJobIds,createdAt:new Date().toISOString(),status:'admitted'};
    try{await mkdir(root,{recursive:true,mode:0o700});await mkdir(home(job.jobId),{mode:0o700});await atomicJson(join(home(job.jobId),'job.json'),job);}catch{active=false;return reply({error:'admission_storage_failed'},true);}
    const controller=new AbortController();if(stopped)controller.abort();
    const promise=Promise.resolve().then(async()=>{
      try{
        controller.signal.throwIfAborted();
        if(kind==='investigation')await investigateWorkloads(targets.get(targetId!)!,{directory:join(home(job.jobId),'investigation'),provider:config.provider,modelId:EVALUATION_MODEL,modelFactory:options.modelFactory,transport:options.transport,signal:controller.signal});
        else{
          const sources=[];
          for(const path of config.observations)sources.push(await readHomelabObservation(resolve(path),controller.signal));
          for(const id of investigationJobIds){controller.signal.throwIfAborted();sources.push(await readTriage(id));}
          controller.signal.throwIfAborted();const brief=composeHomelabBrief(sources);
          await atomicJson(join(home(job.jobId),'brief.json'),brief);await writeFile(join(home(job.jobId),'brief.md'),renderHomelabBrief(brief),{flag:'wx',mode:0o600});
        }
        job.status='settled';
      }catch{job.status='execution_failed';}
      job.finishedAt=new Date().toISOString();try{await atomicJson(join(home(job.jobId),'job.json'),job);}catch{/* Durable admission remains unfinished. */}
    }).finally(()=>{pending.delete(job.jobId);active=false;});
    pending.set(job.jobId,{controller,promise});return reply({schemaVersion:1,jobId:job.jobId,status:'admitted'});
  }
  server.registerTool('investigate_workload_findings',{description:'Collect fixed read-only evidence and assess at most ten candidate pods for one configured target. Returns a job ID; no repair or logs.',
    inputSchema:z.object({targetId:KubernetesTarget.shape.assetId}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},async({targetId})=>submit('investigation',targetId));
  server.registerTool('create_homelab_brief',{description:'Compose configured saved observations plus optional settled investigation jobs. No live refresh or model calls. Returns a job ID.',
    inputSchema:z.object({investigationJobIds:z.array(z.uuid()).max(10).default([])}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async({investigationJobIds})=>submit('brief',undefined,investigationJobIds));
  server.registerTool('inspect_homelab_job',{description:'Inspect a saved job and normalized result after completion or restart. Unfinished work is never resumed. No raw provider state or resource-name lookup.',
    inputSchema:z.object({jobId:z.uuid()}).strict(),annotations:{readOnlyHint:true,openWorldHint:false}},async({jobId})=>{
      try{
        // A job can settle while its older admission record is being read.
        // Preserve the in-flight observation so this race cannot report a crashed job.
        const wasPending=pending.has(jobId),job=await readJob(jobId);
        const status=pending.has(jobId)||job.status==='admitted'&&wasPending?'running':job.status==='admitted'?'unfinished':job.status;
        let result:Record<string,unknown>={};
        if(job.status==='settled'){
          if(job.kind==='investigation'){const triage=await readTriage(jobId);result={runId:triage.runId,resultStatus:triage.status,findings:triage.result?.findings??[],findingCounts:triage.result?findingCounts(triage.result):null,failure:triage.failure,sourceRunId:triage.input.runId,observedAt:triage.input.startedAt,assessedAt:triage.startedAt,eligible:triage.input.eligible,omitted:triage.input.omitted,events:workloadEvents(triage),tokenUsage:triage.tokenUsage??null};}
          else{const brief=HomelabBrief.parse(await readSaved(jobId,'brief.json'));result={runId:brief.runId,markdown:renderHomelabBrief(brief)};}
        }return reply({schemaVersion:1,jobId,status,...result});
      }catch{return reply({error:'inspection_failed'},true);}
    });
  server.registerTool('cancel_homelab_job',{description:'Request cooperative cancellation; retain saved evidence and consumed admission.',inputSchema:z.object({jobId:z.uuid()}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async({jobId})=>{
    const running=pending.get(jobId);if(!running)return reply({error:'job_not_active'},true);running.controller.abort();return reply({jobId,status:'cancellation_requested'});
  });
  return {server,async shutdown(){stopped=true;for(const job of pending.values())job.controller.abort();await Promise.allSettled([...pending.values()].map(j=>j.promise));await server.close();}};
}
