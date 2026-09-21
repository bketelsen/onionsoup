export * from '@onionsoup/maintenance/proposal/recipe';
import { createChangeProposal as create, renderChangeProposal as render } from '@onionsoup/maintenance/proposal/recipe';
import { workflowEvents } from '../workflow-events.ts';
// Legacy consumers keep deriving events.json; the package recipe takes it as an option.
export const createChangeProposal: typeof create = (raw, options) => create(raw, { events: workflowEvents, ...options });
export const renderChangeProposal = (directory: string) => render(directory, workflowEvents);
