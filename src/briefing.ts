import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IssueSnapshot } from './contracts.ts';
import { Commit } from './location-contracts.ts';
import { LocationSource } from './location-source.ts';
import { atomicJson, readJson } from './batch-store.ts';
import { captureBriefingIssues } from './briefing-intake.ts';
import type { Source } from './inbox-source.ts';
import { briefingStatus, validateBriefing, type MaintenanceBriefing } from './briefing-record.ts';
import { createInvocationBudget } from './invocation-budget.ts';
import { assessIssues } from './readiness-workflow.ts';
import { locateReadyIssue } from './location-handoff.ts';
import { liveModel } from './providers.ts';
import { EVALUATION_MODEL } from './evaluation-policy.ts';
import { briefingMarkdown } from './briefing-view.ts';
import { workflowEvents } from './workflow-events.ts';
const execute = promisify(execFile);

export async function renderBriefing(directory: string) {
  const b = validateBriefing(await readJson(join(directory, 'briefing.json')));
  await atomicJson(join(directory, 'events.json'), workflowEvents(b));
  await writeFile(join(directory, 'briefing.md'), briefingMarkdown(b), { mode: 0o600 });
  return b;
}
export async function createBriefing(repository: string, options: {
  directory: string; checkout: string; commit?: string; count?: number; issueNumbers?: number[];
  provider: 'copilot' | 'codex'; signal?: AbortSignal; source?: Source; modelFactory?: typeof liveModel;
  persist?: (file: string, record: MaintenanceBriefing) => Promise<void>;
}) {
  IssueSnapshot.shape.repository.parse(repository);
  if (options.commit !== undefined) Commit.parse(options.commit);
  const count = options.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > 5 || options.issueNumbers &&
      (!options.issueNumbers.length || options.issueNumbers.length > count || new Set(options.issueNumbers).size !== options.issueNumbers.length ||
       options.issueNumbers.some(n => !Number.isSafeInteger(n) || n < 1))) throw new Error('Invalid issue selection');
  const budget = createInvocationBudget(7);
  const b: MaintenanceBriefing = { schemaVersion: 1, kind: 'maintenance-briefing', workflowId: randomUUID(), repository,
    startedAt: new Date().toISOString(), status: 'running', execution: { provider: options.provider, model: EVALUATION_MODEL },
    budget: budget.snapshot(), locations: [] };
  await mkdir(options.directory, { mode: 0o700 }); // Exclusive admission; never overwrite another attempt.
  let storageBroken = false;
  const save = async () => {
    try { await (options.persist ?? atomicJson)(join(options.directory, 'briefing.json'), structuredClone(validateBriefing(b))); }
    catch { storageBroken = true; throw new Error('Briefing persistence failed; inspect saved state before a new attempt'); }
  };
  await save();
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(900000)]);
  let phase: 'source_unavailable' | 'intake_failed' | 'execution_error' = 'source_unavailable';
  // Each child requests an adapter only after its reservation is persisted.
  const model = async () => {
    signal.throwIfAborted();
    const adapter = await (options.modelFactory ?? liveModel)(EVALUATION_MODEL, options.provider);
    if (adapter.provider !== options.provider || adapter.modelId !== EVALUATION_MODEL) throw new Error('Provider/model mismatch');
    return adapter;
  };
  try {
    signal.throwIfAborted();
    const commit = Commit.parse((await execute('git', ['-C', options.checkout, 'rev-parse', '--verify', `${options.commit ?? 'HEAD'}^{commit}`],
      { signal, timeout: 30000, maxBuffer: 4096 })).stdout.trim());
    await LocationSource.open(options.checkout, repository, commit, signal);
    b.commit = commit; await save();
    phase = 'intake_failed';
    b.intake = await captureBriefingIssues(repository, { count, issueNumbers: options.issueNumbers, signal, source: options.source });
    b.locations = b.intake.issues.map(i => ({ number: i.snapshot.number, disposition: 'pending' }));
    await save();
    phase = 'execution_error';
    if (b.intake.issues.length) {
      await assessIssues({ issues: b.intake.issues.map(i => i.snapshot) }, { budget, signal, model, checkpoint: async r => {
        b.readiness = r; b.budget = r.budget; await save();
      } });
      let selected = 0;
      let unfinished = b.readiness!.items.some(i => i.status === 'unfinished');
      for (const [index, slot] of b.locations.entries()) {
        const item = b.readiness!.items[index], run = item.run;
        if (item.status !== 'completed') slot.disposition = 'readiness_unavailable';
        else if (run?.assessment?.kind !== 'bug_report' || run.assessment.bug_readiness !== 'ready') slot.disposition = 'not_eligible';
        else if (++selected > 2) slot.disposition = 'selection_limit';
        else if (signal.aborted) slot.disposition = 'cancelled';
        else if (unfinished) slot.disposition = 'prior_attempt_unfinished';
        else {
          const handoff = await locateReadyIssue(run, { source: { checkout: options.checkout, repository: { name: repository, commit } },
            budget, signal, model, readinessWorkflowId: b.readiness!.workflowId, checkpoint: async h => {
              slot.disposition = 'handoff'; slot.handoff = h; b.budget = h.budget; await save();
            } });
          unfinished = handoff.disposition === 'unfinished';
        }
        await save();
      }
    }
  } catch {
    if (storageBroken) throw new Error('Briefing persistence failed; inspect saved state before a new attempt');
    b.failure = signal.aborted ? 'cancelled' : phase;
  }
  b.status = briefingStatus(b); b.finishedAt = new Date().toISOString(); await save();
  await renderBriefing(options.directory);
  return b;
}
