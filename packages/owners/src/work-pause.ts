import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ChatOrigin } from './chat-origin.ts';
import { isDirectReport, planGrantFor } from './declarations.ts';
import { isPaused, requireRunnerClaim, WorkItem, type WorkStatus, type WorkPauseReceipt } from './ledger.ts';
import { queueNotice, readNotice, NOTICE_PREFIX, type WorkNotice } from './notices.ts';
import type { Runtime } from './runtime.ts';
import { SessionOpeningStore, type SessionOpening, type SessionOpeningKey } from './session-opening-store.ts';
import { OWNER_SESSIONS } from './owner-sessions.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';

const ACTORS = new WeakSet<object>();
const GRANT_ACTORS = new WeakMap<object, { runtime: Runtime; itemId: string; managerId: string }>();
export interface WorkLifecycleActor {
  readonly by: string;
  readonly authority: WorkPauseReceipt['authority'];
}

/** Only trusted host entrypoints call this; no actor name or prose is accepted from tool arguments. */
export function humanWorkActor(): WorkLifecycleActor {
  const actor = Object.freeze({ by: userInfo().username, authority: 'human' as const });
  ACTORS.add(actor);
  return actor;
}

/** The authenticated tool caller is supplied by the plugin, and authority is read from declared grants. */
async function requireManagerAuthority(runtime: Runtime, managerId: string, item: WorkItem) {
  const owner = runtime.repositoryFor(item);
  if (!isDirectReport(runtime.declarations, managerId, item.owner)
    || !planGrantFor(owner, managerId, owner.domain.name)) throw new Error('work_resume_grant_required');
  const request = item.request ? await runtime.requests.get(item.request) : undefined;
  if (!request || request.from !== managerId || request.to !== item.owner) throw new Error('work_resume_not_assigned');
}

export async function managerWorkActor(runtime: Runtime, managerId: string, item: WorkItem): Promise<WorkLifecycleActor> {
  await requireManagerAuthority(runtime, managerId, item);
  const actor = Object.freeze({ by: `owner:${managerId}`, authority: 'standing-grant' as const });
  ACTORS.add(actor);
  GRANT_ACTORS.set(actor, { runtime, managerId, itemId: item.id });
  return actor;
}

function requireActor(actor: WorkLifecycleActor | string): WorkLifecycleActor {
  if (typeof actor !== 'object' || !ACTORS.has(actor)) throw new Error('work_lifecycle_human_required');
  return actor;
}

const PAUSABLE = new Set<WorkStatus>([
  'planning', 'awaiting-plan-approval', 'working', 'implementing', 'reviewing', 'landing', 'awaiting-push-approval',
]);

function binding(item: WorkItem) {
  return createHash('sha256').update(JSON.stringify([
    item.owner, item.workflow, item.proposal, item.plan, item.planDocument, item.planApproval,
  ])).digest('hex');
}

function latestPause(item: WorkItem) {
  const receipt = item.pauses.at(-1);
  if (!receipt || receipt.resumedAt) throw new Error('work_pause_receipt_missing');
  return receipt;
}

function replacePause(item: WorkItem, receipt: WorkPauseReceipt) {
  return [...item.pauses.slice(0, -1), receipt];
}

type ItemOpeningKind = Extract<SessionOpeningKey['kind'], 'planning' | 'execution'>;
const OPENING_KIND: Partial<Record<WorkStatus, ItemOpeningKind>> = {
  planning: 'planning', 'awaiting-plan-approval': 'planning',
  working: 'execution', implementing: 'execution', reviewing: 'execution',
  landing: 'execution', 'awaiting-push-approval': 'execution',
};
const OPENING_DEPENDENCIES: Record<ItemOpeningKind, readonly ItemOpeningKind[]> = {
  planning: ['planning'], execution: ['planning', 'execution'],
};

