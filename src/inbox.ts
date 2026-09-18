import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { liveModel } from './providers.ts';
import { triage } from './triage.ts';
import { githubSource, type Source } from './inbox-source.ts';
import { atomicJson, initialize, loadIndex, loadAttempts, latestAttempt, contentHash, attemptPath,
  withInboxLock, type Observation, type Refresh, type Attempt, type Index } from './inbox-store.ts';

export type RefreshOptions = { provider?: 'copilot' | 'codex'; maxIssues?: number; maxSeconds?: number;
  pages?: number; retryIssue?: number; signal?: AbortSignal; source?: Source;
  modelFactory?: typeof liveModel; onProgress?: (message: string) => void };
function mergeObservation(index: Index, observation: Observation) {
  const old = index.observations.find(o => o.number === observation.number);
  // A paginated or cached observation must not overwrite a newer revision.
  if (old && old.updatedAt > observation.updatedAt) return;
  index.observations = [...index.observations.filter(o => o.number !== observation.number), observation];
}
export async function refreshInbox(directory: string, repository: string, options: RefreshOptions = {}) {
  const maxIssues = options.retryIssue ? 1 : options.maxIssues ?? 5;
  const maxSeconds = options.maxSeconds ?? 300;
  const pages = options.pages ?? 1;
  if (!Number.isInteger(maxIssues) || maxIssues < 0 || maxIssues > 20 ||
      !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 900 ||
      !Number.isInteger(pages) || pages < 1 || pages > 3 ||
      (options.retryIssue !== undefined && (!Number.isSafeInteger(options.retryIssue) || options.retryIssue < 1)))
    throw new Error('Bounds: max-issues 0–20, max-seconds 1–900, pages 1–3, retry issue positive integer');
  return withInboxLock(directory, async () => {
    const config = await initialize(directory, repository, options.provider ?? 'copilot');
    const index = await loadIndex(directory, config);
    const attempts = await loadAttempts(directory, config);
    const refresh: Refresh = { schemaVersion: 1, id: randomUUID(), startedAt: new Date().toISOString(),
      status: 'running', mode: options.retryIssue ? 'retry' : 'refresh', maxIssues, maxSeconds, pages,
      pointReads: 0, scanned: 0, changed: 0, skipped: 0, attempted: 0, completed: 0, failed: 0 };
    const path = join(directory, 'refreshes', `${refresh.startedAt.replaceAll(':', '-')}-${refresh.id}.json`);
    await atomicJson(path, refresh);
    const deadline = AbortSignal.timeout(maxSeconds * 1000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const source = options.source ?? githubSource;
    let phase: 'source' | 'execution' = 'source';
    let adapter: Awaited<ReturnType<typeof liveModel>> | undefined;
    try {
      signal.throwIfAborted();
      const scan = options.retryIssue ? { observations: [await source.get(repository, options.retryIssue, signal)], entries: 1, windowFull: false } :
        await source.scan(repository, pages, signal);
      refresh.scanned = scan.entries;
      if (options.retryIssue) refresh.pointReads = 1;
      for (const item of scan.observations) {
        const old = index.observations.find(o => o.number === item.number);
        if (!old || old.state !== item.state || (old.snapshot && contentHash(old.snapshot)) !== (item.snapshot && contentHash(item.snapshot))) refresh.changed++;
        mergeObservation(index, item);
      }
      if (!options.retryIssue) {
        index.lastScanAt = new Date().toISOString(); index.scannedEntries = scan.entries; index.windowFull = scan.windowFull;
      }
      await atomicJson(join(directory, 'index.json'), index);
      const open = index.observations.filter(o => o.state === 'open' && o.snapshot);
      refresh.skipped = open.filter(o => latestAttempt(attempts, o.snapshot!)).length;
      const candidates = options.retryIssue ? open.filter(o => o.number === options.retryIssue) :
        open.filter(o => !latestAttempt(attempts, o.snapshot!))
          .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || b.updatedAt.localeCompare(a.updatedAt) || a.number - b.number);
      for (const candidate of candidates) {
        if (refresh.attempted >= maxIssues || (!options.retryIssue && refresh.pointReads >= maxIssues) || signal.aborted) break;
        phase = 'source';
        // Point-read before spending tokens: an older queued report may now be edited or closed.
        if (!options.retryIssue) refresh.pointReads++;
        const fresh = options.retryIssue ? candidate : await source.get(repository, candidate.number, signal);
        if (fresh.updatedAt < candidate.updatedAt) { refresh.warning = 'stale_source_response'; continue; }
        mergeObservation(index, fresh);
        await atomicJson(join(directory, 'index.json'), index);
        const item = index.observations.find(o => o.number === candidate.number)!;
        if (item.state !== 'open' || !item.snapshot) continue;
        const existing = latestAttempt(attempts, item.snapshot);
        if (existing && (!options.retryIssue || existing.record.status !== 'failed')) {
          if (options.retryIssue) refresh.warning = existing.record.status === 'running' ? 'recover_interrupted_attempt_first' : 'assessment_already_completed';
          continue;
        }
        phase = 'execution';
        signal.throwIfAborted();
        adapter ??= await (options.modelFactory ?? liveModel)(config.model, config.provider);
        if (adapter.modelId !== config.model || adapter.provider !== config.provider) throw new Error('Provider/model does not match inbox');
        const sequence = (attempts.at(-1)?.sequence ?? 0) + 1;
        let current: Attempt | undefined;
        refresh.attempted++;
        // Admission goes to disk before the model call. A thrown final write leaves it running.
        const run = await triage(item.snapshot, { ...adapter, signal, checkpoint: async record => {
          current = { sequence, contentHash: contentHash(record.input), record };
          await atomicJson(attemptPath(directory, current), current);
        } });
        attempts.push(current!);
        if (run.status === 'completed') refresh.completed++; else refresh.failed++;
        options.onProgress?.(`#${item.number}: ${run.assessment ? `${run.assessment.kind} / ${run.assessment.bug_readiness}` : run.failure}`);
        await atomicJson(path, refresh);
      }
      refresh.status = signal.aborted ? 'interrupted' : 'completed';
      if (signal.aborted) refresh.warning = 'time_limit_or_cancelled';
    } catch {
      refresh.status = signal.aborted ? 'interrupted' : 'failed';
      refresh.warning = signal.aborted ? 'time_limit_or_cancelled' : phase === 'source' ? 'source_error' : 'execution_error';
      // Raw CLI/provider errors may contain headers or credentials. Preserve only a public code.
    }
    refresh.finishedAt = new Date().toISOString();
    await atomicJson(path, refresh);
    return refresh;
  });
}
