import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { BriefRequest, Snapshot, ThemeResult, hash, type Evidence } from '@onionsoup/repository-analysis/contracts';
import { validateSnapshot, repositoryMetrics, themeInput, itemEvidence } from '@onionsoup/repository-analysis/metrics';
import { validateRepoAgentRun, type RepoAgentRun } from '@onionsoup/repository-analysis/agents';
import { InvocationBudgetSnapshot } from '@onionsoup/runtime/budget';
export const stageKeys = ['issue_themes','pr_themes','health','actions'] as const;
export type StageKey = typeof stageKeys[number];
export const stageAgent = { issue_themes: 'repository-themes', pr_themes: 'repository-themes', health: 'repository-health', actions: 'maintenance-actions' } as const;
const Stage = z.object({ key: z.enum(stageKeys), status: z.enum(['pending','running','completed','failed','unfinished','not_attempted']),
  updatedAt: z.iso.datetime(), reservation: InvocationBudgetSnapshot.optional(), reservedAt: z.iso.datetime().optional(),
  reason: z.enum(['no_data','disabled','cancelled','prior_attempt_unfinished','execution_error','agent_failed']).optional(), run: z.custom<RepoAgentRun>().optional() }).strict();
export const RepositoryBrief = z.object({ schemaVersion: z.literal(1), kind: z.literal('repository-brief'), workflowId: z.uuid(),
  request: BriefRequest, execution: z.object({ provider: z.enum(['copilot','codex']), model: z.string().min(1) }).strict(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), status: z.enum(['running','completed','partial','failed']),
  budget: InvocationBudgetSnapshot, snapshot: Snapshot.optional(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  stages: z.array(Stage).length(4), failure: z.enum(['collection_failed','execution_error','cancelled']).optional() }).strict();
export type RepositoryBrief = z.infer<typeof RepositoryBrief>;
export function actionEvidence(b: RepositoryBrief): Evidence[] {
  const s = b.snapshot!;
  const evidence = [...repositoryMetrics(s).evidence, ...itemEvidence(s)];
  for (const stage of b.stages.slice(0,2)) if (stage.run?.status === 'completed') {
    for (const [i,g] of ThemeResult.parse(stage.run.result).groups.entries()) evidence.push({ id: `theme:${stage.key}:${i}`,
      statement: `Model-assessed title/label theme ${g.label}: ${g.summary} Members: ${g.itemIds.join(', ')}. Count: ${g.itemIds.length}.` });
  }
  for (const c of s.contributors.checks) if (c.outcome === 'new') evidence.push({ id: `contributor:${c.author}`,
    statement: `First-time PR author ${c.author}: first PR #${c.firstPR} created ${c.firstCreatedAt} according to complete earliest-PR search.` });
  return evidence;
}
export function stageInput(b: RepositoryBrief, key: StageKey) {
  const s = b.snapshot!;
  if (key === 'issue_themes' || key === 'pr_themes') return themeInput(s,key === 'issue_themes' ? 'issues' : 'prs');
  return { schemaVersion: 1 as const, snapshotHash: b.snapshotHash!, evidence: key === 'health' ? repositoryMetrics(s).evidence : actionEvidence(b),
    ...(key === 'actions' ? { maxSuggestions: b.request.maxSuggestions } : {}) };
}
export function skipReason(b: RepositoryBrief, key: StageKey): 'disabled'|'no_data'|undefined {
  if (key === 'actions' && b.request.maxSuggestions === 0) return 'disabled';
  if (!b.snapshot) return 'no_data';
  if (key.endsWith('themes') && !themeInput(b.snapshot,key === 'issue_themes' ? 'issues':'prs').items.length) return 'no_data';
  if (b.snapshot.collections.every(c => c.status === 'unavailable') && b.snapshot.ci.status === 'unavailable') return 'no_data';
}
export function repositoryBriefStatus(b: RepositoryBrief): 'completed'|'partial'|'failed' {
  if (b.failure) return b.snapshot ? 'partial' : 'failed';
  if (!b.snapshot) return 'failed';
  if (b.snapshot.collections.every(c => c.status === 'unavailable') && b.snapshot.ci.status === 'unavailable') return 'failed';
  if (b.snapshot.collections.some(c => c.status === 'unavailable' || c.incomplete || c.rejected) || b.snapshot.ci.status === 'unavailable' || b.snapshot.ci.rejected ||
      b.stages.some(s => s.status !== 'completed' && !(s.status === 'not_attempted' && ['no_data','disabled'].includes(s.reason ?? '')))) return 'partial';
  return 'completed';
}
export function validateRepositoryBrief(raw: unknown): RepositoryBrief {
  const b = RepositoryBrief.parse(raw), invalid = () => { throw new Error('Invalid repository briefing invariants'); };
  if (b.budget.limit !== 4 || !isDeepStrictEqual(b.stages.map(s => s.key),stageKeys)) invalid();
  if (b.snapshot) { validateSnapshot(b.snapshot); if (!isDeepStrictEqual(b.snapshot.request,b.request) || hash(b.snapshot) !== b.snapshotHash) invalid(); }
  else if (b.snapshotHash) invalid();
  let consumed = 0, stopped = false; const runIds = new Set<string>([b.workflowId]);
  for (const stage of b.stages) {
    const attempted = !['pending','not_attempted'].includes(stage.status);
    if (attempted) {
      if (!b.snapshot || stopped || !stage.reservation || !stage.reservedAt || stage.reservation.limit !== 4 || stage.reservation.consumed !== ++consumed || skipReason(b,stage.key)) invalid();
    } else if (stage.run || stage.reservation || stage.reservedAt) invalid();
    if (stage.run) {
      const r = validateRepoAgentRun(stage.run);
      if (runIds.has(r.runId) || r.agent !== stageAgent[stage.key] || r.provider !== b.execution.provider || r.model !== b.execution.model ||
          !isDeepStrictEqual(r.input,stageInput(b,stage.key)) || r.status !== (stage.status === 'unfinished' ? 'running' : stage.status)) invalid();
      runIds.add(r.runId);
    }
    if (['completed','unfinished'].includes(stage.status) && !stage.run) invalid();
    if (stage.status === 'not_attempted') {
      if (!stage.reason) invalid();
      if (stage.reason === 'prior_attempt_unfinished' && !stopped) invalid();
      if (stage.reason === 'no_data' || stage.reason === 'disabled') { if (stage.reason !== skipReason(b,stage.key)) invalid(); }
      else if (!['cancelled','prior_attempt_unfinished'].includes(stage.reason ?? '')) invalid();
    } else if (['failed','unfinished'].includes(stage.status)) { if (!['execution_error','agent_failed','cancelled'].includes(stage.reason ?? '')) invalid(); }
    else if (stage.reason) invalid();
    if (stage.status === 'pending' || stage.status === 'running' || stage.status === 'unfinished' ||
        stage.reason === 'cancelled' || stage.reason === 'prior_attempt_unfinished') stopped = true;
  }
  if (consumed !== b.budget.consumed) invalid();
  if (b.status === 'running') { if (b.finishedAt) invalid(); }
  else if (!b.finishedAt || b.status !== repositoryBriefStatus(b) || !b.failure && b.stages.some(s => ['pending','running'].includes(s.status))) invalid();
  return b;
}