async function currentOpenings(runtime: Runtime, item: WorkItem) {
  const stage = isPaused(item) ? latestPause(item).resumeStatus : item.status;
  const kind = item.session ? 'execution' : OPENING_KIND[stage];
  if (!kind) return [];
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const kinds = OPENING_DEPENDENCIES[kind];
  const openings = await Promise.all(kinds.map(kind => store.read({ entity: 'owner-item', id: item.id, owner: item.owner, kind })));
  // A distinct later execution proves an old planning attempt obsolete, not an uncertain prompt on that same session.
  return openings.filter((opening): opening is SessionOpening => opening !== undefined
    && (!item.session || opening.key.kind === kind
      || (opening.origin?.sessionID === item.session.sessionID && opening.origin.directory === item.session.directory)));
}

async function executionTargets(runtime: Runtime, item: WorkItem) {
  const openings = await currentOpenings(runtime, item);
  const targets = [item.session, ...openings.map(opening => opening.origin)]
    .filter((target): target is ChatOrigin => target !== undefined);
  return [...new Map(targets.map(target => [JSON.stringify(target), target])).values()];
}

/** Intent fences dispatch before stopping. A runner or uncertain SDK admission is never erased by a pause. */
export async function pauseItem(runtime: Runtime, itemId: string, actor: WorkLifecycleActor, reason: string) {
  const trusted = requireActor(actor);
  if (!reason.trim()) throw new Error('work_pause_reason_required');
  const paused = await runtime.ledger.updateIfChanged(itemId, current => {
    if (isPaused(current)) return undefined;
    if (!PAUSABLE.has(current.status)) throw new Error(`work_not_pausable: ${current.status}`);
    const at = new Date().toISOString();
    const receipt: WorkPauseReceipt = {
      id: randomUUID(), by: trusted.by, authority: trusted.authority, at, reason: reason.trim(),
      binding: binding(current), resumeStatus: current.status,
    };
    return {
      ...current, status: 'pausing', reason: reason.trim(), pauses: [...current.pauses, receipt],
      humanNotes: [...current.humanNotes, { kind: 'pause', by: trusted.by, at, note: reason.trim() }],
    };
  });
  await projectPause(runtime, paused, 'work-paused');
  const receipt = latestPause(paused);
  await runtime.notebook(paused.owner).journalOnce({
    kind: 'work-paused', workItem: itemId, note: `${receipt.by}: ${receipt.reason}`, source: `work-pause:${receipt.id}`,
  }, receipt.at);
  return settleItemPause(runtime, paused.id);
}

async function projectPause(runtime: Runtime, item: WorkItem, status: 'work-paused' | 'work-running') {
  if (!item.request) return;
  await runtime.requests.update(item.request, current => current.workItem !== item.id
    || !['work-running', 'work-paused'].includes(current.status) ? current
    : { ...current, status, reason: status === 'work-paused' ? item.reason : undefined });
}

export interface WorkPauseClient {
  /** Stops the session and its observed descendants, then positively observes the entire tree idle. */
  stop(origin: ChatOrigin): Promise<boolean>;
}

async function openingIsUncertain(runtime: Runtime, item: WorkItem) {
  return (await currentOpenings(runtime, item)).some(opening => !['opened', 'blocked'].includes(opening.phase));
}

/** Retry observes a submitted stop, never replays an uncertain create/prompt. */
export async function settleItemPause(runtime: Runtime, itemId: string, client?: WorkPauseClient) {
  const item = await runtime.ledger.get(itemId);
  if (item.status !== 'pausing' || item.activeRunner !== undefined || await openingIsUncertain(runtime, item)) return item;
  for (const target of await executionTargets(runtime, item)) {
    if (!client || !await stopExecution(runtime, item, client, target)) return runtime.ledger.get(item.id);
  }
  return runtime.ledger.update(item.id, current => {
    if (current.status !== 'pausing' || current.activeRunner !== undefined) return current;
    return {
      ...current, status: 'paused',
      pauses: replacePause(current, { ...latestPause(current), stoppedAt: new Date().toISOString(), stopAttempt: 'confirmed' }),
    };
  });
}

