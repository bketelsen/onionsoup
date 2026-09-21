import {WorkflowEventExport} from '@onionsoup/runtime/events';
import {validateBundle,validateState} from './contracts.ts';
export function publicationEvents(bundle:unknown,state:unknown) {
  const b=validateBundle(bundle),s=validateState(state,b);
  return WorkflowEventExport.parse({schemaVersion:1,kind:'workflow-events',mode:'derived-snapshot',workflowId:b.workflowId,
    events:s.events.map(event=>({schemaVersion:1,workflowId:b.workflowId,sequence:event.sequence,at:event.at,type:`publication.${event.type}`,
      parentWorkflowId:(b.schemaVersion===1?b.fixture:b.project).workflowId,publicationId:b.publicationId,inputHash:s.bundleHash,repositoryCommit:b.target.baseCommit,publicationReason:event.reason}))});
}
