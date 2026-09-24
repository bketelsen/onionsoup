import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatOrigin } from './chat-origin.ts';
import { directReports, isDirectReport } from './declarations.ts';
import { requestWork } from './delegation.ts';
import { INITIATIVE_LIMITS, type Assignment, type AssignmentState, type Initiative, type InitiativeDraft, type InitiativeStatus } from './initiatives.ts';
import type { WorkItem, WorkStatus } from './ledger.ts';
import { queueNotice } from './notices.ts';
import type { RequestStatus, ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { cancelItem } from './workflow.ts';

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
  landed: item => (item.publication ? 'awaiting-merge' : 'awaiting-publish'),
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
    if (!runtime.owner(assignment.to).workflow) throw new Error(`owner_has_no_workflow: ${assignment.id}: ${assignment.to}`);
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

const LIVE_ITEM = new Set<WorkStatus>(['proposed', 'planning', 'awaiting-plan-approval', 'implementing', 'reviewing', 'landing', 'awaiting-push-approval', 'interrupted', 'failed']);

/** The manager drops one assignment, cancelling its work if it is still open. Nothing may wait for it. */
export async function cancelAssignment(runtime: Runtime, managerId: string, initiativeId: string, assignmentId: string, reason: string) {
  if (!reason.trim()) throw new Error('assignment_cancel_reason_required');
  const view = viewOf(await requireOwnInitiative(runtime, managerId, initiativeId), await runtime.requests.list(), await runtime.ledger.list());
  const assignment = view.assignments.find(candidate => candidate.id === assignmentId);
  if (!assignment) throw new Error(`unknown_assignment: ${assignmentId}`);
  const dependents = view.assignments.filter(other => !other.cancelled && other.after.includes(assignmentId));
  if (dependents.length) throw new Error(`assignment_has_dependents: ${dependents.map(other => other.id).join(', ')} wait for ${assignmentId}`);
  if (assignment.item && LIVE_ITEM.has(assignment.item.status)) await cancelItem(runtime, assignment.item.id, `owner:${managerId}`, reason);
  const cancelled = { by: `owner:${managerId}`, at: new Date().toISOString(), note: reason };
  const updated = await runtime.initiatives.update(initiativeId, current => ({
    ...current, assignments: current.assignments.map(candidate => (candidate.id === assignmentId ? { ...candidate, cancelled } : candidate)),
  }));
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

type Rollup = { status: 'completed' | 'failed'; outcome: string } | undefined;

function rollupOf(view: InitiativeView): Rollup {
  const live = view.assignments.filter(assignment => assignment.state !== 'cancelled');
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

async function superviseOne(runtime: Runtime, initiative: Initiative, requests: readonly ResourceRequest[], items: readonly WorkItem[]) {
  for (const assignment of readyToDispatch(viewOf(initiative, requests, items))) await dispatch(runtime, initiative, assignment, requests);
  const latest = await runtime.initiatives.get(initiative.id);
  await rollUp(runtime, viewOf(latest, await runtime.requests.list(), items));
}

/** One deterministic pass over approved initiatives: dispatch what is ready, finish what is done. */
export async function superviseInitiatives(runtime: Runtime, options: SupervisionOptions) {
  const supervised = (await runtime.initiatives.list()).filter(isSupervised);
  if (!supervised.length) return;
  const [requests, items] = await Promise.all([runtime.requests.list(), runtime.ledger.list()]);
  for (const initiative of supervised) {
    try {
      await superviseOne(runtime, initiative, requests, items);
    } catch (error) {
      options.onError(initiative.id, error);
    }
  }
}
