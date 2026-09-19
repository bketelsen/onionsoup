import { z } from 'zod';
import { RepoAgentId, inputSchema, resultSchema, REPO_BRIEF_LIMITS } from './contracts.ts';
import { prompts } from './agents.ts';
export function repositoryCapabilityManifest(id: RepoAgentId) {
  RepoAgentId.parse(id);
  const purpose = { 'repository-themes': 'Partition a bounded collection of open item titles/labels into evidence-linked themes.',
    'repository-health': 'Explain supplied repository metrics while preserving sampled scope and uncertainty.',
    'maintenance-actions': 'Suggest at most N immediate maintainer actions supported by supplied evidence; never execute them.' };
  const entry = { 'repository-themes': 'summarizeRepositoryThemes', 'repository-health': 'interpretRepositoryHealth', 'maintenance-actions': 'suggestMaintenanceActions' };
  return { schemaVersion: 1, id, capabilityVersion: 2, purpose: purpose[id], promptVersion: prompts[id].version,
    contracts: { inputVersion: 1, resultVersion: 1, runVersion: 1, historicalResultVersions: [],
      inputSchema: z.toJSONSchema(inputSchema(id),{ target:'draft-2020-12' }), resultSchema: z.toJSONSchema(resultSchema(id),{ target:'draft-2020-12' }),
      semanticValidation: 'validateAgentResult enforces complete unique theme membership or valid distinct evidence references and suggestion limit. Semantic support remains model-assessed.' },
    invocation: { transport:'typescript-function', module:'@onionsoup/repository-analysis', export:entry[id], signature:'(input, options) => Promise<RepoAgentRun>',
      requiredOptions:['model','provider','modelId'], optionalOptions:['signal','checkpoint'],
      modelDependency:'Caller-supplied AI SDK LanguageModel, explicitly selected at the application edge.',
      checkpoint:'Awaited admission and final snapshots. Persistence failures propagate; no automatic resume.', source:'Supplied bounded structured evidence only.' },
    lifecycle: { statuses:['running','completed','failed'], cancellation:'Cooperative AbortSignal', durableResume:false, query:'Inspect caller-persisted records.' },
    limits: { steps:REPO_BRIEF_LIMITS.steps, timeoutMs:REPO_BRIEF_LIMITS.agentTimeoutMs, inputCharacters:60000 },
    effects: { githubWrites:false, targetCodeExecution:false, modelCalls:true, sourceReads:false,
      persistence:'Through caller checkpoint only.', authority:'Manifest does not authorize invocation or effects.' },
    failures: { beforeAdmission:['invalid_input','persistence_error'], recorded:['provider_error','no_valid_result','interrupted_or_timed_out'],
      unexpectedExceptions:'Propagate; inspect saved state. Unknown is not success.', automaticTaskRetry:false },
    resultMeaning:'Completed means structurally validated supplied-evidence output; it does not establish independent task accuracy or authorize actions.' };
}
