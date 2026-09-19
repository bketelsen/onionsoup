import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BriefRequest, REPO_BRIEF_LIMITS, hash } from './contracts.ts';
import { collectRepository, type GithubReader } from './collect.ts';
import { type RepositoryBrief, repositoryBriefStatus, skipReason, stageInput, stageKeys, validateRepositoryBrief } from './record.ts';
import { summarizeRepositoryThemes, interpretRepositoryHealth, suggestMaintenanceActions } from './agents.ts';
import { createInvocationBudget } from '../invocation-budget.ts';
import { liveModel } from '../providers.ts';
import { EVALUATION_MODEL } from '../evaluation-policy.ts';
import { atomicJson, readJson } from '../batch-store.ts';
import { repositoryBriefMarkdown, repositoryBriefHtml } from './render.ts';
import { workflowEvents } from '../workflow-events.ts';
export async function renderRepositoryBrief(directory: string) {
  const b = validateRepositoryBrief(await readJson(join(directory,'repository-brief.json')));
  await atomicJson(join(directory,'events.json'),workflowEvents(b));
  await writeFile(join(directory,'repository-brief.md'),repositoryBriefMarkdown(b),{ mode: 0o600 });
  await writeFile(join(directory,'repository-brief.html'),repositoryBriefHtml(b),{ mode: 0o600 });
  return b;
}
export async function createRepositoryBrief(raw: unknown, options: { directory: string; provider: 'copilot'|'codex';
  reader?: GithubReader; signal?: AbortSignal; modelFactory?: typeof liveModel;
  persist?: (file: string, record: RepositoryBrief) => Promise<void> }) {
  const request = BriefRequest.parse(raw), budget = createInvocationBudget(4), startedAt = new Date().toISOString();
  const b: RepositoryBrief = { schemaVersion: 1, kind: 'repository-brief', workflowId: randomUUID(), request,
    execution: { provider: options.provider, model: EVALUATION_MODEL }, startedAt, status: 'running', budget: budget.snapshot(),
    stages: stageKeys.map(key => ({ key, status: 'pending', updatedAt: startedAt })) };
  await mkdir(options.directory,{ mode: 0o700 });
  let storageBroken = false;
  const save = async () => {
    try { await (options.persist ?? atomicJson)(join(options.directory,'repository-brief.json'),structuredClone(validateRepositoryBrief(b))); }
    catch { storageBroken = true; throw new Error('Repository brief persistence failed; inspect saved artifacts'); }
  };
  await save();
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(REPO_BRIEF_LIMITS.timeoutMs)]);
  try {
    b.snapshot = await collectRepository(request,{ reader: options.reader, signal }); b.snapshotHash = hash(b.snapshot); await save();
    let stopped = false;
    for (const stage of b.stages) {
      const skip = skipReason(b,stage.key);
      if (skip || signal.aborted || stopped) {
        stage.status = 'not_attempted'; stage.reason = skip ?? (signal.aborted ? 'cancelled' : 'prior_attempt_unfinished');
      } else {
        stage.reservation = budget.reserve()!; stage.reservedAt = new Date().toISOString();
        b.budget = stage.reservation; stage.status = 'running'; stage.updatedAt = stage.reservedAt; await save();
        try {
          const adapter = await (options.modelFactory ?? liveModel)(EVALUATION_MODEL,options.provider);
          if (adapter.provider !== options.provider || adapter.modelId !== EVALUATION_MODEL) throw new Error('Adapter mismatch');
          if (signal.aborted) { stage.status = 'failed'; stage.reason = 'cancelled'; }
          else {
            const fn = stage.key.endsWith('themes') ? summarizeRepositoryThemes : stage.key === 'health' ? interpretRepositoryHealth : suggestMaintenanceActions;
            const run = await fn(stageInput(b,stage.key),{ ...adapter, signal, checkpoint: async r => {
              stage.run = r; stage.status = r.status; stage.updatedAt = r.finishedAt ?? r.startedAt;
              if (r.status === 'failed') stage.reason = 'agent_failed';
              await save();
            } });
            stage.run = run; stage.status = run.status;
          }
        } catch {
          if (storageBroken) throw new Error('Storage failed');
          stage.status = stage.run ? 'unfinished' : 'failed'; stage.reason = 'execution_error'; stopped = Boolean(stage.run);
        }
      }
      stage.updatedAt = new Date().toISOString(); await save();
    }
  } catch {
    if (storageBroken) throw new Error('Repository brief persistence failed; inspect saved artifacts');
    b.failure = signal.aborted ? 'cancelled' : b.snapshot ? 'execution_error' : 'collection_failed';
  }
  b.status = repositoryBriefStatus(b); b.finishedAt = new Date().toISOString(); await save();
  await renderRepositoryBrief(options.directory); return b;
}
