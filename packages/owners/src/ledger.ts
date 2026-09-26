import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withRecordLock } from './record-lock.ts';
import { ImplementationReport, OwnerAnswers, Plan, ProposedWork, Verdict } from './artifacts.ts';
import { ChatOrigin } from './chat-origin.ts';
import { AssignmentRef } from './initiatives.ts';

export const HireRecord = z.object({
  stage: z.string(),
  craft: z.string(),
  model: z.string(),
  family: z.string(),
  sessionID: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  cost: z.number(),
  outcome: z.enum(['delivered', 'failed']),
  error: z.string().optional(),
});
export type HireRecord = z.infer<typeof HireRecord>;

export const Verification = z.object({
  command: z.string(),
  exitCode: z.number(),
  output: z.string(),
});
export type Verification = z.infer<typeof Verification>;

export const WorkStatus = z.enum([
  'proposed',
  'planning',
  'awaiting-plan-approval',
  /** An approved owner plan whose execution session is doing the work. */
  'working',
  'implementing',
  'reviewing',
  'landing',
  'awaiting-push-approval',
  'landed',
  'failed',
  'rejected',
  'interrupted',
  'cancelled',
]);
export type WorkStatus = z.infer<typeof WorkStatus>;

/** Statuses no runner moves on from. */
export const FINISHED_STATUSES: ReadonlySet<WorkStatus> = new Set(['landed', 'failed', 'rejected', 'cancelled']);

export function isFinished(item: { status: WorkStatus }) {
  return FINISHED_STATUSES.has(item.status);
}

export const HumanNote = z.object({
  kind: z.enum(['approval', 'plan-feedback', 'rejection', 'resume', 'retry', 'cancellation', 'override']),
  by: z.string(),
  at: z.string(),
  note: z.string(),
});
export type HumanNote = z.infer<typeof HumanNote>;

export const Publication = z.object({
  url: z.string(),
  branch: z.string(),
  by: z.string(),
  at: z.string(),
  state: z.enum(['open', 'merged', 'closed']).default('open'),
});
export type Publication = z.infer<typeof Publication>;

export const Implementation = z.object({
  report: ImplementationReport,
  diffStat: z.string(),
  verification: z.array(Verification),
  /** The worktree as a tree object when it was recorded, so the next review sees what changed since the last one. */
  tree: z.string().optional(),
});
export type Implementation = z.infer<typeof Implementation>;

/** An owner's plan as submitted: markdown the person approves, and its digest so a review names the exact text. */
export const PlanDocument = z.object({ markdown: z.string(), digest: z.string() });
export type PlanDocument = z.infer<typeof PlanDocument>;

/** Why a cleanup pass left a finished plan's worktree in place. */
export const PlanWorktreeKept = z.enum(['kept-uncommitted', 'kept-unpublished', 'failed']);
export type PlanWorktreeKept = z.infer<typeof PlanWorktreeKept>;

const PullRequestTarget = z.object({ itemId: z.string(), branch: z.string(), prUrl: z.string(), previousHead: z.string() });

export const WorkItem = z.object({
  id: z.string(),
  owner: z.string(),
  workflow: z.string(),
  proposal: ProposedWork,
  status: WorkStatus,
  reason: z.string().optional(),
  plan: Plan.optional(),
  planDocument: PlanDocument.optional(),
  ownerAnswers: OwnerAnswers.optional(),
  planApproval: z.object({ by: z.string(), at: z.string(), note: z.string().optional() }).optional(),
  implementations: z.array(Implementation).default([]),
  verdicts: z.array(Verdict).default([]),
  replans: z.number().default(0),
  /** Implementation count at the start of the current plan/retry budget. */
  revisionStart: z.number().optional(),
  /** Reset only once when beginning an approved replacement plan. */
  resetForPlan: z.boolean().optional(),
  /** Exact stage to continue after a failure or interruption. */
  resumeStatus: WorkStatus.optional(),
  worktree: z.string().optional(),
  /** An approved plan's own worktree while it exists; unset once the cleanup pass removes it (finished and idle). */
  planWorktree: z.string().optional(),
  /** Why the last cleanup pass kept the plan's worktree, so the person hears of it once, not every pass. */
  planWorktreeKept: PlanWorktreeKept.optional(),
  branch: z.string().optional(),
  landedCommit: z.string().optional(),
  hires: z.array(HireRecord).default([]),
  humanNotes: z.array(HumanNote).default([]),
  publication: Publication.optional(),
  /** Set on a rebase work item: which landed item's PR it brings up to date. */
  rebaseOf: PullRequestTarget.optional(),
  repairOf: PullRequestTarget.optional(),
  deskPublication: z.object({
    stage: z.enum(['commit', 'push', 'open', 'merge', 'finish', 'complete']),
    reviewedHead: z.string(),
    reviewedTree: z.string(),
    reviewer: z.string(),
    publishRequest: z.string().optional(),
  }).optional(),
  /** The chat the work was opened from, so the owner hears there how it went. */
  origin: ChatOrigin.optional(),
  /** The owner session that carries out an approved plan; later notices about the work go there. */
  session: ChatOrigin.optional(),
  /** The request another owner opened for this work, when it was delegated. */
  request: z.string().optional(),
  /** Set on work a manager assigned through an initiative. */
  assignment: AssignmentRef.optional(),
  /** The pid working on a step right now; unset when the item is merely queued (approved, resumed). */
  activeRunner: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkItem = z.infer<typeof WorkItem>;

function runnerIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class Ledger {
  constructor(readonly directory: string) {}

  async create(owner: string, workflow: string, proposal: ProposedWork, extra: Partial<WorkItem> = {}) {
    const now = new Date().toISOString();
    const item: WorkItem = WorkItem.parse({
      id: `w-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`,
      owner,
      workflow,
      proposal,
      status: 'proposed',
      ...extra,
      createdAt: now,
      updatedAt: now,
    });
    await this.save(item);
    return item;
  }

  async get(id: string) {
    return WorkItem.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const items = await Promise.all(names.map(name => this.get(name.slice(0, -'.json'.length))));
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(item: WorkItem) {
    return withRecordLock(`${this.path(item.id)}.lock`, () => this.write(item));
  }

  /** Read and mutate the latest record under a cross-process lock; never hold it across effects. */
  async update(id: string, change: (current: WorkItem) => WorkItem) {
    return withRecordLock(`${this.path(id)}.lock`, async () => this.write(WorkItem.parse(change(await this.get(id)))));
  }

  private async write(item: WorkItem) {
    await mkdir(this.directory, { recursive: true });
    const updated = { ...item, updatedAt: new Date().toISOString() };
    const temporary = `${this.path(item.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path(item.id));
    return updated;
  }

  /**
   * Work a stopped runtime left mid-step is marked, never replayed. Only items a process was actually
   * working on count; approved or resumed items that nothing had started yet stay queued.
   */
  async markInterrupted() {
    const stranded = (await this.list()).filter(item => item.activeRunner !== undefined && !runnerIsAlive(item.activeRunner));
    for (const item of stranded) {
      await this.update(item.id, current => current.activeRunner === undefined || runnerIsAlive(current.activeRunner) ? current : {
        ...current, status: 'interrupted', resumeStatus: current.status, activeRunner: undefined,
        reason: `runtime stopped while ${current.status}`,
      });
    }
    return stranded.length;
  }

  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
}
