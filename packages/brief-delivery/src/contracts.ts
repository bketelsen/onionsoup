import { z } from 'zod';
import { BriefRequest, hash } from '@onionsoup/repository-analysis/contracts';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
// Deliberately a single ASCII mailbox, never a display-name/address list.
const Mailbox = z.string().max(254).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/);
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const DeliveryConfig = z.object({
  schemaVersion:z.literal(1), jobId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  repository:BriefRequest.shape.repository, provider:z.enum(['copilot','codex']),
  days:z.number().int().min(1).max(90), maxSuggestions:z.number().int().min(0).max(10),
  schedule:z.object({ timeZone:z.string().max(100).refine(value => {
    try { new Intl.DateTimeFormat('en-US',{ timeZone:value }); return true; } catch { return false; }
  }), time:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
    weekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(v=>new Set(v).size===v.length),
    catchUpHours:z.number().int().min(1).max(24) }).strict(),
  from:Mailbox, to:Mailbox,
  smtp:z.object({ host:z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/), port:z.number().int().min(1).max(65535),
    security:z.enum(['tls','starttls','loopback']),
    auth:z.object({ userEnv:EnvName, passwordEnv:EnvName }).strict().optional() }).strict(),
}).strict().superRefine((c,ctx)=>{
  if (c.smtp.security==='loopback' && (!['127.0.0.1','::1'].includes(c.smtp.host) || c.smtp.auth))
    ctx.addIssue({ code:'custom',message:'Plaintext relay requires loopback IP and no authentication' });
});
export type DeliveryConfig = z.infer<typeof DeliveryConfig>;
export const DeliveryRecord = z.object({
  schemaVersion:z.literal(1), kind:z.literal('brief-delivery'), workflowId:z.uuid(),
  jobId:DeliveryConfig.shape.jobId, occurrence:z.string().regex(/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|(?:manual|ondemand)-[a-f0-9-]{36})$/),
  dueAt:z.iso.datetime(), createdAt:z.iso.datetime(), configHash:Digest, request:BriefRequest,
  analysisFailure:z.object({ at:z.iso.datetime(),outcome:z.literal('failed') }).strict().optional(),
  brief:z.object({ workflowId:z.uuid(), hash:Digest }).strict().optional(),
  message:z.object({ hash:Digest, id:z.string().regex(/^<[a-f0-9-]{36}@onionsoup\.invalid>$/), preparedAt:z.iso.datetime() }).strict().optional(),
  attempts:z.array(z.object({ startedAt:z.iso.datetime(), finishedAt:z.iso.datetime().optional(),
    outcome:z.enum(['sending','accepted','rejected','unknown']),
    resolution:z.object({ at:z.iso.datetime(), outcome:z.enum(['accepted','not_accepted']), evidence:z.string().trim().min(1).max(500) }).strict().optional(),
  }).strict()).max(3),
}).strict().superRefine((r,ctx)=>{
  const bad = (message:string)=>ctx.addIssue({ code:'custom',message });
  if (r.analysisFailure && (r.brief || r.message || r.attempts.length)) bad('Failed analysis cannot send');
  if (r.message && !r.brief || r.attempts.length && !r.message) bad('Missing effect prerequisites');
  if (r.message && r.message.id!==`<${r.workflowId}@onionsoup.invalid>`) bad('Message identity mismatch');
  if (r.brief && r.occurrence.startsWith('manual-') && r.occurrence!==`manual-${r.brief.workflowId}`) bad('Manual brief identity mismatch');
  for (const [i,a] of r.attempts.entries()) {
    if (a.finishedAt && Date.parse(a.finishedAt)<Date.parse(a.startedAt)) bad('Attempt timestamps reversed');
    if ((a.outcome==='sending') === !!a.finishedAt) bad('Attempt completion mismatch');
    if (a.resolution && !['unknown','sending'].includes(a.outcome)) bad('Only ambiguous attempts can be reconciled');
    if (i<r.attempts.length-1 && a.outcome!=='rejected' && a.resolution?.outcome!=='not_accepted') bad('Unsafe retry history');
  }
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;
export function deliveryStatus(r:DeliveryRecord) {
  const a=r.attempts.at(-1);
  return a?.resolution ? a.resolution.outcome==='accepted'?'accepted':'rejected' :
    a ? a.outcome==='sending'?'unknown':a.outcome : r.message?'prepared':r.analysisFailure?'analysis_failed':'analysis_unfinished';
}
export function validateBinding(raw:unknown, config:DeliveryConfig, occurrence:string) {
  const r=DeliveryRecord.parse(raw);
  if (r.jobId!==config.jobId || r.occurrence!==occurrence || r.configHash!==hash(config) || r.request.repository!==config.repository)
    throw new Error('Delivery configuration or identity mismatch');
  if (!occurrence.startsWith('manual-') && (r.request.until!==r.dueAt || r.request.since!==new Date(Date.parse(r.dueAt)-config.days*86400000).toISOString() || r.request.maxSuggestions!==config.maxSuggestions))
    throw new Error('Scheduled request mismatch');
  return r;
}
export const occurrenceId = (c:DeliveryConfig,key:string)=>hash([c.jobId,key]);
