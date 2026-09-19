import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, optionalJson } from '../batch-store.ts';
import { hash } from '../repository-brief/contracts.ts';
import { DeliveryConfig } from './contracts.ts';
const Control=z.object({ schemaVersion:z.literal(1),jobId:DeliveryConfig.shape.jobId,paused:z.boolean(),updatedAt:z.iso.datetime() }).strict();
const path=(state:string,jobId:string)=>join(state,'controls',`${hash(jobId)}.json`);
export async function scheduleControl(state:string,jobId:string) {
  DeliveryConfig.shape.jobId.parse(jobId);
  const raw=await optionalJson(path(state,jobId));
  if (!raw) return { schemaVersion:1 as const,jobId,paused:false,updatedAt:null };
  const c=Control.parse(raw); if(c.jobId!==jobId) throw new Error('Schedule identity mismatch'); return c;
}
export async function setSchedulePaused(state:string,jobId:string,paused:boolean) {
  const c=Control.parse({ schemaVersion:1,jobId,paused,updatedAt:new Date().toISOString() });
  await atomicJson(path(state,jobId),c); return c;
}
