import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import type { Capability } from '@onionsoup/job-host';
import { HomelabMcpConfig } from '@onionsoup/homelab-mcp';
import { collectRefresh, validateRefresh } from '@onionsoup/homelab-mcp/refresh';
import { investigateWorkloads, TriageRun, PROMPT_VERSION } from '@onionsoup/workload-triage';
import { HomelabObservation, HomelabBrief, composeHomelabBrief, renderHomelabBrief, readHomelabObservation } from '@onionsoup/homelab-brief';
import { BriefRequest, RepoAgentId, repositoryCapabilityManifest } from '@onionsoup/repository-analysis';
import { createRepositoryBrief, validateRepositoryBrief, repositoryBriefMarkdown } from '@onionsoup/repository-brief';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { liveModel } from '@onionsoup/providers';
import { maintenanceCapabilities, type MaintenanceRepository } from './maintenance.ts';
import { implementationCapabilities, ImplementationConfig, type ImplementationRepository } from './implementation.ts';

const Id=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const RepositoryName = BriefRequest.shape.repository;
/** A bare name allows briefs and issue reads; a checkout additionally allows bounded source reads. */
const RepositoryConfig = z.union([RepositoryName, z.object({ name: RepositoryName, checkout: z.string().min(1).optional(), implementation: ImplementationConfig.optional() }).strict()]);
export const CapabilityConfig=z.object({schemaVersion:z.literal(1),provider:z.enum(['copilot','codex']),
  homelab:HomelabMcpConfig.optional(),repositories:z.array(RepositoryConfig).max(100).default([])}).strict()
  .refine(c=>!c.homelab||c.homelab.provider===c.provider,'Provider mismatch');
export const repositoryEntries = (config: CapabilityConfig): (MaintenanceRepository & ImplementationRepository)[] =>
  config.repositories.map((r) => (typeof r === 'string' ? { name: r } : r));
