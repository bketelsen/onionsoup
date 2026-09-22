import { environmentModels } from '@onionsoup/providers';
import { z } from 'zod';
import { scheduleControl } from './control.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJson, optionalJson, readJson } from '@onionsoup/runtime/storage';
import { hash } from '@onionsoup/repository-analysis/contracts';
import { createRepositoryBrief } from '@onionsoup/repository-brief/recipe';
import { validateRepositoryBrief } from '@onionsoup/repository-brief/record';
import { DeliveryConfig, DeliveryRecord, validateBinding, occurrenceId, deliveryStatus } from './contracts.ts';
import { latestOccurrence } from './schedule.ts';
import { bytesHash, composeMail, smtpSender, type MailSender } from './mail.ts';
import { workflowEvents } from './events.ts';
export type DeliveryOptions={ stateDirectory:string; now?:Date; expectedAttempts?:number; sender?:MailSender;
  generate?:typeof createRepositoryBrief; persist?:typeof atomicJson };
const stamp=()=>new Date().toISOString();
const recordPath=(directory:string)=>join(directory,'delivery.json');
export const deliveryDirectory=(c:DeliveryConfig,stateDirectory:string,key:string)=>resolve(stateDirectory,occurrenceId(c,key));
async function locked<T>(directory:string,work:()=>Promise<T>):Promise<T> {
  await mkdir(directory,{ recursive:true,mode:0o700 });
  const lock=join(directory,'.lock');
  await mkdir(lock,{ mode:0o700 }); // EEXIST stops every concurrent mutation, including reconciliation.
  try { return await work(); } finally { await rm(lock,{ recursive:true }); }
}
async function save(directory:string,r:DeliveryRecord,options:DeliveryOptions) {
  DeliveryRecord.parse(r);
  await (options.persist??atomicJson)(recordPath(directory),r);
  await atomicJson(join(directory,'events.json'),workflowEvents(r));
}
async function load(c:DeliveryConfig,directory:string,key:string) {
  return validateBinding(await readJson(recordPath(directory)),c,key);
}
async function prepare(c:DeliveryConfig,directory:string,r:DeliveryRecord,options:DeliveryOptions) {
  if (r.message) return;
  const raw=await optionalJson(join(directory,'brief.json')) ?? await optionalJson(join(directory,'analysis','repository-brief.json'));
  if (!raw) return; // Analysis was interrupted; never replay it from a tick.
  const b=validateRepositoryBrief(raw);
  if (hash(b.request)!==hash(r.request)) throw new Error('Saved analysis request mismatch');
  if (b.status==='failed') { r.analysisFailure={ at:b.finishedAt!,outcome:'failed' }; await save(directory,r,options); return; }
  if (!['completed','partial'].includes(b.status) || !b.snapshot) return;
  if (r.brief && (r.brief.hash!==hash(b) || r.brief.workflowId!==b.workflowId)) throw new Error('Saved brief changed');
  await atomicJson(join(directory,'brief.json'),b);
  const preparedAt=stamp(), id=`<${r.workflowId}@onionsoup.invalid>`;
  const bytes=await composeMail(b,c,id,new Date(preparedAt));
  if (bytes.length>10*1024*1024) throw new Error('Prepared message exceeds 10 MiB');
  const temp=join(directory,`message.${randomUUID()}.tmp`);
  await writeFile(temp,bytes,{ flag:'wx',mode:0o600 });
  await rename(temp,join(directory,'message.eml'));
  r.brief={ workflowId:b.workflowId,hash:hash(b) };
  r.message={ hash:bytesHash(bytes),id,preparedAt };
  await save(directory,r,options);
}
async function send(c:DeliveryConfig,directory:string,r:DeliveryRecord,options:DeliveryOptions,retry:boolean) {
  const status=deliveryStatus(r);
  if (status!=='prepared' && !(retry && status==='rejected')) return;
  if (r.attempts.length>=3) throw new Error('Three-attempt mail allowance exhausted');
  const b=validateRepositoryBrief(await readJson(join(directory,'brief.json'))), bytes=await readFile(join(directory,'message.eml'));
  if (hash(b.request)!==hash(r.request) || hash(b)!==r.brief?.hash || b.workflowId!==r.brief.workflowId || bytesHash(bytes)!==r.message?.hash)
    throw new Error('Frozen artifact changed');
  // Validate environment configuration before intent; errors here cannot send.
  const sender=options.sender??smtpSender(c);
  const attempt:DeliveryRecord['attempts'][number]={ startedAt:stamp(),outcome:'sending' };
  r.attempts.push(attempt);
  await save(directory,r,options); // Must succeed before any SMTP bytes leave.
  try { attempt.outcome=await sender(bytes); } catch { attempt.outcome='unknown'; }
  attempt.finishedAt=stamp();
  await save(directory,r,options); // Failure leaves durable 'sending', interpreted as unknown.
}
function summary(directory:string,r:DeliveryRecord) {
  return { directory,workflowId:r.workflowId,occurrence:r.occurrence,status:deliveryStatus(r),
    attempts:r.attempts.length,briefWorkflowId:r.brief?.workflowId };
}
export async function tick(raw:unknown,options:DeliveryOptions) {
  const c=DeliveryConfig.parse(raw), occurrence=latestOccurrence(c,options.now);
  if ((await scheduleControl(options.stateDirectory,c.jobId)).paused) return { status:'paused' as const };
  if (!occurrence) return { status:'not_due' as const };
  return runOccurrence(c,occurrence,options);
}
export async function runNow(raw:unknown,requestId:string,options:DeliveryOptions) {
  const c=DeliveryConfig.parse(raw); z.uuid().parse(requestId);
  return runOccurrence(c,{ key:`ondemand-${requestId}`,dueAt:(options.now??new Date()).toISOString() },options);
}
async function runOccurrence(c:DeliveryConfig,occurrence:{ key:string;dueAt:string },options:DeliveryOptions) {
  const directory=deliveryDirectory(c,options.stateDirectory,occurrence.key);
  return locked(directory,async()=>{
    const existing=await optionalJson(recordPath(directory));
    let r:DeliveryRecord;
    if (existing) r=validateBinding(existing,c,occurrence.key);
    else {
      const request={ schemaVersion:1 as const,repository:c.repository,until:occurrence.dueAt,
        since:new Date(Date.parse(occurrence.dueAt)-c.days*86400000).toISOString(),maxSuggestions:c.maxSuggestions };
      r=DeliveryRecord.parse({ schemaVersion:1,kind:'brief-delivery',workflowId:randomUUID(),jobId:c.jobId,
        occurrence:occurrence.key,dueAt:occurrence.dueAt,createdAt:stamp(),configHash:hash(c),request,attempts:[] });
      await save(directory,r,options);
      // Generation owns its own initial/final checkpoints. No retry can re-enter here.
      await (options.generate??createRepositoryBrief)(request,{ directory:join(directory,'analysis'),models:environmentModels(c.provider) });
    }
    await prepare(c,directory,r,options);
    await send(c,directory,r,options,false);
    return summary(directory,r);
  });
}
export async function prepareSaved(raw:unknown,brief:unknown,options:DeliveryOptions) {
  const c=DeliveryConfig.parse(raw), b=validateRepositoryBrief(brief), key=`manual-${b.workflowId}`;
  if (b.request.repository!==c.repository || !['completed','partial'].includes(b.status) || !b.snapshot) throw new Error('Unusable saved brief');
  const directory=deliveryDirectory(c,options.stateDirectory,key);
  return locked(directory,async()=>{
    const existing=await optionalJson(recordPath(directory));
    const r=existing?validateBinding(existing,c,key):DeliveryRecord.parse({ schemaVersion:1,kind:'brief-delivery',
      workflowId:randomUUID(),jobId:c.jobId,occurrence:key,dueAt:b.request.until,createdAt:stamp(),configHash:hash(c),request:b.request,brief:{ workflowId:b.workflowId,hash:hash(b) },attempts:[] });
    if (existing) {
      const frozen=await optionalJson(join(directory,'brief.json'));
      if (r.brief?.hash!==hash(b) || frozen && hash(frozen)!==hash(b)) throw new Error('Saved brief identity was reused with different content');
      if (!frozen) await atomicJson(join(directory,'brief.json'),b);
    } else {
      await save(directory,r,options);
      await atomicJson(join(directory,'brief.json'),b);
    }
    await prepare(c,directory,r,options);
    return summary(directory,r);
  });
}
export async function deliver(raw:unknown,key:string,options:DeliveryOptions) {
  const c=DeliveryConfig.parse(raw), directory=deliveryDirectory(c,options.stateDirectory,key);
  return locked(directory,async()=>{
    const r=await load(c,directory,key);
    if(options.expectedAttempts!==undefined && r.attempts.length!==options.expectedAttempts) throw new Error('Delivery attempt precondition changed');
    await prepare(c,directory,r,options);
    await send(c,directory,r,options,true);
    return summary(directory,r);
  });
}
export async function reconcile(raw:unknown,key:string,outcome:'accepted'|'not_accepted',evidence:string,options:DeliveryOptions) {
  const c=DeliveryConfig.parse(raw), directory=deliveryDirectory(c,options.stateDirectory,key);
  return locked(directory,async()=>{
    const r=await load(c,directory,key), a=r.attempts.at(-1);
    if (!a || deliveryStatus(r)!=='unknown') throw new Error('Only an ambiguous attempt can be reconciled');
    a.resolution={ at:stamp(),outcome,evidence };
    await save(directory,r,options);
    return summary(directory,r);
  });
}
export async function inspect(raw:unknown,key:string,stateDirectory:string) {
  const c=DeliveryConfig.parse(raw), directory=deliveryDirectory(c,stateDirectory,key), r=await load(c,directory,key);
  return { ...summary(directory,r),events:workflowEvents(r) };
}
