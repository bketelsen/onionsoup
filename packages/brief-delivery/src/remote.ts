import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digest } from '@onionsoup/job-host';
import type { JobClient } from '@onionsoup/job-host/client';
import { createRepositoryBrief, validateRepositoryBrief } from '@onionsoup/repository-brief';
import { atomicJson, readJson } from '@onionsoup/runtime/storage';
import { DeliveryRecord } from './contracts.ts';
const RepoBrief=z.object({brief:z.json()}).strict();
export function remoteBriefGenerator(client:JobClient):typeof createRepositoryBrief {
  return async(request,options)=>{
    const catalog=await client.discover(options.signal),capability=catalog.capabilities.find((c:any)=>c.id==='repository.brief');
    if(!capability||capability.metadata.provider!==options.provider)throw Error('Provider mismatch');
    await mkdir(options.directory,{mode:0o700});
    const parent=DeliveryRecord.parse(await readJson(join(options.directory,'..','delivery.json')));
    if(digest(parent.request)!==digest(request))throw Error('Delivery request mismatch');
    const correlationId=parent.workflowId,idempotencyKey=digest({workflowId:parent.workflowId,request});
    await atomicJson(join(options.directory,'host-job.json'),{schemaVersion:1,capability:'repository.brief',idempotencyKey,correlationId,binding:catalog.binding,status:'intent'});
    const submitted=await client.submit({capability:'repository.brief',input:z.json().parse(request),idempotencyKey,correlationId},options.signal);
    await atomicJson(join(options.directory,'host-job.json'),{schemaVersion:1,jobId:submitted.jobId,idempotencyKey,correlationId,binding:catalog.binding,status:'admitted'});
    const job=await client.wait(submitted.jobId,options.signal);if(job.status!=='completed')throw Error('Remote analysis unfinished');
    const brief=validateRepositoryBrief(RepoBrief.parse(job.result).brief);
    if(digest(brief.request)!==digest(request)||brief.execution.provider!==options.provider)throw Error('Remote result mismatch');
    await atomicJson(join(options.directory,'repository-brief.json'),brief);return brief;
  };
}
