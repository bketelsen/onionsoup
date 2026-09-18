import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Agent, defineToolInterface, maxSteps, startState, toolCompleted } from '@humanlayer/agentlayer-core';
import type { AgentState, TokenUsage } from '@humanlayer/agentlayer-core';
import type { LanguageModel } from 'ai';
import { LocationInput, BriefDraft, SourcePath, LOCATION_LIMITS, resolveBrief, type LocationBrief, type Excerpt } from './location-contracts.ts';
import { LocationSource } from './location-source.ts';
import { LOCATION_PROMPT, LOCATION_PROMPT_VERSION } from './location-prompt.ts';
import { projectRoot } from './batch-store.ts';

const SearchInput = z.object({ query: z.string().min(1).max(160), scope: z.enum(['code', 'tests', 'all']), pathPrefix: z.string().max(400) }).strict();
const ReadInput = z.object({ path: SourcePath, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
const Search = defineToolInterface<z.infer<typeof SearchInput>, string>({ name: 'search_repository', description: 'Search a literal string in the pinned repository. pathPrefix is a directory/file prefix, or empty for all paths. A zero-match scoped search retries the same literal repository-wide and reports broadened/searchedPrefixes. Read promising tests before more searches. Previews are not citable.', input: SearchInput });
const Read = defineToolInterface<z.infer<typeof ReadInput>, string>({ name: 'read_repository', description: 'Read a numbered source window at the pinned commit. Host caps the result at 60 lines starting at startLine, even if endLine is larger. Returns actual bounds, truncation, nextStartLine, and an excerpt ID. Code reads also suggest filename-based relatedTests paths. These are unverified leads; only returned numbered lines are citable.', input: ReadInput });
const Submit = defineToolInterface<BriefDraft, string>({ name: 'submit_brief', description: 'Submit likely code entry points, related tests, and uncertainties using only excerpts read by this run. Host code supplies metadata and quotes.', input: BriefDraft });
export type LocationRun = { schemaVersion: 1; agent: 'code-location'; runId: string; input: LocationInput;
  promptVersion: string; runtimeHash: string; provider: string; model: string;
  status: 'running' | 'completed' | 'failed'; startedAt: string; finishedAt?: string;
  limits: typeof LOCATION_LIMITS; events: Array<{ type: string; at: string; step?: number; tool?: string }>;
  source: { calls: number; returnedChars: number; searchedTests: boolean; excerpts: Excerpt[]; activities: LocationSource['activities'] };
  brief?: LocationBrief; failure?: string; finishReason?: string; tokenUsage?: TokenUsage; state?: AgentState };
export async function locationRuntimeHash() {
  const files = ['src/location-agent.ts', 'src/location-contracts.ts', 'src/location-source.ts', 'src/location-prompt.ts',
    'src/location-workflow.ts', 'src/location-record.ts', 'src/providers.ts', 'package-lock.json'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(join(projectRoot, file))).update('\0');
  return hash.digest('hex');
}
function combineUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: TokenUsage['totals'], y: TokenUsage['totals']): TokenUsage['totals'] => ({
    inputTokens: x.inputTokens + y.inputTokens, outputTokens: x.outputTokens + y.outputTokens,
    cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens, cacheWriteTokens: x.cacheWriteTokens + y.cacheWriteTokens,
    reasoningTokens: x.reasoningTokens + y.reasoningTokens,
    estimatedCostUsd: x.estimatedCostUsd === undefined || y.estimatedCostUsd === undefined ? undefined : x.estimatedCostUsd + y.estimatedCostUsd,
  });
  const byModel = { ...a.byModel };
  for (const [key, value] of Object.entries(b.byModel)) byModel[key] = byModel[key] ? sum(byModel[key], value) : value;
  return { byModel, totals: sum(a.totals, b.totals) };
}
export async function locateCode(raw: unknown, options: { checkout: string; model: LanguageModel; provider: string; modelId: string;
  signal?: AbortSignal; checkpoint?: (record: LocationRun) => Promise<void> }): Promise<LocationRun> {
  const input = LocationInput.parse(raw);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LOCATION_LIMITS.timeoutMs)]) : AbortSignal.timeout(LOCATION_LIMITS.timeoutMs);
  const source = await LocationSource.open(options.checkout, input.repository.name, input.repository.commit, signal);
  const record: LocationRun = { schemaVersion: 1, agent: 'code-location', runId: randomUUID(), input,
    promptVersion: LOCATION_PROMPT_VERSION, runtimeHash: await locationRuntimeHash(), provider: options.provider, model: options.modelId,
    status: 'running', startedAt: new Date().toISOString(), limits: LOCATION_LIMITS, events: [],
    source: { calls: 0, returnedChars: 0, searchedTests: false, excerpts: [], activities: [] } };
  await options.checkpoint?.(structuredClone(record));
  let brief: LocationBrief | undefined;
  const submit = Submit.define(async draft => {
    if (brief) throw new Error('ALREADY_SUBMITTED');
    brief = resolveBrief(draft, source.excerpts, source.searchedTests);
    return 'Location brief accepted';
  });
  const inspectionSteps = LOCATION_LIMITS.steps - 2;
  const agent = new Agent({ model: options.model, system: LOCATION_PROMPT, tools: {
    search_repository: Search.define(async input => JSON.stringify(await source.search(input))),
    read_repository: Read.define(async input => JSON.stringify(await source.read(input))),
    submit_brief: submit,
  }, toolChoice: 'required', maxSteps: inspectionSteps,
    stopWhen: [toolCompleted('submit_brief'), maxSteps(inspectionSteps)] });
  const executePhase = async (agent: Agent, state: AgentState, offset: number) => {
    const run = agent.run({ state, signal, stream: true });
    for await (const event of run) if (['stepStart', 'stepFinish', 'toolInputStart'].includes(event.type)) {
      record.events.push({ type: event.type, at: new Date().toISOString(),
        step: 'stepIndex' in event ? event.stepIndex + offset : undefined, tool: 'toolName' in event ? event.toolName : undefined });
    }
    const result = await run.result;
    record.state = result.state; record.tokenUsage = combineUsage(record.tokenUsage, result.tokenUsage); record.finishReason = result.finishReason;
    return result;
  };
  try {
    let result = await executePhase(agent, startState([{ role: 'user', content: JSON.stringify({
      issue_snapshot: input.issue, readiness_summary: input.parent.summary, repository: input.repository,
    }) }]), 0);
    const usedSteps = record.events.filter(e => e.type === 'stepStart').length;
    if (!brief && !signal.aborted && usedSteps === inspectionSteps &&
        (result.finishReason === 'maxSteps' || result.stopCondition?.name === 'maxSteps')) {
      record.events.push({ type: 'finalizationStarted', at: new Date().toISOString() });
      // Same task/state/deadline; source tools are removed for the last two steps.
      const finalizer = new Agent({ model: options.model,
        system: `${LOCATION_PROMPT}\nInspection is now closed. Submit the best supported brief from the excerpts already read. Only submit_brief is available, with two attempts including correction.`,
        tools: { submit_brief: submit }, toolChoice: 'required', maxSteps: 2,
        stopWhen: [toolCompleted('submit_brief'), maxSteps(2)] });
      result = await executePhase(finalizer, result.state, usedSteps);
    }
    if (brief && result.finishReason === 'stopCondition' && result.stopCondition?.name === 'toolCompleted:submit_brief') {
      record.status = 'completed'; record.brief = brief;
    } else { record.status = 'failed'; record.failure = signal.aborted ? 'interrupted_or_timed_out' : result.finishReason === 'error' ? 'provider_error' : 'no_valid_brief'; }
  } catch { record.status = 'failed'; record.failure = signal.aborted ? 'interrupted_or_timed_out' : 'execution_error'; }
  record.source = { calls: source.calls, returnedChars: source.returnedChars, searchedTests: source.searchedTests,
    excerpts: source.excerpts, activities: source.activities };
  record.finishedAt = new Date().toISOString();
  await options.checkpoint?.(structuredClone(record));
  return record;
}
