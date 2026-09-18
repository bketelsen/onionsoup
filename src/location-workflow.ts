import { validateLocationRun } from './location-record.ts';
export { validateLocationRun } from './location-record.ts';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocationInput, Commit } from './location-contracts.ts';
import { locateCode, locationRuntimeHash, type LocationRun } from './location-agent.ts';
import { LOCATION_PROMPT_VERSION } from './location-prompt.ts';
import { loadConfig, loadIndex, loadAttempts, latestAttempt, contentHash, withInboxLock, type Observation } from './inbox-store.ts';
import { atomicJson, optionalJson } from './batch-store.ts';
import { liveModel } from './providers.ts';
import { EVALUATION_MODEL } from './evaluation-policy.ts';
import { validateAssessment, type IssueSnapshot } from './contracts.ts';
import { inputHash, type RunRecord } from './triage.ts';

export function makeLocationInput(parent: RunRecord, observation: Observation, commit: string): LocationInput {
  if (observation.state !== 'open' || !observation.snapshot || parent.status !== 'completed' ||
      parent.inputHash !== inputHash(parent.input) || contentHash(parent.input) !== contentHash(observation.snapshot))
    throw new Error('INELIGIBLE_HANDOFF: require a matching completed assessment for an observed open issue');
  const assessment = validateAssessment(parent.assessment, parent.input);
  return LocationInput.parse({ schemaVersion: 1, issue: parent.input,
    parent: { runId: parent.runId, inputHash: parent.inputHash, promptVersion: parent.promptVersion,
      kind: assessment.kind, bug_readiness: assessment.bug_readiness, summary: assessment.summary },
    repository: { name: parent.input.repository, commit } });
}
export function locationKey(input: LocationInput, provider: string, model: string, runtimeHash: string, promptVersion = LOCATION_PROMPT_VERSION) {
  return createHash('sha256').update(JSON.stringify([input.parent.runId, input.parent.inputHash, input.repository,
    provider, model, promptVersion, runtimeHash])).digest('hex');
}
export function locationFilename(run: LocationRun) {
  return `${locationKey(run.input, run.provider, run.model, run.runtimeHash, run.promptVersion)}-${run.runId}.json`;
}
export async function loadLocationRuns(directory: string): Promise<LocationRun[]> {
  let files: string[];
  try { files = await readdir(join(directory, 'locations')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const runs: LocationRun[] = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    const run = validateLocationRun(await optionalJson(join(directory, 'locations', file)));
    if (file !== locationFilename(run)) throw new Error('Location filename identity mismatch');
    runs.push(run);
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export function attachedLocation(runs: LocationRun[], parent: RunRecord | undefined, snapshot: IssueSnapshot | undefined) {
  if (!parent || !snapshot || contentHash(parent.input) !== contentHash(snapshot)) return undefined;
  return runs.filter(r => r.input.parent.runId === parent.runId && r.input.parent.inputHash === parent.inputHash &&
    contentHash(r.input.issue) === contentHash(snapshot)).at(-1);
}
export async function locateInboxIssues(directory: string, checkout: string, commit: string, numbers: number[], options: {
  retry?: boolean; signal?: AbortSignal; modelFactory?: typeof liveModel; onProgress?: (message: string) => void;
} = {}) {
  Commit.parse(commit);
  if (!numbers.length || numbers.length > 3 || new Set(numbers).size !== numbers.length || numbers.some(n => !Number.isSafeInteger(n) || n < 1))
    throw new Error('Select 1–3 distinct positive issue numbers');
  return withInboxLock(directory, async () => {
    const config = await loadConfig(directory);
    const index = await loadIndex(directory, config);
    const attempts = await loadAttempts(directory, config);
    const runs = await loadLocationRuns(directory);
    const runtimeHash = await locationRuntimeHash();
    const outcomes: Array<{ issue: number; status: string; runId?: string }> = [];
    let adapter: Awaited<ReturnType<typeof liveModel>> | undefined;
    for (const number of numbers) {
      if (options.signal?.aborted) break;
      const observation = index.observations.find(o => o.number === number);
      const parent = observation?.snapshot ? latestAttempt(attempts, observation.snapshot)?.record : undefined;
      let input: LocationInput;
      try { if (!observation || !parent) throw new Error('Missing readiness'); input = makeLocationInput(parent, observation, commit); }
      catch { outcomes.push({ issue: number, status: 'ineligible' }); continue; }
      const key = locationKey(input, config.provider, EVALUATION_MODEL, runtimeHash);
      const existing = runs.filter(r => locationKey(r.input, r.provider, r.model, r.runtimeHash, r.promptVersion) === key).at(-1);
      if (existing && (existing.status === 'completed' || !options.retry)) {
        outcomes.push({ issue: number, status: `skipped_${existing.status}`, runId: existing.runId }); continue;
      }
      adapter ??= await (options.modelFactory ?? liveModel)(EVALUATION_MODEL, config.provider);
      if (adapter.provider !== config.provider || adapter.modelId !== EVALUATION_MODEL) throw new Error('Location provider/model must match pinned Terra configuration');
      const run = await locateCode(input, { ...adapter, checkout, signal: options.signal,
        checkpoint: record => atomicJson(join(directory, 'locations', locationFilename(record)), record) });
      runs.push(run);
      outcomes.push({ issue: number, status: run.status, runId: run.runId });
      options.onProgress?.(`#${number}: ${run.brief?.status ?? run.failure}`);
    }
    return outcomes;
  });
}
