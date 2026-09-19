import { z } from 'zod';
import { isAbsolute, resolve, dirname } from 'node:path';
import { readJson } from '../batch-store.ts';
import { DeliveryConfig } from '../delivery/contracts.ts';
import { Commit } from '../location-contracts.ts';
import { hash } from '../repository-brief/contracts.ts';
export const ConsoleConfig=z.object({ schemaVersion:z.literal(1),stateDirectory:z.string().min(1),fixtureRoots:z.array(z.string().min(1)).max(10).default([]),
  jobs:z.array(z.object({ id:DeliveryConfig.shape.jobId,deliveryConfig:z.string().min(1),deliveryState:z.string().min(1),
    briefRoots:z.array(z.string().min(1)).max(10).default([]),inboxDirectory:z.string().min(1).optional(),
    timerUnit:z.string().regex(/^[a-zA-Z0-9_-]+\.timer$/).optional(),
    source:z.object({ checkout:z.string().min(1),commit:Commit }).strict().optional() }).strict()).min(1).max(10),
}).strict().refine(c=>new Set(c.jobs.map(j=>j.id)).size===c.jobs.length,'Duplicate console job IDs');
export type ConsoleConfig=z.infer<typeof ConsoleConfig>;
export type Job=ConsoleConfig['jobs'][number] & { config:DeliveryConfig;revision:string };
export async function loadConsoleConfig(file:string) {
  const c=ConsoleConfig.parse(await readJson(file)), base=dirname(resolve(file));
  const path=(p:string)=>isAbsolute(p)?p:resolve(base,p);
  return { ...c,stateDirectory:path(c.stateDirectory),fixtureRoots:c.fixtureRoots.map(path),jobs:c.jobs.map(j=>({ ...j,deliveryConfig:path(j.deliveryConfig),
    deliveryState:path(j.deliveryState),briefRoots:j.briefRoots.map(path),inboxDirectory:j.inboxDirectory?path(j.inboxDirectory):undefined,
    source:j.source?{ ...j.source,checkout:path(j.source.checkout) }:undefined })) };
}
export async function loadJob(c:ConsoleConfig,id:string):Promise<Job> {
  const entry=c.jobs.find(j=>j.id===id); if(!entry) throw new Error('Unknown job');
  const config=DeliveryConfig.parse(await readJson(entry.deliveryConfig));
  return { ...entry,config,revision:hash({ entry,config }) };
}
