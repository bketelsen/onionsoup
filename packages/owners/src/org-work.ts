import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatOrigin } from './chat-origin.ts';
import { canChange, directReports, isDirectReport, planGrantFor } from './declarations.ts';
import { requestWork } from './delegation.ts';
import {
  INITIATIVE_LIMITS, type Assignment, type AssignmentState, type Escalation, type Initiative, type InitiativeDraft,
  type InitiativeStatus, type PlanReview,
} from './initiatives.ts';
import type { WorkItem, WorkStatus } from './ledger.ts';
import { queueNotice } from './notices.ts';
import type { RequestStatus, ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { approvePlan, cancelItem, revisePlan } from './work-recovery.ts';

/**
 * A manager's initiatives: drafted in chat, approved once by the person, then supervised deterministically. Each
 * tick dispatches the assignments whose dependencies have merged as work requests to the reports, which accept them
 * automatically, and rolls the initiative up when its work has merged or failed. No model is hired here.
 */
export interface AssignmentView extends Assignment {
  state: AssignmentState;
  requestRecord?: ResourceRequest;
  item?: WorkItem;
}
export interface InitiativeView extends Omit<Initiative, 'assignments'> { assignments: AssignmentView[] }

const REQUEST_STATES: Partial<Record<RequestStatus, AssignmentState>> = {
  'pending-owner': 'requested',
  declined: 'failed',
  failed: 'failed',
  completed: 'completed',
  interrupted: 'blocked',
};

const ITEM_STATES: Partial<Record<WorkStatus, (item: WorkItem) => AssignmentState>> = {
  'awaiting-plan-approval': () => 'plan-waiting',
  'awaiting-push-approval': () => 'awaiting-person',
  interrupted: () => 'blocked',
  landed: item => (item.publication ? 'awaiting-merge' : 'working'),
};

/** The one place an assignment's state comes from: its request, then its work item. */
export function assignmentState(assignment: Assignment, request?: ResourceRequest, item?: WorkItem): AssignmentState {
  if (assignment.cancelled) return 'cancelled';
  if (!request) return 'not-dispatched';
  const fromRequest = REQUEST_STATES[request.status];
  if (fromRequest) return fromRequest;
  return (item && ITEM_STATES[item.status]?.(item)) ?? 'working';
}

function viewOf(initiative: Initiative, requests: readonly ResourceRequest[], items: readonly WorkItem[]): InitiativeView {
  const assignments = initiative.assignments.map(assignment => {
    const requestRecord = requests.find(request => request.id === assignment.request);
    const item = items.find(candidate => candidate.id === requestRecord?.workItem);
    return { ...assignment, requestRecord, item, state: assignmentState(assignment, requestRecord, item) };
  });
  return { ...initiative, assignments };
}

export async function initiativeView(runtime: Runtime, initiativeId: string) {
  const [initiative, requests, items] = await Promise.all([runtime.initiatives.get(initiativeId), runtime.requests.list(), runtime.ledger.list()]);
  return viewOf(initiative, requests, items);
}

export async function initiativeViews(runtime: Runtime) {
  const [initiatives, requests, items] = await Promise.all([runtime.initiatives.list(), runtime.requests.list(), runtime.ledger.list()]);
  return initiatives.map(initiative => viewOf(initiative, requests, items));
}

type AssignmentCheck = (runtime: Runtime, initiative: Initiative, assignment: Assignment) => void;

const ASSIGNMENT_CHECKS: AssignmentCheck[] = [
  (runtime, initiative, assignment) => {
    if (!isDirectReport(runtime.declarations, initiative.owner, assignment.to)) {
      throw new Error(`assignment_not_a_report: ${assignment.id}: ${assignment.to} does not report to ${initiative.owner}`);
    }
  },
  (runtime, _initiative, assignment) => {
    if (!canChange(runtime.owner(assignment.to))) throw new Error(`owner_cannot_change: ${assignment.id}: ${assignment.to} does not change its repository itself`);
  },
  (runtime, _initiative, assignment) => {
    runtime.repositoryOwner(assignment.to, assignment.proposal.repository);
  },
  (runtime, _initiative, assignment) => {
    if (runtime.owner(assignment.to).duties.some(duty => duty.kind === 'maintain-prs')) return;
    throw new Error(`assignment_report_cannot_observe_merges: ${assignment.id}: ${assignment.to} has no maintain-prs duty, so its merges are never recorded`);
  },
  (_runtime, initiative, assignment) => {
    const unknown = assignment.after.filter(id => !initiative.assignments.some(other => other.id === id));
    if (unknown.length) throw new Error(`assignment_unknown_dependency: ${assignment.id} waits for ${unknown.join(', ')}`);
  },
];

type InitiativeCheck = (initiative: Initiative, others: readonly Initiative[]) => void;

const OPEN_STATUSES = new Set<InitiativeStatus>(['awaiting-approval', 'approved']);

const INITIATIVE_CHECKS: InitiativeCheck[] = [
  initiative => {
    if (!initiative.assignments.length) throw new Error('initiative_has_no_assignments');
  },
  initiative => {
    const count = initiative.assignments.length;
    if (count > INITIATIVE_LIMITS.maxAssignments) throw new Error(`initiative_too_many_assignments: ${count} > ${INITIATIVE_LIMITS.maxAssignments}`);
  },
  initiative => {
    const ids = initiative.assignments.map(assignment => assignment.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length) throw new Error(`assignment_duplicate_id: ${[...new Set(repeated)].join(', ')}`);
  },
  initiative => checkAcyclic(initiative.assignments),
  (initiative, others) => {
    const open = others.filter(other => other.id !== initiative.id && other.owner === initiative.owner && OPEN_STATUSES.has(other.status));
    if (open.length >= INITIATIVE_LIMITS.maxOpenPerManager) {
      throw new Error(`initiative_limit_reached: ${initiative.owner} already has ${open.length} open (${open.map(other => other.id).join(', ')})`);
    }
  },
];

function checkAcyclic(assignments: readonly Assignment[]) {
  const byId = new Map(assignments.map(assignment => [assignment.id, assignment]));
  const finished = new Set<string>();
  const visit = (id: string, path: readonly string[]) => {
    if (path.includes(id)) throw new Error(`assignment_cycle: ${[...path, id].join(' → ')}`);
    if (finished.has(id)) return;
    for (const dependency of byId.get(id)?.after ?? []) visit(dependency, [...path, id]);
    finished.add(id);
  };
  for (const assignment of assignments) visit(assignment.id, []);
}

/** Everything the person's approval would rest on, checked before they are asked and again when they approve. */
async function validateInitiative(runtime: Runtime, initiative: Initiative) {
  const others = await runtime.initiatives.list();
  for (const check of INITIATIVE_CHECKS) check(initiative, others);
  for (const assignment of initiative.assignments) {
    for (const check of ASSIGNMENT_CHECKS) check(runtime, initiative, assignment);
  }
}

async function journal(runtime: Runtime, ownerIds: Iterable<string>, kind: string, note: string) {
  for (const ownerId of new Set(ownerIds)) {
    const notebook = runtime.notebook(ownerId);
    await notebook.journal({ kind, note });
    await notebook.commit(`journal ${kind}`).catch(() => undefined);
  }
}

/** Journal to the manager and wake her in the chat the initiative was drafted in. */
export async function tellManager(runtime: Runtime, initiative: Initiative, change: string, text: string) {
  await journal(runtime, [initiative.owner], change, `${initiative.id}: ${text}`);
  if (!initiative.origin) return;
  await queueNotice(runtime, {
    id: `${initiative.id}-${change}-${randomUUID().slice(0, 8)}`, owner: initiative.owner, initiative: initiative.id,
    change, text: `Initiative ${initiative.id} "${initiative.title}": ${text}`, origin: initiative.origin, at: new Date().toISOString(),
  });
}

async function requireOwnInitiative(runtime: Runtime, managerId: string, initiativeId: string) {
  const initiative = await runtime.initiatives.get(initiativeId);
  if (initiative.owner !== managerId) throw new Error(`not_your_initiative: ${initiativeId} belongs to ${initiative.owner}`);
  return initiative;
}

/** Save a change computed from `current`, refusing if someone else changed the record meanwhile. */
function saveIfUnchanged(runtime: Runtime, current: Initiative, next: Initiative) {
  return runtime.initiatives.update(current.id, latest => {
    if (latest.updatedAt !== current.updatedAt) throw new Error(`initiative_changed: ${current.id}; read it again`);
    return next;
  });
}

export async function draftInitiative(runtime: Runtime, managerId: string, draft: InitiativeDraft, origin?: ChatOrigin) {
  if (!directReports(runtime.declarations, managerId).length) throw new Error(`not_a_manager: ${managerId} has no direct reports`);
  const initiative = await runtime.initiatives.open(managerId, draft, origin);
  await journal(runtime, [managerId], 'initiative-drafted', `${initiative.id}: ${initiative.title}`);
  return initiative;
}

const EDITABLE = new Set<InitiativeStatus>(['drafting', 'awaiting-approval', 'approved']);

/** Compare as stored: optional fields left undefined are the same as absent. */
function stored(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Dispatched assignments are fixed: their work exists. Everything else takes the new draft. */
function mergeAssignments(existing: readonly Assignment[], drafted: InitiativeDraft['assignments']): Assignment[] {
  const byId = new Map(existing.map(assignment => [assignment.id, assignment]));
  for (const dispatched of existing.filter(assignment => assignment.request)) {
    const next = drafted.find(assignment => assignment.id === dispatched.id);
    const { request: _request, cancelled: _cancelled, ...fixed } = dispatched;
    if (!next || !isDeepStrictEqual(stored(next), stored(fixed))) throw new Error(`assignment_already_dispatched: ${dispatched.id} is ${dispatched.request}; leave it as it is`);
  }
  return drafted.map(assignment => ({ ...assignment, request: byId.get(assignment.id)?.request, cancelled: byId.get(assignment.id)?.cancelled }));
}

/** Replace the draft. After submission any edit is a new revision, which waits for the person again. */
export async function updateInitiative(runtime: Runtime, managerId: string, initiativeId: string, draft: InitiativeDraft) {
  const current = await requireOwnInitiative(runtime, managerId, initiativeId);
  if (!EDITABLE.has(current.status)) throw new Error(`initiative_not_editable: ${current.status}`);
  const isSubmitted = current.status !== 'drafting';
  const next: Initiative = {
    ...current, ...draft, assignments: mergeAssignments(current.assignments, draft.assignments),
    revision: isSubmitted ? current.revision + 1 : current.revision, status: isSubmitted ? 'awaiting-approval' : 'drafting',
  };
  if (isSubmitted) await validateInitiative(runtime, next);
  const updated = await saveIfUnchanged(runtime, current, next);
  await journal(runtime, [managerId], 'initiative-updated', `${initiativeId}: revision ${updated.revision} (${updated.status})`);
  return updated;
}

export async function submitInitiative(runtime: Runtime, managerId: string, initiativeId: string) {
  const current = await requireOwnInitiative(runtime, managerId, initiativeId);
  if (current.status !== 'drafting') throw new Error(`initiative_not_drafting: ${current.status}`);
  await validateInitiative(runtime, current);
  const submitted = await saveIfUnchanged(runtime, current, { ...current, status: 'awaiting-approval' });
  await journal(runtime, [managerId], 'initiative-submitted', `${initiativeId}: ${submitted.title}; waiting for the person's approval`);
  return submitted;
}

function requireAwaitingApproval(initiative: Initiative) {
  if (initiative.status !== 'awaiting-approval') throw new Error(`initiative_not_awaiting_approval: ${initiative.status}`);
}

/** The person approves the breakdown once; the runtime dispatches from then on. */
export async function approveInitiative(runtime: Runtime, initiativeId: string, by: string, note?: string) {
  const current = await runtime.initiatives.get(initiativeId);
  requireAwaitingApproval(current);
  await validateInitiative(runtime, current);
  const approval = { by, at: new Date().toISOString(), note, revision: current.revision };
  const approved = await saveIfUnchanged(runtime, current, { ...current, status: 'approved', approval });
  await tellManager(runtime, approved, 'initiative-approved', `approved by ${by}${note ? `: ${note}` : ''}. Its assignments go to your reports as their dependencies merge.`);
  return approved;
}

export async function reviseInitiative(runtime: Runtime, initiativeId: string, by: string, note: string) {
  if (!note.trim()) throw new Error('initiative_revision_note_required');
  const revised = await runtime.initiatives.update(initiativeId, current => {
    requireAwaitingApproval(current);
    const feedback = [...current.feedback, { by, at: new Date().toISOString(), note, revision: current.revision }];
    return { ...current, status: 'drafting', feedback };
  });
  await tellManager(runtime, revised, 'initiative-revised', `sent back by ${by}: ${note}. Update it and submit it again.`);
  return revised;
}

const CANCELLABLE = new Set<InitiativeStatus>(['drafting', 'awaiting-approval', 'approved']);

/** Cancelling stops further dispatch; work already dispatched keeps its own gates and can be cancelled on its own. */
export async function cancelInitiative(runtime: Runtime, initiativeId: string, by: string, reason: string) {
  if (!reason.trim()) throw new Error('initiative_cancel_reason_required');
  const cancelled = await runtime.initiatives.update(initiativeId, current => {
    if (!CANCELLABLE.has(current.status)) throw new Error(`initiative_not_cancellable: ${current.status}`);
    return { ...current, status: 'cancelled', outcome: `cancelled by ${by}: ${reason}` };
  });
  await tellManager(runtime, cancelled, 'initiative-cancelled', `cancelled by ${by}: ${reason}`);
  return cancelled;
}

const LIVE_ITEM = new Set<WorkStatus>(['planning', 'awaiting-plan-approval', 'working', 'landing', 'interrupted', 'failed']);

/** The manager drops one assignment, cancelling its work if it is still open. Nothing may wait for it. */
export async function cancelAssignment(runtime: Runtime, managerId: string, initiativeId: string, assignmentId: string, reason: string) {
  if (!reason.trim()) throw new Error('assignment_cancel_reason_required');
  const view = viewOf(await requireOwnInitiative(runtime, managerId, initiativeId), await runtime.requests.list(), await runtime.ledger.list());
  const assignment = view.assignments.find(candidate => candidate.id === assignmentId);
  if (!assignment) throw new Error(`unknown_assignment: ${assignmentId}`);
  const dependents = view.assignments.filter(other => !other.cancelled && other.after.includes(assignmentId));
  if (dependents.length) throw new Error(`assignment_has_dependents: ${dependents.map(other => other.id).join(', ')} wait for ${assignmentId}`);
  const cancelled = { by: `owner:${managerId}`, at: new Date().toISOString(), note: reason };
  // Mark the assignment first: a tick between the two writes must not read the cancelled work as a failed initiative.
  const updated = await runtime.initiatives.update(initiativeId, current => ({
    ...current, assignments: current.assignments.map(candidate => (candidate.id === assignmentId ? { ...candidate, cancelled } : candidate)),
  }));
  if (assignment.item && LIVE_ITEM.has(assignment.item.status)) await cancelItem(runtime, assignment.item.id, `owner:${managerId}`, reason);
  await journal(runtime, [managerId, assignment.to], 'assignment-cancelled', `${initiativeId}/${assignmentId}: ${reason}`);
  return updated;
}

function isSupervised(initiative: Initiative) {
  return initiative.status === 'approved' && initiative.approval?.revision === initiative.revision;
}

function readyToDispatch(view: InitiativeView) {
  const completed = new Set(view.assignments.filter(assignment => assignment.state === 'completed').map(assignment => assignment.id));
  return view.assignments.filter(assignment => assignment.state === 'not-dispatched' && assignment.after.every(id => completed.has(id)));
}

/** A request already carrying this ref (a dispatch that crashed before linking it) is linked instead of repeated. */
async function dispatch(runtime: Runtime, initiative: Initiative, assignment: Assignment, requests: readonly ResourceRequest[]) {
  const ref = { initiative: initiative.id, assignment: assignment.id };
  const existing = requests.find(request => request.ask.kind === 'work'
    && request.ask.assignment?.initiative === ref.initiative && request.ask.assignment.assignment === ref.assignment);
  const request = existing ?? await requestWork(runtime, initiative.owner, assignment.to, assignment.proposal, ref);
  await runtime.initiatives.update(initiative.id, current => ({
    ...current, assignments: current.assignments.map(candidate => (candidate.id === assignment.id ? { ...candidate, request: request.id } : candidate)),
  }));
  if (!existing) await journal(runtime, [initiative.owner, assignment.to], 'assignment-dispatched', `${initiative.id}/${assignment.id} → ${assignment.to}: ${request.id}`);
}

type Rollup = { status: 'completed' | 'failed' | 'cancelled'; outcome: string } | undefined;

function rollupOf(view: InitiativeView): Rollup {
  const live = view.assignments.filter(assignment => assignment.state !== 'cancelled');
  if (!live.length) return { status: 'cancelled', outcome: 'every assignment was cancelled' };
  const failed = live.find(assignment => assignment.state === 'failed');
  if (failed) return { status: 'failed', outcome: `${failed.id} (${failed.to}) failed: ${failed.requestRecord?.reason ?? 'no reason recorded'}` };
  if (live.every(assignment => assignment.state === 'completed')) return { status: 'completed', outcome: `all ${live.length} assignments merged` };
  return undefined;
}

async function rollUp(runtime: Runtime, view: InitiativeView) {
  const rollup = rollupOf(view);
  if (!rollup) return;
  const finished = await runtime.initiatives.update(view.id, current => (isSupervised(current) ? { ...current, ...rollup } : current));
  if (finished.status !== rollup.status) return;
  await tellManager(runtime, finished, `initiative-${rollup.status}`, `${rollup.outcome}. Tell the person what happened and what, if anything, comes next.`);
}

export interface SupervisionOptions {
  onError: (context: string, error: unknown) => void;
}

async function superviseOne(runtime: Runtime, initiative: Initiative, requests: readonly ResourceRequest[], items: readonly WorkItem[], options: SupervisionOptions) {
  for (const assignment of readyToDispatch(viewOf(initiative, requests, items))) await dispatch(runtime, initiative, assignment, requests);
  const latest = viewOf(await runtime.initiatives.get(initiative.id), await runtime.requests.list(), items);
  await rollUp(runtime, latest);
  for (const item of plansToReview(runtime, latest)) await askManager(runtime, latest, item).catch(error => options.onError(item.id, error));
}

/** One deterministic pass over approved initiatives: dispatch what is ready, finish what is done. */
export async function superviseInitiatives(runtime: Runtime, options: SupervisionOptions) {
  const supervised = (await runtime.initiatives.list()).filter(isSupervised);
  if (!supervised.length) return;
  const [requests, items] = await Promise.all([runtime.requests.list(), runtime.ledger.list()]);
  for (const initiative of supervised) {
    try {
      await superviseOne(runtime, initiative, requests, items, options);
    } catch (error) {
      options.onError(initiative.id, error);
    }
  }
}

export const SUPERVISION_LIMITS = { revisionsPerItem: 2 };

/** The plan a manager reviews, as text, with the digest her review names. */
export function planUnderReview(item: WorkItem) {
  return item.planDocument ? { text: item.planDocument.markdown, digest: item.planDocument.digest } : undefined;
}

/** Work a manager's initiative assigned, with the initiative, or undefined when it is not hers. */
async function assignedItem(runtime: Runtime, managerId: string, itemId: string) {
  const item = await runtime.ledger.get(itemId).catch(() => undefined);
  const initiative = item?.assignment ? await runtime.initiatives.get(item.assignment.initiative).catch(() => undefined) : undefined;
  if (!item?.assignment || !initiative || initiative.owner !== managerId) return undefined;
  return { item, initiative, assignmentId: item.assignment.assignment };
}

function openEscalation(initiative: Initiative, assignmentId: string) {
  return initiative.escalations.find(escalation => escalation.assignment === assignmentId && !escalation.resolution);
}

function grantForItem(runtime: Runtime, managerId: string, item: WorkItem) {
  return planGrantFor(runtime.owner(item.owner), managerId, runtime.repositoryFor(item).domain.name);
}

/** What a manager decides about a report's plan. */
export interface ManagerVerdict { decision: 'approve' | 'revise'; note: string }

interface VerdictContext { runtime: Runtime; managerId: string; item: WorkItem; initiative: Initiative; assignmentId: string; note: string }

/** Approving needs the person's grant and no open escalation; sending back needs only a note the report can act on. */
const PLAN_VERDICTS: Record<ManagerVerdict['decision'], (context: VerdictContext) => Promise<WorkItem>> = {
  approve: async ({ runtime, managerId, item, initiative, assignmentId, note }) => {
    const grant = grantForItem(runtime, managerId, item);
    if (!grant) throw new Error(`plan_review_no_grant: ${item.owner} has not granted ${managerId} approve-plans; the person approves this plan`);
    const escalation = openEscalation(initiative, assignmentId);
    if (escalation) throw new Error(`plan_review_escalation_open: ${escalation.id} (${escalation.kind}) on ${assignmentId} is unresolved`);
    const by = `owner:${managerId} (standing grant approve-plans in ${item.owner})`;
    const approved = await approvePlan(runtime, item.id, by, note.trim() || undefined);
    await journal(runtime, [managerId, item.owner], 'grant-used', `${item.id}: plan approved by ${managerId} under ${item.owner}'s approve-plans grant (${grant.target})`);
    return approved;
  },
  revise: async ({ runtime, managerId, item, note }) => {
    if (!note.trim()) throw new Error('plan_review_note_required: say what the plan must change');
    return revisePlan(runtime, item.id, `owner:${managerId}`, note);
  },
};

async function recordPlanReview(runtime: Runtime, initiativeId: string, review: PlanReview) {
  await runtime.initiatives.update(initiativeId, current => ({ ...current, planReviews: [...current.planReviews, review] }));
}

/** A manager's verdict on a report's plan, recorded against the plan's digest. */
export async function reviewReportPlan(runtime: Runtime, managerId: string, itemId: string, verdict: ManagerVerdict) {
  const context = await assignedItem(runtime, managerId, itemId);
  if (!context || context.initiative.status !== 'approved') throw new Error(`plan_review_not_in_initiative: ${itemId} is not work in an approved initiative of ${managerId}`);
  const plan = planUnderReview(context.item);
  if (!plan || context.item.status !== 'awaiting-plan-approval') throw new Error(`not_awaiting_plan_approval: ${context.item.status}`);
  const reviewed = await PLAN_VERDICTS[verdict.decision]({ runtime, managerId, ...context, note: verdict.note });
  const at = new Date().toISOString();
  await recordPlanReview(runtime, context.initiative.id, { item: itemId, digest: plan.digest, verdict: verdict.decision, note: verdict.note, by: `owner:${managerId}`, at });
  await journal(runtime, [managerId, context.item.owner], 'plan-review', `${itemId}: ${verdict.decision} by ${managerId}${verdict.note ? `: ${verdict.note}` : ''}`);
  return reviewed;
}

/** Plans waiting in a supervised initiative that the manager may approve and has not been asked about in this form. */
function plansToReview(runtime: Runtime, view: InitiativeView) {
  if (!isSupervised(view)) return [];
  return view.assignments.flatMap(assignment => {
    const item = assignment.item;
    const plan = item && planUnderReview(item);
    if (assignment.state !== 'plan-waiting' || !item || !plan || item.activeRunner) return [];
    if (openEscalation(view, assignment.id) || !grantForItem(runtime, view.owner, item)) return [];
    return view.planReviews.some(review => review.item === item.id && review.digest === plan.digest) ? [] : [item];
  });
}

function revisionsAsked(view: InitiativeView, itemId: string) {
  return view.planReviews.filter(review => review.item === itemId && review.verdict === 'revise').length;
}

/**
 * Wake the manager, once per plan, to review it in her chat under the person's grant. After
 * SUPERVISION_LIMITS.revisionsPerItem send-backs the plan is left for the person instead.
 */
async function askManager(runtime: Runtime, view: InitiativeView, item: WorkItem) {
  const plan = planUnderReview(item)!;
  const at = new Date().toISOString();
  if (revisionsAsked(view, item.id) >= SUPERVISION_LIMITS.revisionsPerItem) {
    const note = `revision_limit_reached: sent back ${SUPERVISION_LIMITS.revisionsPerItem} times already; the person decides`;
    await recordPlanReview(runtime, view.id, { item: item.id, digest: plan.digest, verdict: 'escalate', note, by: 'runtime', at });
    await journal(runtime, [view.owner], 'attention', `${item.id} (${item.owner}): plan left for the person: ${note}`);
    return;
  }
  await recordPlanReview(runtime, view.id, { item: item.id, digest: plan.digest, verdict: 'asked', note: '', by: 'runtime', at });
  await tellManager(runtime, view, 'plan-waiting', `${item.owner} submitted plan ${item.id} "${item.proposal.title}" for assignment ${item.assignment!.assignment}. `
    + `Read it with onionsoup_status item ${item.id}, then approve it with onionsoup_steer approve-plan (the person granted you this) or send it back with revise-plan and a note. The person can also decide in their inbox.`);
}

type Steer = (runtime: Runtime, managerId: string, item: WorkItem, note: string) => Promise<string>;

/** What a manager may do to her reports' assigned work from chat. Approving needs the grant; sending back does not. */
const STEERS: Record<'approve-plan' | 'revise-plan' | 'cancel' | 'note', Steer> = {
  'approve-plan': async (runtime, managerId, item, note) => (await reviewReportPlan(runtime, managerId, item.id, { decision: 'approve', note })).status,
  'revise-plan': async (runtime, managerId, item, note) => (await reviewReportPlan(runtime, managerId, item.id, { decision: 'revise', note })).status,
  cancel: async (runtime, managerId, item, note) => (await cancelItem(runtime, item.id, `owner:${managerId}`, note)).status,
  note: async (runtime, managerId, item, note) => {
    await journal(runtime, [item.owner], 'manager-note', `${item.id}: from ${managerId}: ${note}`);
    return 'noted in its journal';
  },
};
export type SteerAction = keyof typeof STEERS;
export const STEER_ACTIONS = Object.keys(STEERS) as SteerAction[];

export async function steerReportItem(runtime: Runtime, managerId: string, itemId: string, action: SteerAction, note: string) {
  const context = await assignedItem(runtime, managerId, itemId);
  if (!context) throw new Error(`not_your_report_item: ${itemId} is not work in one of ${managerId}'s initiatives`);
  if (action !== 'approve-plan' && !note.trim()) throw new Error(`steer_note_required: ${action} needs a note`);
  const outcome = await STEERS[action](runtime, managerId, context.item, note);
  await journal(runtime, [managerId, context.item.owner], 'steered', `${itemId}: ${action} by ${managerId}${note ? `: ${note}` : ''}`);
  return outcome;
}

export interface Raise { kind: Escalation['kind']; note: string; item?: string; initiative?: string; assignment?: string }

/** The assignment a report raises about: named through its work item, or by initiative and assignment id. */
async function raisedAssignment(runtime: Runtime, reportId: string, raise: Raise) {
  const item = raise.item ? await runtime.ledger.get(raise.item).catch(() => undefined) : undefined;
  const ref = item?.assignment ?? (raise.initiative && raise.assignment ? { initiative: raise.initiative, assignment: raise.assignment } : undefined);
  const initiative = ref ? await runtime.initiatives.get(ref.initiative).catch(() => undefined) : undefined;
  const assignment = initiative?.assignments.find(candidate => candidate.id === ref?.assignment);
  if (!initiative || !assignment || assignment.to !== reportId) {
    throw new Error(`not_your_assignment: ${reportId} has no such assignment; name your work item, or an initiative and assignment id`);
  }
  return { initiative, assignment, item: item?.id };
}

/** A report pushes back: the manager is woken in her chat, and her plan approvals for it wait until she resolves it. */
export async function raiseToManager(runtime: Runtime, reportId: string, raise: Raise) {
  if (!raise.note.trim()) throw new Error('raise_note_required');
  const { initiative, assignment, item } = await raisedAssignment(runtime, reportId, raise);
  const escalation: Escalation = {
    id: `e-${randomUUID().slice(0, 8)}`, kind: raise.kind, from: reportId, assignment: assignment.id, item, note: raise.note, at: new Date().toISOString(),
  };
  const updated = await runtime.initiatives.update(initiative.id, current => ({ ...current, escalations: [...current.escalations, escalation] }));
  const where = `${initiative.id}/${assignment.id}${item ? ` (work ${item})` : ''}`;
  await journal(runtime, [reportId], 'escalation', `${escalation.id}: ${raise.kind} to ${initiative.owner} on ${where}: ${raise.note}`);
  await journal(runtime, [initiative.owner], 'attention', `${reportId} escalated (${raise.kind}) on ${where}: ${raise.note}`);
  const answer = 'Answer it (onionsoup_steer note), bring in the person, and resolve it with onionsoup_initiative resolve-escalation.';
  await tellManager(runtime, updated, 'escalation', `${reportId} escalates (${raise.kind}, ${escalation.id}) on ${where}: ${raise.note}. ${answer}`);
  return escalation;
}

export async function resolveEscalation(runtime: Runtime, managerId: string, initiativeId: string, escalationId: string, note: string) {
  if (!note.trim()) throw new Error('escalation_resolution_note_required');
  await requireOwnInitiative(runtime, managerId, initiativeId);
  const resolution = { by: `owner:${managerId}`, at: new Date().toISOString(), note };
  const updated = await runtime.initiatives.update(initiativeId, current => {
    const escalation = current.escalations.find(candidate => candidate.id === escalationId);
    if (!escalation) throw new Error(`unknown_escalation: ${escalationId}`);
    if (escalation.resolution) throw new Error(`escalation_already_resolved: ${escalationId}`);
    return { ...current, escalations: current.escalations.map(candidate => (candidate.id === escalationId ? { ...candidate, resolution } : candidate)) };
  });
  const escalation = updated.escalations.find(candidate => candidate.id === escalationId)!;
  await journal(runtime, [managerId, escalation.from], 'escalation-resolved', `${escalationId} on ${initiativeId}/${escalation.assignment}: ${note}`);
  return escalation;
}
