import { DeliveryRecord } from './contracts.ts';
import { WorkflowEvent, WorkflowEventExport } from '@onionsoup/runtime/events';
export function workflowEvents(raw: unknown) {
    const r=DeliveryRecord.parse(raw), events:WorkflowEvent[]=[];
    const add=(event:Omit<WorkflowEvent,'schemaVersion'|'workflowId'|'sequence'>)=>events.push(WorkflowEvent.parse({
      ...event,schemaVersion:1,workflowId:r.workflowId,sequence:events.length }));
    add({ type:'workflow.started',at:r.createdAt });
    if (r.analysisFailure) add({ type:'workflow.failed',at:r.analysisFailure.at,failure:'execution_error' });
    if (r.message) add({ type:'delivery.prepared',at:r.message.preparedAt,parentWorkflowId:r.brief!.workflowId,inputHash:r.message.hash });
    for (const [index,a] of r.attempts.entries()) {
      const base={ deliveryAttempt:index+1,parentWorkflowId:r.brief!.workflowId,inputHash:r.message!.hash };
      add({ ...base,type:'delivery.attempted',at:a.startedAt });
      add({ ...base,type:a.outcome==='sending'?'delivery.unknown':`delivery.${a.outcome}`,at:a.finishedAt??a.startedAt });
      if (a.resolution) add({ ...base,type:'delivery.reconciled',at:a.resolution.at,deliveryResolution:a.resolution.outcome });
    }
    return WorkflowEventExport.parse({ schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId:r.workflowId,events });
}
