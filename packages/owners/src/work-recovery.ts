import { advanceDeskPublication, DESK_WORKFLOW } from './desk-changes.ts';
import type { HumanNote, WorkItem, WorkStatus } from './ledger.ts';
import { OWNER_CHANGE_WORKFLOW, tellOwner } from './plan-work.ts';
import { advanceRebase, REBASE_WORKFLOW } from './rebase.ts';
import type { Runtime } from './runtime.ts';

/**
 * What the runtime still advances on its own, and how a person recovers work. Owners do their work in their own
 * sessions; host code publishes what they propose (desk publications, CI repairs and plan items), keeps published PRs
 * mergeable (rebases), and records the person's decisions on plans and stopped work.
 */
type Advance = (runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void) => Promise<WorkItem>;

/** An owner's plan is worked on in its session; the runtime only publishes what the session proposed. */
async function advanceOwnerChange(runtime: Runtime, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  return isRunnable(item) ? advanceDeskPublication(runtime, itemId) : item;
}

const WORKFLOWS: Record<string, { advance: Advance; isRunnable: (item: WorkItem) => boolean }> = {
  [REBASE_WORKFLOW]: { advance: advanceRebase, isRunnable: item => ['implementing', 'reviewing', 'landing'].includes(item.status) },
  [DESK_WORKFLOW]: { advance: advanceDeskPublication, isRunnable: item => item.status === 'landing' },
  [OWNER_CHANGE_WORKFLOW]: { advance: advanceOwnerChange, isRunnable: item => item.status === 'landing' && Boolean(item.deskPublication) },
};

/** Whether the daemon advances this item now. Work of a workflow that no longer exists never runs. */
export function isRunnable(item: WorkItem) {
  return !item.activeRunner && (WORKFLOWS[item.workflow]?.isRunnable(item) ?? false);
}

/** Advance a work item until it waits for a person, an owner session, or ends. */
export async function advance(runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void = () => {}) {
  const item = await runtime.ledger.get(itemId);
  const workflow = WORKFLOWS[item.workflow];
  return workflow ? workflow.advance(runtime, itemId, onProgress) : item;
}

/** The freelancer pipeline's work, which nothing advances any more. */
const RETIRED_WORKFLOW = 'change';
const RETIRED_OPEN: readonly WorkStatus[] = ['proposed', 'planning', 'awaiting-plan-approval', 'implementing', 'reviewing', 'landing', 'interrupted'];

/**
 * A one-time check at daemon start: open work of the retired freelancer pipeline fails with `pipeline_removed`, so it
 * reads as finished instead of waiting forever. Its record stays for history; the owner can plan it again.
 */
export async function retirePipelineItems(runtime: Runtime) {
  const stale = (await runtime.ledger.list()).filter(item => item.workflow === RETIRED_WORKFLOW && RETIRED_OPEN.includes(item.status) && !item.activeRunner);
  for (const item of stale) {
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'failed', reason: 'pipeline_removed', resumeStatus: undefined }));
  }
  return stale.map(item => item.id);
}

function humanNote(kind: HumanNote['kind'], by: string, note: string): HumanNote {
  return { kind, by, at: new Date().toISOString(), note };
}

function requireAwaitingApproval(item: WorkItem) {
  if (item.status !== 'awaiting-plan-approval' || item.activeRunner) throw new Error(`not_awaiting_plan_approval: ${item.status}`);
  if (item.workflow !== OWNER_CHANGE_WORKFLOW) throw new Error(`not_an_owner_plan: ${item.id} is ${item.workflow} work`);
}

/** Approve an owner's plan; the plugin then opens the session that carries it out. */
export async function approvePlan(runtime: Runtime, itemId: string, by: string, note?: string) {
  const approved = await runtime.ledger.update(itemId, item => {
    requireAwaitingApproval(item);
    const humanNotes = note ? [...item.humanNotes, humanNote('approval', by, note)] : item.humanNotes;
    return { ...item, status: 'working', reason: undefined, humanNotes, planApproval: { by, at: new Date().toISOString(), note } };
  });
  await runtime.notebook(approved.owner).journal({ kind: 'plan-approved', workItem: itemId, note: `${by}${note ? `: ${note}` : ''}` });
  return approved;
}