async function stopExecution(runtime: Runtime, item: WorkItem, client: WorkPauseClient, target: ChatOrigin) {
  await runtime.ledger.update(item.id, current => current.status !== 'pausing' ? current : {
    ...current, pauses: replacePause(current, { ...latestPause(current), stopAttempt: 'submitted' }),
  });
  try {
    return await client.stop(target);
  } catch (error) {
    await runtime.ledger.update(item.id, current => current.status !== 'pausing' ? current : {
      ...current, pauses: replacePause(current, { ...latestPause(current), stopAttempt: 'uncertain' }),
    });
    throw error;
  }
}

/** A completed host step releases only its own claim, preserving the intentional pause and its next stage. */
export function stoppedRunnerPause(current: WorkItem, completed: WorkItem, claimed: WorkItem): WorkItem {
  requireRunnerClaim(current, claimed);
  const fields = Object.keys(WorkItem.shape) as (keyof WorkItem)[];
  const changes = Object.fromEntries(fields
    .filter(field => JSON.stringify(completed[field]) !== JSON.stringify(claimed[field]))
    .map(field => [field, completed[field]]));
  const released = { ...current, ...changes, activeRunner: undefined, runnerClaim: undefined };
  if (!isPaused(current)) return released;
  const receipt = { ...latestPause(current), resumeStatus: completed.status };
  return {
    ...released, status: 'pausing', reason: current.reason,
    humanNotes: current.humanNotes, pauses: replacePause(current, receipt),
  };
}

/** Resume restores the approved intent and exact checkpoint, not a newly submitted plan or approval. */
export async function resumePausedItem(runtime: Runtime, itemId: string, actor: WorkLifecycleActor | string, note?: string) {
  const trusted = requireActor(actor);
  const resumed = await runtime.ledger.updateIfChanged(itemId, async current => {
    const grantActor = GRANT_ACTORS.get(trusted);
    if (grantActor) {
      if (grantActor.runtime !== runtime || grantActor.itemId !== itemId) throw new Error('work_resume_actor_scope_changed');
      await requireManagerAuthority(runtime, grantActor.managerId, current);
    }
    const previous = current.pauses.at(-1);
    if (previous?.resumedAt && current.status === previous.resumeStatus && binding(current) === previous.binding) return undefined;
    if (current.status !== 'paused' || current.activeRunner !== undefined) throw new Error(`work_not_paused: ${current.status}`);
    const receipt = latestPause(current);
    if (!receipt.stoppedAt || binding(current) !== receipt.binding) throw new Error('work_pause_binding_changed');
    const resumed = resumedItem(current, receipt, trusted, note);
    await queueResume(runtime, resumed);
    return resumed;
  });
  await projectPause(runtime, resumed, 'work-running');
  await journalResume(runtime, resumed);
  return resumed;
}

function resumedItem(current: WorkItem, receipt: WorkPauseReceipt, actor: WorkLifecycleActor, note?: string): WorkItem {
  const at = new Date().toISOString();
  return {
    ...current, status: receipt.resumeStatus, reason: undefined,
    pauses: replacePause(current, { ...receipt, resumedAt: at, resumedBy: actor.by, resumedAuthority: actor.authority }),
    humanNotes: [...current.humanNotes, {
      kind: 'resume', by: actor.by, at, note: note?.trim() || `continue from ${receipt.resumeStatus}`,
    }],
  };
}

async function journalResume(runtime: Runtime, resumed: WorkItem) {
  const receipt = resumed.pauses.at(-1)!;
  if (receipt.resumedAuthority === 'standing-grant') {
    await runtime.notebook(resumed.owner).journalOnce({
      kind: 'grant-used', workItem: resumed.id, note: `${receipt.resumedBy}: resume approved by standing approve-plans grant`,
      source: `work-resume-grant:${receipt.id}`,
    }, receipt.resumedAt!);
  }
  await runtime.notebook(resumed.owner).journalOnce({
    kind: 'resumed', workItem: resumed.id, note: `${receipt.resumedBy}: continue from ${resumed.status}`,
    source: `work-resume:${receipt.id}`,
  }, receipt.resumedAt!);
}

