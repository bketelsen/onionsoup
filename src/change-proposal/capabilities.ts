import { z } from 'zod';
import { ProposalAgentId, inputSchema, resultSchema, LIMITS } from './contracts.ts';
import { prompts } from './agents.ts';
export function proposalCapabilityManifest(id: ProposalAgentId) {
  ProposalAgentId.parse(id);
  const purpose = { 'feature-requirements':'Extract reported requirements and open questions for one feature request.',
    'change-proposal':'Draft one evidence-linked bug or feature proposal without scope acceptance, execution or writes.' };
  const entry = { 'feature-requirements':'extractFeatureRequirements','change-proposal':'draftChangeProposal' };
  return { schemaVersion: 1, id, capabilityVersion: 1, purpose: purpose[id], promptVersion: prompts[id].version,
    contracts: { inputVersion: 1, resultVersion: 1, runVersion: 1, historicalResultVersions: [],
      inputSchema: z.toJSONSchema(inputSchema(id),{ target:'draft-2020-12' }), resultSchema: z.toJSONSchema(resultSchema(id),{ target:'draft-2020-12' }),
      semanticValidation: 'validateResult enforces evidence IDs, blocking questions, criterion coverage and kind-specific verification profiles. Semantic support remains model-assessed.' },
    invocation: { transport:'typescript-function', module:'src/change-proposal/agents.ts', export:entry[id], signature:'(input, options) => Promise<ProposalAgentRun>',
      requiredOptions:['model','provider','modelId'], optionalOptions:['signal','checkpoint'],
      modelDependency:'Caller-supplied AI SDK LanguageModel, explicitly selected at the application edge.',
      checkpoint:'Awaited admission and final snapshots. Persistence failures propagate; no automatic resume.', source:'Supplied bounded structured evidence only.' },
    lifecycle: { statuses:['running','completed','failed'], cancellation:'Cooperative AbortSignal', durableResume:false, query:'Inspect caller-persisted records.' },
    limits: { steps:LIMITS.steps, timeoutMs:LIMITS.agentTimeoutMs, inputCharacters:60000 },
    effects: { githubWrites:false, targetCodeExecution:false, modelCalls:true, sourceReads:false,
      persistence:'Through caller checkpoint only.', authority:'Manifest does not authorize invocation or effects.' },
    failures: { beforeAdmission:['invalid_input','persistence_error'], recorded:['provider_error','no_valid_result','interrupted_or_timed_out'],
      unexpectedExceptions:'Propagate; inspect saved state. Unknown is not success.', automaticTaskRetry:false },
    resultMeaning:'Completed means structurally validated supplied-evidence output; it does not establish independent task accuracy or authorize actions.' };
}
