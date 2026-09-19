import { z } from 'zod';
import { FixtureAgentId, inputSchema, resultSchema, POLICY } from './contracts.ts';
import { prompts } from './agents.ts';
export function fixtureCapabilityManifest(id: FixtureAgentId) {
  FixtureAgentId.parse(id);
  const purpose={'scoped-patch':'Propose one allowed text patch for an explicitly accepted owned fixture scope. No direct writes or execution.',
    'change-review':'Review one exact candidate and verification receipts independently of the patch conversation.'};
  const entry={'scoped-patch':'proposeScopedPatch','change-review':'reviewChange'};
  return { schemaVersion: 1, id, capabilityVersion: 1, purpose: purpose[id], promptVersion: prompts[id].version,
    contracts: { inputVersion: 1, resultVersion: 1, runVersion: 1, historicalResultVersions: [],
      inputSchema: z.toJSONSchema(inputSchema(id),{ target:'draft-2020-12' }), resultSchema: z.toJSONSchema(resultSchema(id),{ target:'draft-2020-12' }),
      semanticValidation: 'validateResult enforces allowed files/base hashes or cited after-lines/criteria and successful candidate evidence before review clearance. Semantic quality remains model-assessed.' },
    invocation: { transport:'typescript-function', module:'src/fixture-runner/agents.ts', export:entry[id], signature:'(input, options) => Promise<FixtureAgentRun>',
      requiredOptions:['model','provider','modelId'], optionalOptions:['signal','checkpoint'],
      modelDependency:'Caller-supplied AI SDK LanguageModel, explicitly selected at the application edge.',
      checkpoint:'Awaited admission and final snapshots. Persistence failures propagate; no automatic resume.', source:'Supplied bounded structured evidence only.' },
    lifecycle: { statuses:['running','completed','failed'], cancellation:'Cooperative AbortSignal', durableResume:false, query:'Inspect caller-persisted records.' },
    limits: { steps:POLICY.modelSteps, timeoutMs:POLICY.agentTimeoutMs, inputCharacters:90000 },
    effects: { githubWrites:false, targetCodeExecution:false, modelCalls:true, sourceReads:false,
      persistence:'Through caller checkpoint only.', authority:'Manifest does not authorize invocation or effects.' },
    failures: { beforeAdmission:['invalid_input','persistence_error'], recorded:['provider_error','no_valid_result','interrupted_or_timed_out'],
      unexpectedExceptions:'Propagate; inspect saved state. Unknown is not success.', automaticTaskRetry:false },
    resultMeaning:'Completed means structurally validated supplied-evidence output; it does not establish independent task accuracy or authorize actions.' };
}
