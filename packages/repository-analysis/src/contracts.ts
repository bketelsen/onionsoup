import { z } from 'zod';
import { createHash } from 'node:crypto';
export const REPO_BRIEF_LIMITS = { requests: 20, items: 100, themeItems: 30, contributorChecks: 10, invocations: 4,
  steps: 3, agentTimeoutMs: 60000, timeoutMs: 600000 } as const;
const Time = z.iso.datetime();
export const BriefRequest = z.object({ schemaVersion: z.literal(1), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  since: Time, until: Time, maxSuggestions: z.number().int().min(0).max(10).default(5) }).strict()
  .refine(r => Date.parse(r.until) - Date.parse(r.since) >= 1000 && Date.parse(r.until) - Date.parse(r.since) <= 90 * 86400000,
    'Window must be at least one second and at most 90 days');
export type BriefRequest = z.infer<typeof BriefRequest>;
export const CollectionKey = z.enum(['openIssues', 'openPRs', 'createdIssues', 'closedIssues', 'createdPRs', 'mergedPRs', 'closedUnmergedPRs']);
export type CollectionKey = z.infer<typeof CollectionKey>;
export const Item = z.object({ id: z.string().regex(/^(issue|pr):[1-9][0-9]*$/), number: z.number().int().positive(),
  kind: z.enum(['issue','pr']), title: z.string().min(1).max(500), labels: z.array(z.string().max(100)).max(100),
  author: z.string().regex(/^[\w[\].-]+$/).nullable(), bot: z.boolean(), state: z.enum(['open','closed']),
  createdAt: Time, updatedAt: Time, closedAt: Time.nullable(), mergedAt: Time.nullable() }).strict();
export type Item = z.infer<typeof Item>;
export const Collection = z.object({ key: CollectionKey, query: z.string(), observedAt: Time,
  status: z.enum(['available','unavailable']), total: z.number().int().nonnegative().nullable(),
  incomplete: z.boolean(), items: z.array(Item).max(100), rejected: z.number().int().nonnegative(),
  failure: z.enum(['request_failed','cancelled']).optional() }).strict();
export type Collection = z.infer<typeof Collection>;
export const CIRun = z.object({ id: z.number().int().positive(), name: z.string().max(500), branch: z.string(),
  createdAt: Time, status: z.string().max(100), conclusion: z.string().max(100).nullable(), attempt: z.number().int().positive() }).strict();
export const Snapshot = z.object({ schemaVersion: z.literal(1), request: BriefRequest, startedAt: Time, finishedAt: Time,
  requestsUsed: z.number().int().min(0).max(20), defaultBranch: z.string().nullable(),
  collections: z.array(Collection).length(7),
  ci: z.object({ observedAt: Time, status: z.enum(['available','unavailable']), total: z.number().int().nonnegative().nullable(),
    runs: z.array(CIRun).max(100), rejected: z.number().int().nonnegative() }).strict(),
  contributors: z.object({ candidates: z.array(z.string()).max(100), checks: z.array(z.object({ author: z.string(),
    outcome: z.enum(['new','existing','unknown']), firstPR: z.number().int().positive().optional(),
    firstCreatedAt: Time.optional(), observedAt: Time }).strict()).max(10) }).strict(),
}).strict();
export type Snapshot = z.infer<typeof Snapshot>;
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const Evidence = z.object({ id: z.string().regex(/^[\w:.-]+$/), statement: z.string().min(1).max(1000) }).strict();
export type Evidence = z.infer<typeof Evidence>;
export const ThemeInput = z.object({ schemaVersion: z.literal(1), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), collection: z.enum(['issues','prs']),
  items: z.array(Item.pick({ id: true, title: true, labels: true })).min(1).max(30) }).strict();
export const ThemeResult = z.object({ schemaVersion: z.literal(1), groups: z.array(z.object({
  label: z.string().min(1).max(100), summary: z.string().min(1).max(500), itemIds: z.array(z.string()).min(1).max(30) }).strict()).min(1).max(15) }).strict();
export const HealthInput = z.object({ schemaVersion: z.literal(1), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(Evidence).min(1).max(150) }).strict();
const Observation = z.object({ summary: z.string().min(1).max(500), evidenceIds: z.array(z.string()).min(1).max(10) }).strict();
export const HealthResult = z.object({ schemaVersion: z.literal(1), observations: z.array(Observation).max(5),
  limitations: z.array(z.string().min(1).max(400)).min(1).max(6) }).strict();
export const ActionsInput = HealthInput.extend({ maxSuggestions: z.number().int().min(1).max(10) }).strict();
export const ActionsResult = z.object({ schemaVersion: z.literal(1), suggestions: z.array(z.object({
  action: z.string().min(1).max(300), rationale: z.string().min(1).max(500), evidenceIds: z.array(z.string()).min(1).max(10) }).strict()).max(10),
  limitations: z.array(z.string().min(1).max(400)).min(1).max(6) }).strict();
export const RepoAgentId = z.enum(['repository-themes','repository-health','maintenance-actions']);
export type RepoAgentId = z.infer<typeof RepoAgentId>;
export function inputSchema(id: RepoAgentId) { return id === 'repository-themes' ? ThemeInput : id === 'repository-health' ? HealthInput : ActionsInput; }
export function resultSchema(id: RepoAgentId) { return id === 'repository-themes' ? ThemeResult : id === 'repository-health' ? HealthResult : ActionsResult; }
export function validateAgentResult(id: RepoAgentId, raw: unknown, input: unknown) {
  const value = resultSchema(id).parse(raw);
  if (id === 'repository-themes') {
    const i = ThemeInput.parse(input), r = ThemeResult.parse(value);
    const ids = r.groups.flatMap(g => g.itemIds), wanted = i.items.map(i => i.id);
    if (new Set(ids).size !== ids.length || ids.length !== wanted.length || ids.some(n => !wanted.includes(n)) ||
        new Set(r.groups.map(g => g.label.toLowerCase())).size !== r.groups.length) throw new Error('INVALID_PARTITION: assign each supplied ID exactly once, with distinct group labels');
  } else {
    const i = HealthInput.parse(id === 'maintenance-actions' ? (() => { const { maxSuggestions, ...rest } = ActionsInput.parse(input); return rest; })() : input);
    const rows = 'observations' in value ? value.observations : ActionsResult.parse(value).suggestions;
    const available = new Set(i.evidence.map(e => e.id));
    if (rows.some(row => new Set(row.evidenceIds).size !== row.evidenceIds.length || row.evidenceIds.some(ref => !available.has(ref))))
      throw new Error('UNKNOWN_EVIDENCE: cite distinct supplied evidence IDs');
    if (id === 'maintenance-actions' && rows.length > ActionsInput.parse(input).maxSuggestions) throw new Error('TOO_MANY_SUGGESTIONS');
  }
  return value;
}

// Keep original private snapshots; remove recognizable credential strings from model views.
export function contextText(value: string): string {
  return value.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[credential redacted]');
}