async function queueResume(runtime: Runtime, item: WorkItem) {
  const [origin] = await executionTargets(runtime, item);
  if (!origin || !['working', 'planning'].includes(item.status)) return;
  const receipt = item.pauses.at(-1)!;
  const notice: WorkNotice = {
    id: `${item.id}-resume-${receipt.id}`, owner: item.owner, workItem: item.id,
    origin, change: 'human-resume', at: receipt.resumedAt!,
    text: `${NOTICE_PREFIX} ${receipt.resumedBy} explicitly resumed the ORIGINAL work ${item.id}. `
      + `Continue the same goal and plan from ${item.status}; preserve all existing approvals and gates.\n`
      + `Goal: ${item.proposal.goal}\n<current-plan>\n${item.planDocument?.markdown ?? item.proposal.goal}\n</current-plan>`,
  };
  const prepared = await initialResumeNotice(runtime, item, origin, notice);
  if (prepared) return queueNotice(runtime, prepared);
}

/** Only positive non-admission proof permits delivering the initial stage instructions through the resume receipt. */
async function initialResumeNotice(runtime: Runtime, item: WorkItem, origin: ChatOrigin, notice: WorkNotice) {
  const kind = OPENING_KIND[item.status];
  if (item.workflow !== OWNER_CHANGE_WORKFLOW || !kind) return notice;
  const opening = (await currentOpenings(runtime, item)).find(candidate => candidate.key.kind === kind
    && candidate.phase === 'blocked' && candidate.disposition === 'not-prompted'
    && candidate.origin?.sessionID === origin.sessionID && candidate.origin.directory === origin.directory);
  if (!opening) return notice;
  const id = `${item.id}-resume-opening-${opening.token}`;
  const existing = await readNotice(runtime, id);
  if (!existing) return { ...notice, id, text: `${notice.text}\n\n${OWNER_SESSIONS[kind].prompt(item)}` };
  if (existing.workItem !== item.id || existing.owner !== item.owner
    || existing.origin?.sessionID !== origin.sessionID || existing.origin.directory !== origin.directory) {
    throw new Error('work_resume_initial_notice_binding_mismatch');
  }
  const { workNoticeDeliveries } = await import('./work-notice-delivery.ts');
  const delivered = (await workNoticeDeliveries(runtime)).find(receipt => receipt.noticeID === id);
  if (delivered?.status !== 'sent') return undefined;
  if (delivered.origin.sessionID !== origin.sessionID || delivered.origin.directory !== origin.directory) {
    throw new Error('work_resume_initial_delivery_binding_mismatch');
  }
  return notice;
}
/** A paused item's conversation and all remembered children remain read-only until an explicit resume. */
export async function pausedSessionItem(runtime: Runtime, sessionID: string,
  parent?: (sessionID: string) => Promise<string | undefined>) {
  const items = (await runtime.ledger.list()).filter(isPaused);
  if (!items.length) return undefined;
  const targets = await Promise.all(items.map(async item => ({ item, origins: await executionTargets(runtime, item) })));
  const { sessionHistory } = await import('./session-history.ts');
  const history = (await Promise.all([...runtime.declarations.owners.keys()].map(owner => sessionHistory(runtime, owner)))).flat();
  const sessions = new Map(history.map(session => [session.id, session]));
  const visited = new Set<string>();
  for (let current: string | undefined = sessionID; current;
    current = sessions.get(current)?.parentID ?? await parent?.(current)) {
    if (visited.has(current)) throw new Error('work_pause_session_cycle');
    visited.add(current);
    const matched = targets.find(candidate => candidate.origins.some(origin => origin.sessionID === current));
    if (matched) return matched.item;
  }
  return undefined;
}
