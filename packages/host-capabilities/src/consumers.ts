import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobClient } from '@onionsoup/job-host/client';
import { findingCounts } from '@onionsoup/workload-triage';
import { renderHomelabBrief } from '@onionsoup/homelab-brief';
import { Investigation, Refresh, Brief } from './index.ts';

// Compatibility projection for the existing reviewed chat profile; no MCP server needed.
export function homelabJobCaller(client:JobClient,correlationId?:string){
  return async(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<{structuredContent?:any;isError?:boolean}>=>{
    const reply=(structuredContent:unknown)=>({structuredContent});
    if(name==='discover_homelab'){
      const catalog=await client.discover(signal);const capability=catalog.capabilities.find((c:any)=>c.id==='homelab.investigate');
      if(!capability)throw Error('Unavailable');return reply({schemaVersion:1,...capability.metadata});
    }
    const operations:Record<string,string>={investigate_workload_findings:'homelab.investigate',refresh_homelab_source:'homelab.refresh',create_homelab_brief:'homelab.brief'};
    if(operations[name]){const r=await client.submit({capability:operations[name],input:z.json().parse(args),idempotencyKey:randomUUID(),...(correlationId?{correlationId}:{})},signal);return reply({schemaVersion:1,jobId:r.jobId,status:'admitted'});}
    const jobId=z.uuid().parse(args.jobId);
    if(name==='cancel_homelab_job')return reply(await client.cancel(jobId,signal));
    if(!['inspect_homelab_job','inspect_workload_finding'].includes(name))throw Error('Unknown operation');
    const j=await client.inspect(jobId,signal),status=['queued','running'].includes(j.status)?'running':j.status==='completed'?'settled':j.status==='interrupted'?'unfinished':'execution_failed';
    if(j.status!=='completed')return reply({schemaVersion:1,jobId,status});
    if(j.capability==='homelab.investigate'){
      const {run:r}=Investigation.parse(j.result);
      const base={schemaVersion:1,jobId,status,runId:r.runId,resultStatus:r.status,sourceRunId:r.input.runId,observedAt:r.input.startedAt,sourceFinishedAt:r.input.finishedAt,sourceStatus:r.input.status,assessedAt:r.startedAt,eligible:r.input.eligible,omitted:r.input.omitted};
      if(name==='inspect_workload_finding'){const finding=r.result?.findings.find(f=>f.podId===args.podId);if(!finding)throw Error('Unknown finding');return reply({...base,finding,facts:r.input.facts.filter(f=>finding.evidenceIds.includes(f.id))});}
      return reply({...base,findings:r.result?.findings??[],findingCounts:r.result?findingCounts(r.result):null,tokenUsage:r.tokenUsage??null,...(r.failure?{failure:r.failure}:{})});
    }
    if(name==='inspect_workload_finding')throw Error('Wrong result');
    if(j.capability==='homelab.refresh'){const {observation}=Refresh.parse(j.result);return reply({schemaVersion:1,jobId,status,runId:observation.runId,resultStatus:observation.status,observation});}
    if(j.capability!=='homelab.brief')throw Error('Wrong result');
    const {brief:b}=Brief.parse(j.result);return reply({schemaVersion:1,jobId,status,runId:b.runId,markdown:renderHomelabBrief(b),generatedAt:b.generatedAt,
      sources:b.sources.map(({observation:o,freshness})=>({assetId:o.assetId,kind:o.kind,runId:o.runId,status:o.status,observedAt:o.kind==='workload-triage'?o.input.startedAt:o.startedAt,finishedAt:(o.kind==='workload-triage'?o.input.finishedAt:o.finishedAt)??null,freshnessAtGeneration:freshness}))});
  };
}
