import { z } from 'zod';
import { IssueSnapshot } from '../contracts.ts';
import { DeliveryRecord } from '../delivery/contracts.ts';
import { hash } from '../repository-brief/contracts.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const base={ requestId:z.uuid(),jobId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),revision:digest };
export const OperatorRequest=z.discriminatedUnion('action',[
  z.object({ ...base,action:z.literal('run_now') }).strict(),
  z.object({ ...base,action:z.literal('pause') }).strict(),
  z.object({ ...base,action:z.literal('resume') }).strict(),
  z.object({ ...base,action:z.literal('retry'),occurrence:DeliveryRecord.shape.occurrence,attempts:z.number().int().min(0).max(2) }).strict(),
  z.object({ ...base,action:z.literal('investigate'),briefId:z.uuid(),briefHash:digest,number:z.number().int().positive() }).strict(),
]);
export type OperatorRequest=z.infer<typeof OperatorRequest>;
export const OperatorRecord=z.object({ schemaVersion:z.literal(1),kind:z.literal('operator-action'),workflowId:z.uuid(),
  request:OperatorRequest,inputHash:digest,startedAt:z.iso.datetime(),finishedAt:z.iso.datetime().optional(),
  status:z.enum(['running','completed','failed']),failure:z.literal('operation_failed').optional(),
  snapshot:IssueSnapshot.optional(),commit:z.string().regex(/^[a-f0-9]{40}$/).optional(),
  result:z.discriminatedUnion('type',[
    z.object({ type:z.literal('delivery'),occurrence:DeliveryRecord.shape.occurrence,workflowId:z.uuid(),status:z.string().max(30) }).strict(),
    z.object({ type:z.literal('packet'),workflowId:z.uuid(),status:z.enum(['completed','partial','failed','running']) }).strict(),
    z.object({ type:z.literal('schedule'),paused:z.boolean() }).strict(),
    z.object({ type:z.literal('skipped'),reason:z.enum(['closed','invalid_snapshot']) }).strict(),
  ]).optional(),
}).strict().superRefine((r,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({ code:'custom',message });
  if(r.workflowId!==r.request.requestId||r.inputHash!==hash(r.request)) fail('Action identity mismatch');
  if((r.status==='running')===!!r.finishedAt || r.status==='completed'&&!r.result || r.status==='failed'&&!r.failure) fail('Action termination mismatch');
  if(r.snapshot && (r.request.action!=='investigate'||r.snapshot.number!==r.request.number)) fail('Snapshot selection mismatch');
  if(r.result && ((r.request.action==='run_now'||r.request.action==='retry') && r.result.type!=='delivery' ||
    (r.request.action==='pause'||r.request.action==='resume') && (r.result.type!=='schedule'||r.result.paused!==(r.request.action==='pause')) ||
    r.request.action==='investigate'&&!['packet','skipped'].includes(r.result.type))) fail('Action result mismatch');
});
export type OperatorRecord=z.infer<typeof OperatorRecord>;
