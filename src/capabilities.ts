import { z } from 'zod';
import { IssueSnapshot, Assessment } from './contracts.ts';
import { LIMITS } from './triage.ts';
import { LocationInput, CurrentLocationBrief, LOCATION_LIMITS } from './location-contracts.ts';
import { PROMPT_VERSION } from './prompt.ts';
import { LOCATION_PROMPT_VERSION } from './location-prompt.ts';

export const AgentId = z.enum(['bug-readiness', 'code-location']);
export type AgentId = z.infer<typeof AgentId>;
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'draft-2020-12' });
// Descriptions never grant capabilities. The existing host validators enforce semantics.
export function capabilityManifest(id: AgentId) {
  AgentId.parse(id);
  const readiness = id === 'bug-readiness';
  return {
    schemaVersion: 1, id, capabilityVersion: readiness ? 2 : 3,
    purpose: readiness ? 'Classify one issue snapshot and assess bug-report investigation readiness without acceptance decisions.'
      : 'Locate code and model-assessed relevant tests for one matching ready bug at a pinned commit.',
    promptVersion: readiness ? PROMPT_VERSION : LOCATION_PROMPT_VERSION,
    contracts: { inputVersion: 1, resultVersion: readiness ? 2 : 3, runVersion: readiness ? 2 : 3,
      historicalResultVersions: readiness ? [1] : [1, 2],
      inputSchema: schema(readiness ? IssueSnapshot : LocationInput),
      resultSchema: schema(readiness ? Assessment : CurrentLocationBrief),
      semanticValidation: readiness ? 'validateAssessment additionally enforces exact issue evidence and readiness invariants.'
        : 'resolveBrief and validateLocationRun additionally enforce handoff identity, inspected-source grounding, outcome invariants, and canonical overview. Relevance remains model-assessed.' },
    invocation: { transport: 'typescript-function', module: readiness ? 'src/triage.ts' : 'src/location-agent.ts',
      export: readiness ? 'triage' : 'locateCode', signature: readiness ? '(input, options) => Promise<RunRecord>' : '(input, options) => Promise<LocationRun>',
      requiredOptions: readiness ? ['model', 'provider', 'modelId'] : ['model', 'provider', 'modelId', 'checkout'],
      optionalOptions: ['signal', 'checkpoint'],
      modelDependency: 'Caller-supplied AI SDK LanguageModel, selected explicitly at the application edge.',
      checkpoint: 'Caller owns persistence; awaited admission and final snapshots. Failure prevents further work or propagates. No per-step resume.',
      source: readiness ? 'Supplied issue title/body only.' : 'Caller-acquired local Git checkout or bare clone with matching GitHub origin and pinned commit.' },
    lifecycle: { statuses: ['running', 'completed', 'failed'], cancellation: 'Cooperative AbortSignal',
      durableResume: false, query: 'Inspect caller-persisted run records; no polling service.' },
    limits: readiness ? { ...LIMITS } : { ...LOCATION_LIMITS },
    effects: { githubWrites: false, targetCodeExecution: false, modelCalls: true,
      sourceReads: !readiness, persistence: 'Through caller checkpoint only.', authority: 'Manifest does not authorize invocation or effects.' },
    failures: { beforeAdmission: ['invalid_input', 'persistence_error', ...readiness ? [] : ['source_unavailable']],
      recorded: readiness ? ['provider_error', 'no_valid_assessment', 'interrupted_or_timed_out']
        : ['provider_error', 'no_valid_brief', 'interrupted_or_timed_out', 'execution_error'],
      unexpectedExceptions: 'Propagate to caller; inspect persisted artifacts before deliberately retrying. Unknown outcome is not success.',
      automaticTaskRetry: false },
    resultMeaning: readiness ? 'Completed means a validated assessment, including non-bug or needs-information outcomes.'
      : 'Completed means a validated brief, including not_located. Direct/adjacent relevance and search completion do not prove coverage or diagnosis.',
  };
}
export function capabilityCatalog() {
  return { schemaVersion: 1, eventSchema: 'capabilities/workflow-events.schema.json', agents: AgentId.options.map(id => ({ id, manifest: `capabilities/${id}.json`,
    capabilityVersion: capabilityManifest(id).capabilityVersion })) };
}