/** Send a plan back: the owner hears it in the session it planned in, revises, and submits again. */
export async function revisePlan(runtime: Runtime, itemId: string, by: string, feedback: string) {
  const revised = await runtime.ledger.update(itemId, item => {
    requireAwaitingApproval(item);
    return { ...item, status: 'planning', reason: undefined, humanNotes: [...item.humanNotes, humanNote('plan-feedback', by, feedback)] };
  });
  await runtime.notebook(revised.owner).journal({ kind: 'plan-feedback', workItem: itemId, note: `${by}: ${feedback}` });
  await tellOwner(runtime, revised, 'plan-revise',
    `${by} sent your plan ${revised.id} "${revised.proposal.title}" back: ${feedback}. Revise it and submit it again with onionsoup_submit_plan with item "${revised.id}".`);
  return revised;
}

/** Where stopped work continues: the step it stopped in, else each workflow's first step. */
const FIRST_STEP: Record<string, (item: WorkItem) => WorkStatus> = {
  [REBASE_WORKFLOW]: () => 'implementing',
  [DESK_WORKFLOW]: () => 'landing',
  [OWNER_CHANGE_WORKFLOW]: item => (item.deskPublication ? 'landing' : item.planApproval ? 'working' : 'planning'),
};

const RECOVERABLE_STEPS = new Set<WorkStatus>(['implementing', 'reviewing', 'landing', 'landed']);

function recoveryStage(item: WorkItem): WorkStatus {
  if (item.resumeStatus && RECOVERABLE_STEPS.has(item.resumeStatus)) return item.resumeStatus;
  const first = FIRST_STEP[item.workflow];
  if (!first) throw new Error(`workflow_retired: ${item.id} is ${item.workflow} work, which nothing runs any more`);
  return first(item);
}

/** The person's words when they give them, else what the runtime resumes; either way it is kept on the item. */
function recoveryNote(status: WorkStatus, note?: string) {
  return note?.trim() ? `${note.trim()} (continue from ${status})` : `continue from ${status}`;
}

const RECOVERY_KINDS = {
  resume: { expected: 'interrupted', journal: 'resumed' },
  retry: { expected: 'failed', journal: 'retried' },
} as const;

async function recoverItem(runtime: Runtime, itemId: string, by: string, kind: keyof typeof RECOVERY_KINDS, note?: string) {
  const { expected, journal } = RECOVERY_KINDS[kind];
  const recovered = await runtime.ledger.update(itemId, item => {
    if (item.status !== expected || item.activeRunner) throw new Error(`not_${expected}: ${item.status}`);
    const status = recoveryStage(item);
    return { ...item, status, reason: undefined, humanNotes: [...item.humanNotes, humanNote(kind, by, recoveryNote(status, note))] };
  });
  await runtime.notebook(recovered.owner).journal({ kind: journal, workItem: itemId, note: `${by}: ${recoveryNote(recovered.status, note)}` });
  return recovered;
}

/** Record a person's recovery decision; the daemon executes the preserved stage on its next tick. */
export function resumeItem(runtime: Runtime, itemId: string, by: string, note?: string) {
  return recoverItem(runtime, itemId, by, 'resume', note);
}

export function retryItem(runtime: Runtime, itemId: string, by: string, note?: string) {
  return recoverItem(runtime, itemId, by, 'retry', note);
}

const CANCELLABLE = new Set<WorkStatus>([
  'planning', 'awaiting-plan-approval', 'working', 'implementing', 'reviewing', 'landing',
  'awaiting-push-approval', 'interrupted', 'failed', 'landed',
]);

/** Queued work and waiting gates can be cancelled; an active effect must finish first. */
export async function cancelItem(runtime: Runtime, itemId: string, by: string, reason: string) {
  const cancelled = await runtime.ledger.update(itemId, item => {
    if (item.activeRunner) throw new Error('work_item_active');
    if (item.status === 'landed' && (item.publication || item.rebaseOf)) throw new Error('published_work_cannot_cancel');
    if (!CANCELLABLE.has(item.status)) throw new Error(`not_cancellable: ${item.status}`);
    return { ...item, status: 'cancelled', reason, humanNotes: [...item.humanNotes, humanNote('cancellation', by, reason)] };
  });
  await runtime.notebook(cancelled.owner).journal({ kind: 'work-cancelled', workItem: itemId, note: `${by}: ${reason}` });
  return cancelled;
}