export type CapabilityConfig=z.infer<typeof CapabilityConfig>;
export const HostConfig = z.object({
  schemaVersion: z.literal(1),
  directory: z.string().min(1),
  port: z.number().int().min(0).max(65535).default(8787),
  /** Bind address. Loopback unless the operator says otherwise. */
  address: z.string().min(1).default('127.0.0.1'),
  capabilities: CapabilityConfig,
  /** Serve a built web app and let same-origin browsers act as this invoker. */
  web: z.object({ directory: z.string().min(1), invoker: Id }).strict().optional(),
  /** Trust identity from a local `tailscale serve` proxy: login to invoker. */
  tailscale: z.object({ users: z.array(z.object({ login: z.string().min(3).max(200), invoker: Id }).strict()).min(1).max(100) }).strict().optional(),
  /** Chat policy: whether chat may run interactive capabilities (request, approve, publish) on request. */
  chat: z.object({ interactive: z.boolean().default(true) }).strict().optional(),
  /** Overrides for the host's runtime limits (concurrency, queue, jobs, ...). */
  limits: z.record(z.string(), z.number()).optional(),
  /** Recipe JSON files loaded at launch; recipes saved from the web live in the state directory. */
  recipes: z.array(z.string().min(1)).max(100).default([]),
  invokers: z.array(z.object({
    id: Id,
    /** Required for remote clients; omit for the web invoker. */
    tokenFile: z.string().min(1).optional(),
    capabilities: z.array(z.string()).min(1).max(100),
    maxJobs: z.number().int().min(1).optional(),
  }).strict()).min(1).max(100),
}).strict().refine((c) => !c.web || c.invokers.some((i) => i.id === c.web!.invoker), 'Web invoker must be configured');
export type HostConfig = z.infer<typeof HostConfig>;
export const Investigation=z.object({targetId:Id,run:TriageRun}).strict();
export const Refresh=z.object({sourceId:Id,observation:HomelabObservation}).strict();
export const Brief=z.object({brief:HomelabBrief}).strict();
export const RepoBrief=z.object({brief:z.json(),markdown:z.string().optional()}).strict();
export function resolveCapabilityConfig(raw:unknown,file:string){
  const c=CapabilityConfig.parse(raw);
  if(c.homelab){c.homelab.runsDirectory=resolve(dirname(file),c.homelab.runsDirectory);c.homelab.observations=c.homelab.observations.map(p=>resolve(dirname(file),p));}
  const base=dirname(file);
  c.repositories=c.repositories.map((r)=>{
    if(typeof r==='string')return r;
    const checkout=r.checkout?resolve(base,r.checkout):undefined;
    const implementation=r.implementation?{...r.implementation,profile:resolve(base,r.implementation.profile),runtime:resolve(base,r.implementation.runtime),publication:resolve(base,r.implementation.publication)}:undefined;
    return {...r,...(checkout?{checkout}:{}),...(implementation?{implementation}:{})};
  });
  return c;
}
export function registeredCapabilities(raw:unknown,options:{apiKey?:string; modelFactory?:typeof liveModel;
  investigate?:typeof investigateWorkloads; refresh?:typeof collectRefresh; repositoryBrief?:typeof createRepositoryBrief;
  maintenance?:Omit<Parameters<typeof maintenanceCapabilities>[0],'provider'|'repositories'|'modelFactory'>;
  implementation?:Omit<Parameters<typeof implementationCapabilities>[0],'provider'|'repositories'|'modelFactory'>}={}):Capability[]{
  const config=CapabilityConfig.parse(raw),modelFactory=options.modelFactory??liveModel,result:Capability[]=[];
  const common={version:'v1',timeoutMs:600000};
  if(config.homelab){const h=config.homelab,targets=new Map(h.targets.map(t=>[t.assetId,t])),sources=new Map((h.refreshSources??[]).map(s=>[s.sourceId,s]));
    const metadata={provider:config.provider,model:EVALUATION_MODEL,promptVersion:PROMPT_VERSION,targets:[...targets.keys()],refreshSources:[...sources.values()].map(s=>({sourceId:s.sourceId,kind:s.kind,assetId:s.target.assetId})),savedSources:h.observations.length};
    result.push({ ...common,id:'homelab.investigate',description:'Collect fixed workload evidence and assess selected findings.',
      input:z.object({targetId:Id.refine(id=>targets.has(id),'Unknown target')}).strict(),output:Investigation,metadata,effects:['configured_ssh_reads','model_calls','local_artifacts'],
      execute:async({targetId},ctx)=>({targetId,run:await(options.investigate??investigateWorkloads)(targets.get(targetId)!,{directory:join(ctx.directory,'investigation'),provider:config.provider,modelId:EVALUATION_MODEL,
        modelFactory:async()=>(await modelFactory(EVALUATION_MODEL,config.provider)).model,signal:ctx.signal})}) });
    result.push({...common,id:'homelab.refresh',description:'Refresh one configured source through its fixed read-only collector.',
      input:z.object({sourceId:Id.refine(id=>sources.has(id),'Unknown source')}).strict(),output:Refresh,metadata,effects:['configured_source_reads','local_artifacts'],
      execute:async({sourceId},ctx)=>{const source=sources.get(sourceId)!;return {sourceId,observation:validateRefresh(source,await(options.refresh??collectRefresh)(source,{directory:join(ctx.directory,'source'),signal:ctx.signal,apiKey:options.apiKey}))};} });
    result.push({...common,id:'homelab.brief',description:'Compose configured snapshots and selected owned job results; no implicit refresh.',
      input:z.object({investigationJobIds:z.array(z.uuid()).max(10).default([]),refreshJobIds:z.array(z.uuid()).max(10).default([])}).strict()
        .refine(v=>new Set([...v.investigationJobIds,...v.refreshJobIds]).size===v.investigationJobIds.length+v.refreshJobIds.length,'Duplicate source jobs'),
      output:Brief,validateOutput:raw=>{const r=Brief.parse(raw);renderHomelabBrief(r.brief);return r;},metadata,effects:['local_artifacts'],
      execute:async(input,ctx)=>{let observations=await Promise.all(h.observations.map(p=>readHomelabObservation(p,ctx.signal)));const refreshed:HomelabObservation[]=[];
        for(const id of input.refreshJobIds){const j=await ctx.dependency(id);if(j.capability!=='homelab.refresh')throw Error('Wrong dependency');refreshed.push(Refresh.parse(j.result).observation);}
        const keys=refreshed.map(o=>o.kind+':'+o.assetId);if(new Set(keys).size!==keys.length)throw Error('Duplicate replacement');observations=observations.filter(o=>!keys.includes(o.kind+':'+o.assetId));observations.push(...refreshed);
        for(const id of input.investigationJobIds){const j=await ctx.dependency(id);if(j.capability!=='homelab.investigate')throw Error('Wrong dependency');observations.push(Investigation.parse(j.result).run);}
        ctx.signal.throwIfAborted();return {brief:composeHomelabBrief(observations)};} });
  }
  const entries=repositoryEntries(config);
  if(entries.length){const repositories=entries.map(r=>r.name.toLowerCase());result.push({...common,id:'repository.brief',description:'Collect bounded repository evidence and compose a maintainer brief.',
    input:BriefRequest.refine(r=>repositories.includes(r.repository.toLowerCase())&&Date.parse(r.until)<=Date.now(),'Repository or time window not allowed'),
    output:RepoBrief,outcome:(result)=>{const status=String((result.brief as {status?:string})?.status??'unknown');return {status:status==='completed'?'ok':status==='partial'?'partial':'failed',label:status};},validateOutput:raw=>{const r=RepoBrief.parse(raw);validateRepositoryBrief(r.brief);return r;},
    metadata:{provider:config.provider,model:EVALUATION_MODEL,repositories,maxModelCalls:4,resultContract:'repository-brief-v1',agents:RepoAgentId.options.map(repositoryCapabilityManifest)},effects:['github_reads','model_calls','local_artifacts'],
    execute:async(input,ctx)=>{const brief=await(options.repositoryBrief??createRepositoryBrief)(input,{directory:join(ctx.directory,'analysis'),provider:config.provider,modelFactory,signal:ctx.signal});return {brief,markdown:repositoryBriefMarkdown(brief)};} });}
  result.push(...maintenanceCapabilities({provider:config.provider,repositories:entries,modelFactory,...options.maintenance}));
  result.push(...implementationCapabilities({provider:config.provider,repositories:entries,modelFactory,...options.implementation}));
  return result;
}
