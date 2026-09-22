/**
 * What a job or turn error means to a person. Errors arrive as `code` or `code:detail`; the code keys this
 * table, the detail is shown after it. Anything that is not a code is an unexpected error, shown with its
 * original text behind a disclosure.
 */
const MEANINGS: Record<string, string> = {
  timeout: 'The job ran past its deadline.',
  cancelled: 'The job was cancelled.',
  interrupted: 'The host restarted while this was running. It is never replayed automatically.',
  queue_full: 'The host queue is full. Try again when some jobs finish.',
  admission_limit: 'This invoker has used its admissions.',
  capability_not_allowed: 'This invoker is not granted that capability.',
  interactive_capability: 'That capability needs a person to submit it from its run form.',
  dependency_unavailable: 'The job this one builds on has not completed.',
  dependency_not_readiness: 'Pick a completed readiness assessment.',
  dependency_not_packet: 'Pick a completed investigation packet.',
  dependency_not_proposal: 'Pick a completed change proposal.',
  dependency_not_approval: 'Pick a completed approval or change request.',
  dependency_not_implementation: 'Pick a completed implementation.',
  readiness_not_eligible: 'The issue is not a bug report that is ready to locate.',
  proposal_not_completed: 'The proposal did not complete.',
  proposal_not_ready: 'The proposal asked for more information. Add an override note to proceed anyway.',
  project_proposal_needs_information: 'The implementation agents need more information before they can change code.',
  project_proposal_failed: 'The implementation proposal agent failed.',
  profile_changed_since_approval: 'The repository profile changed after this was approved. Approve again.',
  files_outside_profile: 'Some files are outside what the repository profile allows.',
  too_many_files: 'Too many files for this repository profile.',
  no_allowed_files: 'None of the cited files are editable under the repository profile.',
  no_acceptance_criteria: 'The proposal has no acceptance criteria to verify against.',
  no_implementation_profile: 'This repository is not set up for implementation.',
  file_not_at_base: 'A listed file does not exist at the base commit.',
  candidate_not_verified: 'The candidate did not pass verification, so it cannot be published.',
  publication_target_missing: 'No publication target is configured for this repository.',
  execution_failed: 'The sandbox run failed.',
  no_checkout_configured: 'This repository has no local checkout configured.',
  repository_not_registered: 'That repository is not registered on this host.',
  repository_fixed_by_config: 'This repository comes from the host config and cannot be edited here.',
  source_fixed_by_config: 'This source comes from the host config and cannot be edited here.',
  nothing_observed_yet: 'Nothing has been collected from this source yet. Refresh it first.',
  provider_signed_out: 'The model provider is not signed in.',
  model_not_in_catalog: 'That model is not in the provider catalog.',
  turn_active: 'A turn is already running in this conversation.',
  session_not_found: 'That conversation does not exist.',
  job_not_found: 'That job does not exist.',
  result_too_large: 'The result was larger than the host keeps.',
  persistence_failed: 'The host could not save the result.',
  invalid_input: 'The input does not match the form.',
  provider_initialization_failed: 'The model provider is not signed in. Set ONIONSOUP_AUTH_PATH or run the provider login.',
  provider_request_failed: 'The model provider rejected the request.',
  step_limit_exceeded: 'The turn ran out of steps before answering.',
  answer_not_submitted: 'The model finished without submitting an answer.',
  cancelled_or_timed_out: 'The turn was cancelled or timed out.',
};

export type Reason = { code: string; meaning: string; detail?: string; isUnexpected: boolean; step?: string };

const CODED = /^([a-z][a-z0-9_]*)(?::\s*(.*))?$/s;
const STEP = /^step ([a-z][a-z0-9-]*): (.*)$/s;

/** Explain one error string. Recipe errors ("step locate: code") name the step that failed. */
export function explain(error: string): Reason {
  const step = STEP.exec(error);
  if (step) return { ...explain(step[2]), step: step[1] };
  const coded = CODED.exec(error.trim());
  if (!coded) return { code: 'unexpected_error', meaning: 'Unexpected error.', detail: error, isUnexpected: true };
  const [, code, detail] = coded;
  return { code, meaning: MEANINGS[code] ?? code.replaceAll('_', ' '), detail: detail || undefined, isUnexpected: false };
}

/** One line for lists: the meaning, plus the step when a recipe step failed. */
export function summarizeError(error: string) {
  const reason = explain(error);
  return reason.step ? `Step ${reason.step}: ${reason.meaning}` : reason.meaning;
}
