import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import type { Capability } from '@onionsoup/job-host';
import { HomelabConfig, HomelabRegistry, homelabCapabilities } from './homelab.ts';
export { HomelabConfig, HomelabRegistry, homelabCapabilities, investigationMarkdown, assessTrueNas, describeSource } from './homelab.ts';
import { BriefRequest, RepoAgentId, repositoryCapabilityManifest } from '@onionsoup/repository-analysis';
import { createRepositoryBrief, validateRepositoryBrief, repositoryBriefMarkdown } from '@onionsoup/repository-brief';
import type { ModelResolver } from '@onionsoup/providers';
import { maintenanceCapabilities, type MaintenanceRepository } from './maintenance.ts';
import { implementationCapabilities, ImplementationConfig, type ImplementationRepository } from './implementation.ts';
import { RepositoryRegistry } from './registry.ts';
import { onboardingCapabilities } from './onboarding.ts';
import { ModelConfig, ModelRegistry, modelCapabilities, type CatalogReader } from './models.ts';
export { ModelConfig, ModelRegistry, ModelAgentId, MODEL_AGENTS, modelCapabilities, type CatalogReader, type ModelOrigin } from './models.ts';
export { describeEntry } from './onboarding.ts';
export { RepositoryRegistry, onboardRepository, updateRepository, detectProfile } from './registry.ts';

const Id=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const RepositoryName = BriefRequest.shape.repository;
/** A bare name allows briefs and issue reads; a checkout additionally allows bounded source reads. */
const RepositoryConfig = z.union([RepositoryName, z.object({ name: RepositoryName, checkout: z.string().min(1).optional(), implementation: ImplementationConfig.optional() }).strict()]);
export const CapabilityConfig=z.object({schemaVersion:z.literal(2),models:ModelConfig,
  homelab:HomelabConfig.optional(),repositories:z.array(RepositoryConfig).max(100).default([])}).strict()

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
  /** Sandbox runtimes shared by onboarded repositories. */
  sandbox: z.object({ nodeRuntime: z.string().min(1).optional() }).strict().optional(),
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
export const RepoBrief=z.object({brief:z.json(),markdown:z.string().optional()}).strict();
export function resolveCapabilityConfig(raw:unknown,file:string){
  const c=CapabilityConfig.parse(raw);
  if(c.homelab?.truenasApiKeyFile)c.homelab.truenasApiKeyFile=resolve(dirname(file),c.homelab.truenasApiKeyFile);
  const base=dirname(file);
  c.repositories=c.repositories.map((r)=>{
    if(typeof r==='string')return r;
    const checkout=r.checkout?resolve(base,r.checkout):undefined;
    const implementation=r.implementation?{...r.implementation,profile:resolve(base,r.implementation.profile),runtime:resolve(base,r.implementation.runtime),publication:resolve(base,r.implementation.publication)}:undefined;
    return {...r,...(checkout?{checkout}:{}),...(implementation?{implementation}:{})};
  });
  return c;
}
export function registeredCapabilities(raw:unknown,options:{repositoryBrief?:typeof createRepositoryBrief;
  /** Live model assignments; when absent, a fixed registry is built from the configuration. */
  modelRegistry?:ModelRegistry; catalog?:CatalogReader;
  /** Opens each agent's model; defaults to the model registry's resolver. Tests script models here. */
  models?:ModelResolver;
  maintenance?:Omit<Parameters<typeof maintenanceCapabilities>[0],'registry'|'models'>;
  implementation?:Omit<Parameters<typeof implementationCapabilities>[0],'registry'|'models'>;
  /** Live repository registry; when absent, a fixed in-memory registry is built from the configuration. */
  registry?:RepositoryRegistry; onboarding?:Parameters<typeof onboardingCapabilities>[1];
  /** Live homelab source registry; when absent, a fixed one is built from the configuration. */
  homelab?:HomelabRegistry; homelabOptions?:Omit<Parameters<typeof homelabCapabilities>[0],'registry'|'models'>}={}):Capability[]{
  const config=CapabilityConfig.parse(raw),result:Capability[]=[];
  const modelRegistry=options.modelRegistry??ModelRegistry.fixed(config.models);
  const models=options.models??modelRegistry.resolver();
  const common={version:'v1',timeoutMs:600000};
  const homelab=options.homelab??(config.homelab?HomelabRegistry.fixed({directory:'',entries:config.homelab.sources,maxAgeSeconds:config.homelab.maxAgeSeconds,truenasApiKeyFile:config.homelab.truenasApiKeyFile}):undefined);
  if(homelab)result.push(...homelabCapabilities({registry:homelab,models,...options.homelabOptions}));
  const entries=repositoryEntries(config);
  const registry=options.registry??RepositoryRegistry.fixed(entries);
  const repositoriesNow=()=>registry.names().map(r=>r.toLowerCase());
  {result.push({...common,id:'repository.brief',description:'Collect bounded repository evidence and compose a maintainer brief.',
    get input(){return BriefRequest.safeExtend({repository:registry.schema()}).refine(r=>repositoriesNow().includes(r.repository.toLowerCase())&&Date.parse(r.until)<=Date.now(),'Repository or time window not allowed');},
    output:RepoBrief,outcome:(result)=>{const status=String((result.brief as {status?:string})?.status??'unknown');return {status:status==='completed'?'ok':status==='partial'?'partial':'failed',label:status};},validateOutput:raw=>{const r=RepoBrief.parse(raw);validateRepositoryBrief(r.brief);return r;},
    metadata:{agents:RepoAgentId.options,get repositories(){return repositoriesNow();},maxModelCalls:4,resultContract:'repository-brief-v1',manifests:RepoAgentId.options.map(repositoryCapabilityManifest)},effects:['github_reads','model_calls','local_artifacts'],
    execute:async(input,ctx)=>{const brief=await(options.repositoryBrief??createRepositoryBrief)(input,{directory:join(ctx.directory,'analysis'),models,signal:ctx.signal});return {brief,markdown:repositoryBriefMarkdown(brief)};} });}
  result.push(...maintenanceCapabilities({registry,models,...options.maintenance}));
  result.push(...implementationCapabilities({registry,models,...options.implementation}));
  if(options.registry)result.push(...onboardingCapabilities(registry,options.onboarding));
  if(options.modelRegistry)result.push(...modelCapabilities(options.modelRegistry,options.catalog));
  return result;
}
