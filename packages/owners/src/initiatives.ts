import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ManagerPlanVerdict, ProposedWork } from './artifacts.ts';
import { ChatOrigin } from './chat-origin.ts';
import { withRecordLock } from './record-lock.ts';

/**
 * An initiative is a manager's cross-repository change: assignments to its direct reports, ordered by `after`.
 * The person approves the breakdown once; the runtime then dispatches each assignment as a work request when its
 * dependencies have merged. An assignment stores only the request it became: its state is derived (org-work.ts).
 */
export const INITIATIVE_LIMITS = { maxAssignments: 12, maxOpenPerManager: 3 };

/** Journal kinds initiative work writes; activity views and chat context show them. */
export const INITIATIVE_JOURNAL_KINDS = [
  'initiative-drafted', 'initiative-updated', 'initiative-submitted', 'initiative-approved', 'initiative-revised',
  'initiative-cancelled', 'initiative-completed', 'initiative-failed', 'assignment-dispatched', 'assignment-cancelled',
  'plan-review', 'grant-used', 'escalation', 'escalation-resolved', 'steered', 'manager-note',
] as const;

/** Which assignment a work request or work item carries out. */
export const AssignmentRef = z.object({ initiative: z.string(), assignment: z.string() });
export type AssignmentRef = z.infer<typeof AssignmentRef>;

const Stamp = z.object({ by: z.string(), at: z.string(), note: z.string() });

export const Assignment = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  to: z.string(),
  proposal: ProposedWork,
  /** Assignments whose work must merge before this one is dispatched. */
  after: z.array(z.string()).default([]),
  request: z.string().optional(),
  cancelled: Stamp.optional(),
});
export type Assignment = z.infer<typeof Assignment>;

/**
 * Where an assignment stands, derived from its request and work item (never stored). awaiting-publish and
 * awaiting-merge mean the work waits on the person, since an assignment completes only when its PR merges.
 */
export const AssignmentState = z.enum([
  'cancelled', 'not-dispatched', 'requested', 'working', 'plan-waiting', 'awaiting-publish', 'awaiting-merge',
  'awaiting-person', 'blocked', 'completed', 'failed',
]);
export type AssignmentState = z.infer<typeof AssignmentState>;

export const InitiativeStatus = z.enum(['drafting', 'awaiting-approval', 'approved', 'completed', 'failed', 'cancelled']);
export type InitiativeStatus = z.infer<typeof InitiativeStatus>;

/** A manager's review of one plan (by digest) under a standing approve-plans grant. */
export const PlanReview = z.object({
  item: z.string(),
  digest: z.string(),
  verdict: ManagerPlanVerdict.shape.decision,
  note: z.string(),
  by: z.string(),
  at: z.string(),
});
export type PlanReview = z.infer<typeof PlanReview>;

/** A report pushing back on its assignment. While open, the manager cannot approve that assignment's plans. */
export const Escalation = z.object({
  id: z.string(),
  kind: z.enum(['objection', 'question', 'blocked']),
  from: z.string(),
  assignment: z.string(),
  item: z.string().optional(),
  note: z.string(),
  at: z.string(),
  resolution: Stamp.optional(),
});
export type Escalation = z.infer<typeof Escalation>;

export const Initiative = z.object({
  id: z.string(),
  owner: z.string(),
  title: z.string(),
  goal: z.string(),
  rationale: z.string(),
  status: InitiativeStatus,
  assignments: z.array(Assignment).default([]),
  /** Bumped by every edit after submission; approval holds only for the revision it names. */
  revision: z.number().int().nonnegative().default(0),
  approval: z.object({ by: z.string(), at: z.string(), note: z.string().optional(), revision: z.number().int() }).optional(),
  feedback: z.array(Stamp.extend({ revision: z.number().int() })).default([]),
  planReviews: z.array(PlanReview).default([]),
  escalations: z.array(Escalation).default([]),
  /** The manager's chat the initiative was drafted in: notices about its work go there. */
  origin: ChatOrigin.optional(),
  outcome: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Initiative = z.infer<typeof Initiative>;

/** What a manager writes: the initiative's purpose and its assignments. */
export const InitiativeDraft = Initiative.pick({ title: true, goal: true, rationale: true }).extend({
  assignments: z.array(Assignment.pick({ id: true, to: true, proposal: true, after: true })),
});
export type InitiativeDraft = z.infer<typeof InitiativeDraft>;

/** Parse a draft from chat input, naming every problem the manager needs to fix. */
export function parseInitiativeDraft(value: unknown) {
  const parsed = InitiativeDraft.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`initiative_invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
}

const INITIATIVE_ID = /^i-\d{8}-[0-9a-f]{6}$/;

export class Initiatives {
  constructor(readonly directory: string) {}

  async open(owner: string, draft: InitiativeDraft, origin?: ChatOrigin) {
    const now = new Date().toISOString();
    const id = `i-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`;
    return this.save(Initiative.parse({ ...draft, id, owner, status: 'drafting', origin, createdAt: now, updatedAt: now }));
  }

  async get(id: string) {
    if (!INITIATIVE_ID.test(id)) throw new Error(`initiative_invalid_id: ${id}`);
    return Initiative.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const records = await Promise.allSettled(names.map(name => this.get(name.slice(0, -'.json'.length))));
    const initiatives: Initiative[] = [];
    for (const [index, record] of records.entries()) {
      if (record.status === 'fulfilled') initiatives.push(record.value);
      else console.warn(`initiative_record_unreadable: ${names[index]}`);
    }
    return initiatives.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(initiative: Initiative) {
    return withRecordLock(`${this.path(initiative.id)}.lock`, () => this.write(initiative));
  }

  /** Read and change the latest record under a cross-process lock; never hold it across effects. */
  async update(id: string, change: (current: Initiative) => Initiative) {
    return withRecordLock(`${this.path(id)}.lock`, async () => this.write(Initiative.parse(change(await this.get(id)))));
  }

  private async write(initiative: Initiative) {
    await mkdir(this.directory, { recursive: true });
    const updated = { ...initiative, updatedAt: new Date().toISOString() };
    const temporary = `${this.path(initiative.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path(initiative.id));
    return updated;
  }

  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
}
