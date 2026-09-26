import { join } from 'node:path';
import { z } from 'zod';
import {
  approveCreate, approveDelete, approvePlan, approvePush, chatDirectory, denyRequest, deskState, describeAsk,
  domainSummary, itemText, revisePlan, resumeItem, retryItem, cancelItem, memoryFingerprint, type ResourceRequest, type Runtime,
  listAttention, changeAttention, recoverRequest, reconcileRequest,
  listFriction, frictionDetail, type FrictionRecord,
  approveInitiative, reviseInitiative, cancelInitiative, initiativeViews, managerOf, planGrantFor, cancelReminder,
  type AssignmentView, type Initiative, type InitiativeView, type WorkItem,
  isDelegated, isFinished, OWNER_CHANGE_WORKFLOW, PLAN_APPROVAL_PERMISSION, OPERATOR_ID, operatorChatDirectory, WIKI_DELETE_PERMISSION,
  providerHealthViews, type ProviderHealthView, type OwnerDeclaration,
} from '@onionsoup/owners';
import type { OpencodeApi, PendingPermission, PendingQuestion } from './opencode.ts';
import { planApprovalOf, type PlanApprovalRequest } from './plan-approval-request.ts';
import { readSessionMessages, readSessionsTitled } from './hire-store.ts';
import { ordered, SettingsStore } from './settings.ts';
import type { PublicFrictionRecord } from './friction-public.ts';
import type { InitiativeSummary, OrgEntry, PublicAssignment, PublicInitiative } from './initiative-public.ts';
import { InboxReadError } from './inbox-errors.ts';
import type { ItemSession } from './item-session-public.ts';
import { hasBusySession, ownerActivity, type OwnerActivity } from './activity.ts';
import type { RuntimeWork } from './runtime-work-public.ts';

interface OpencodeSession { id: string; title: string; directory: string; parentID?: string; time: { created: number; updated: number } }

/**
 * The surface's view of onionsoup: owners with what waits on the person, one inbox across all of them, and the
 * decisions the person takes. Reads and decisions go through the same engine functions the CLI uses, lock-free,
 * so the running daemon carries on from whatever is decided here.
 */
const DONE = new Set(['landed', 'failed', 'rejected', 'cancelled']);
const RUNNING = new Set(['planning', 'working', 'implementing', 'reviewing', 'landing']);

const RECOVERY_GUIDANCE: Partial<Record<ResourceRequest['status'], string>> = {
  'pending-owner': 'Owner decision retries exhausted; check the provider before retrying.',
  'work-running': 'Work status checks failed; inspect the linked work item before retrying.',
};

function requestRecoveryDetail(request: ResourceRequest) {
  const stage = request.operation?.stage;
  const guidance = stage ? RECOVERY_GUIDANCE[stage] : undefined;
  return [request.reason ?? 'Interrupted',
    `operation ${request.operation?.id ?? 'unknown'} (${stage ?? 'unknown'})`,
    guidance ?? 'Inspect effects before retrying. Stopping an instance request retains its cleanup gate.',
  ].join('; ');
}

/** Gates asked in chat that only the person answers: auto-accept never approves a plan, a ship, an owner change or a wiki delete. */
const PERSON_GATES = new Set([PLAN_APPROVAL_PERMISSION, 'onionsoup_ship', 'onionsoup_owner_change', WIKI_DELETE_PERMISSION]);

/** Delegated plans wait in the inbox; a plan submitted from the person's chat is answered there instead. */
function waitsInInbox(item: WorkItem) {
  return item.status === 'awaiting-plan-approval' && item.workflow === OWNER_CHANGE_WORKFLOW && isDelegated(item);
}

function awaitsPush(item: WorkItem) {
  return item.status === 'awaiting-push-approval';
}

function pushEntry(item: WorkItem): InboxEntry {
  return { kind: 'push', id: item.id, owner: item.owner, title: item.proposal.title, detail: item.rebaseOf?.prUrl ?? '', at: item.updatedAt };
}

/** A person's decision on an engine gate, parsed once at the HTTP edge. */
export const Decision = z.object({
  action: z.string().trim().min(1),
  id: z.string().trim().min(1),
  note: z.string().optional(),
  reason: z.string().optional(),
  withDelete: z.boolean().optional(),
});
export type Decision = z.infer<typeof Decision>;

export interface InboxEntry {
  kind: 'plan' | 'push' | 'create' | 'delete' | 'permission' | 'question' | 'request-recovery' | 'attention' | 'initiative' | 'provider-auth';
  id: string;
  owner: string;
  title: string;
  detail: string;
  at?: string;
  attentionStatus?: string;
  /** For permission and question entries: the chat they came from. */
  sessionID?: string;
  permission?: PendingPermission;
  planApproval?: PlanApprovalRequest;
  question?: PendingQuestion;
}

function permissionEntry(ownerId: string, permission: PendingPermission): InboxEntry {
  const planApproval = planApprovalOf(permission);
  const title = planApproval ? `Approve plan ${planApproval.item}: ${planApproval.title}` : `${permission.permission}: ${permission.patterns.join(', ')}`;
  return { kind: 'permission', id: permission.id, owner: ownerId, sessionID: permission.sessionID, title, detail: '', permission, planApproval };
}

/** Provider problems belong to the engine, not to one owner. */
export const ENGINE_INBOX_OWNER = 'onionsoup';

function affectedText(view: ProviderHealthView) {
  const uses = [...new Set(view.affected.map(use => `${use.kind} ${use.what}`))];
  return uses.join(', ') || 'none recorded';
}

/** A failing provider waits on the person: nothing works on it until they fix its credentials. */
function providerAuthEntry(view: ProviderHealthView): InboxEntry {
  const plural = view.failures === 1 ? '' : 's';
  return {
    kind: 'provider-auth', id: view.provider, owner: ENGINE_INBOX_OWNER, title: `${view.name} authentication failing`, at: view.lastFailureAt,
    detail: `Failing since ${view.since}: ${view.failures} failure${plural}. Affected: ${affectedText(view)}.
${view.fix}
Last error: ${view.lastError}`,
  };
}

export interface OwnerSummary {
  id: string;
  name: string;
  title: string;
  source: string;
  icon: string;
  color: string;
  model: string;
  domain: string;
  /** Owners without a persona have no chat agent. */
  chat: boolean;
  /** The operator has chats but no desk: no work, notebook or activity. */
  hasDesk: boolean;
  waiting: number;
  running: number;
  /** Work its host code is running right now, listed under it in the rail. */
  runtimeWork: RuntimeWork[];
  /** Whether it is working (a chat or runtime work), stopped on the person, or idle. */
  activity: OwnerActivity;
}

/** What the rail needs from one read of the inbox: the entries, and which chats have a busy session. */
export interface ChatSnapshot { inbox: InboxEntry[]; busyChats: ReadonlySet<string> }

/** Kinds of inbox entry that stop a chat session until the person answers. */
const CHAT_WAIT_KINDS = new Set<InboxEntry['kind']>(['permission', 'question']);

function chatActivity(chatId: string, { inbox, busyChats }: ChatSnapshot, runtimeWork: readonly RuntimeWork[]) {
  const isWaiting = inbox.some(entry => entry.owner === chatId && CHAT_WAIT_KINDS.has(entry.kind));
  return ownerActivity({ isWaiting, isWorking: busyChats.has(chatId), hasRuntimeWork: runtimeWork.length > 0 });
}

/** An item a runner holds right now: host code is working on it, whatever its chats are doing. */
function isRuntimeWork(item: WorkItem) {
  return item.activeRunner !== undefined && !isFinished(item);
}

function runtimeWorkOf(items: readonly WorkItem[], ownerId: string): RuntimeWork[] {
  return items.filter(item => item.owner === ownerId && isRuntimeWork(item))
    .map(item => ({ id: item.id, title: item.proposal.title, status: item.status }));
}

/** How deep an assignment sits in its initiative's dependency order: 0 needs nothing first. */
function dependencyDepths(assignments: readonly AssignmentView[]) {
  const byId = new Map(assignments.map(assignment => [assignment.id, assignment]));
  const depths = new Map<string, number>();
  const depth = (id: string, path: readonly string[]): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    // A draft may still hold a cycle; submission refuses it, so draw it flat rather than recurse forever.
    const after = (byId.get(id)?.after ?? []).filter(dependency => !path.includes(dependency));
    const value = after.length ? 1 + Math.max(...after.map(dependency => depth(dependency, [...path, id]))) : 0;
    depths.set(id, value);
    return value;
  };
  return new Map(assignments.map(assignment => [assignment.id, depth(assignment.id, [])]));
}

function publicAssignment(assignment: AssignmentView, depth: number): PublicAssignment {
  const { item } = assignment;
  return {
    id: assignment.id, to: assignment.to, title: assignment.proposal.title, after: assignment.after, depth, state: assignment.state,
    request: assignment.request,
    item: item && { id: item.id, status: item.status, url: item.publication?.url, prState: item.publication?.state },
  };
}

function publicInitiative(view: InitiativeView): PublicInitiative {
  const { origin: _origin, assignments, ...fields } = view;
  const depths = dependencyDepths(assignments);
  const shown = assignments.map(assignment => publicAssignment(assignment, depths.get(assignment.id) ?? 0));
  return { ...fields, assignments: shown.sort((left, right) => left.depth - right.depth) };
}

function initiativeSummary(view: InitiativeView): InitiativeSummary {
  return {
    id: view.id, owner: view.owner, title: view.title, status: view.status, revision: view.revision,
    merged: view.assignments.filter(assignment => assignment.state === 'completed').length, total: view.assignments.length,
    openEscalations: view.escalations.filter(escalation => !escalation.resolution).length, updatedAt: view.updatedAt,
  };
}

export class SurfaceState {
  private readonly directories = new Map<string, string>();

  readonly settings: SettingsStore;

  constructor(
    readonly runtime: Runtime,
    readonly opencode: OpencodeApi,
    private readonly resolveDirectory: (runtime: Runtime, ownerId: string) => Promise<string> = chatDirectory,
    settingsFile = join(runtime.stateDirectory, '..', 'surface', 'settings.json'),
    /** How hire sessions' messages are read (opencode's store; replaceable in tests). */
    readonly hireMessages: (sessionID: string) => unknown[] = sessionID => readSessionMessages(sessionID),
    readonly hireSessions: (prefix: string) => { id: string; title: string; directory: string; time: { created: number; updated: number } }[] = prefix => readSessionsTitled(prefix),
  ) {
    this.settings = new SettingsStore(settingsFile);
  }

  /** The operator, when the person declared one and this chat id is its. */
  private operatorOf(chatId: string) {
    return chatId === OPERATOR_ID ? this.runtime.declarations.operator : undefined;
  }

  /** Chats are an owner's, or the operator's: the only other chat the surface opens. */
  isKnownChat(chatId: string) {
    return this.runtime.declarations.owners.has(chatId) || Boolean(this.operatorOf(chatId));
  }

  /** An owner's chat directory (desk or evidence folder), or the operator's declared one, resolved once. */
  async directory(chatId: string) {
    const known = this.directories.get(chatId);
    if (known) return known;
    const operator = this.operatorOf(chatId);
    const path = operator ? await operatorChatDirectory(operator) : await this.resolveDirectory(this.runtime, chatId);
    this.directories.set(chatId, path);
    return path;
  }

  agentOf(chatId: string) {
    const operator = this.operatorOf(chatId);
    if (operator) return operator.name;
    const owner = this.runtime.owner(chatId);
    if (!owner.persona) throw new Error(`no_chat: ${chatId} has no persona, so no chat agent`);
    return owner.persona.name;
  }

  /** Every chat the person can have: owners with a persona, then the operator if declared. */
  private chatIds() {
    const owners = [...this.runtime.declarations.owners.values()].filter(owner => owner.persona).map(owner => owner.id);
    return this.runtime.declarations.operator ? [...owners, OPERATOR_ID] : owners;
  }

  /** Everything waiting on the person, across owners: engine gates, then chat permissions and questions. */
  async inbox(): Promise<InboxEntry[]> {
    return (await this.inboxSnapshot()).inbox;
  }

  async inboxSnapshot() {
    const items = await this.runtime.ledger.list();
    const requests = await this.runtime.requests.list();
    const attention = await listAttention(this.runtime);
    const initiatives = await this.runtime.initiatives.list();
    const providerHealth = await providerHealthViews(this.runtime);
    const entries: InboxEntry[] = [
      ...providerHealth.filter(view => view.status === 'failing').map(providerAuthEntry),
      ...attention.filter(entry => entry.status !== 'resolved').map(entry => ({
        kind: 'attention' as const, id: entry.id, owner: entry.owner, title: entry.note,
        detail: entry.decision ? `${entry.status}: ${entry.decision.reason} (${entry.decision.by})` : 'Needs attention',
        attentionStatus: entry.status, at: entry.decision?.at ?? entry.at,
      })),
      ...requests.filter(request => request.status === 'interrupted').map(request => ({
        kind: 'request-recovery' as const, id: request.id, owner: request.to, title: describeAsk(request.ask),
        detail: requestRecoveryDetail(request), at: request.updatedAt,
      })),
      ...initiatives.filter(initiative => initiative.status === 'awaiting-approval').map(initiative => this.initiativeEntry(initiative)),
      ...items.filter(waitsInInbox).map(item => this.planEntry(item, initiatives)),
      ...items.filter(awaitsPush).map(pushEntry),
      ...requests.filter(request => request.status === 'awaiting-create-approval').map(request => ({ kind: 'create' as const, id: request.id, owner: request.to, title: `${request.from} asks: ${describeAsk(request.ask)}`, detail: request.ask.purpose, at: request.updatedAt })),
      ...requests.filter(request => request.status === 'awaiting-delete-approval').map(request => ({ kind: 'delete' as const, id: request.id, owner: request.to, title: `Delete ${request.instance?.remote}:${request.instance?.name}`, detail: request.followUpResult?.summary ?? '', at: request.updatedAt })),
    ];
    const chats = await this.chatInbox();
    return { inbox: [...entries, ...chats.entries], inboxErrors: chats.errors, busyChats: chats.busyChats, providerHealth };
  }

  /** Pending prompts and questions across every chat, and which chats have a session busy in opencode. */
  private async chatInbox() {
    const entries: InboxEntry[] = [];
    const errors: InboxReadError[] = [];
    const busyChats = new Set<string>();
    for (const chatId of this.chatIds()) {
      const unavailable = (code: InboxReadError['code']) => {
        errors.push(InboxReadError.parse({ owner: chatId, code }));
        return [];
      };
      const directories = await this.ownerDirectories(chatId).catch(() => unavailable('chat_directory_failed'));
      const reads = await Promise.all(directories.map(directory => this.directoryInbox(chatId, directory, unavailable)));
      entries.push(...reads.flatMap(read => read.entries));
      if (reads.some(read => read.isBusy)) busyChats.add(chatId);
    }
    return { entries, errors, busyChats: busyChats as ReadonlySet<string> };
  }

  /**
   * The permission prompts and questions waiting in one of an owner's directories, and whether any session there
   * (a chat, a plan's session, a subagent) is busy. A status that cannot be read counts as idle.
   */
  private async directoryInbox(ownerId: string, directory: string, unavailable: (code: InboxReadError['code']) => never[]) {
    const [permissions, questions, status] = await Promise.all([
      this.opencode.permissions(directory).catch(() => unavailable('permission_list_failed')),
      this.opencode.questions(directory).catch(() => unavailable('question_list_failed')),
      this.opencode.status(directory).catch(() => ({})),
    ]);
    const entries = [
      ...permissions.map(permission => permissionEntry(ownerId, permission)),
      ...questions.map((question): InboxEntry => ({ kind: 'question', id: question.id, owner: ownerId, sessionID: question.sessionID, title: question.questions[0]?.question ?? 'A question', detail: '', question })),
    ];
    return { entries, isBusy: hasBusySession(status) };
  }

  /**
   * Every directory an owner's sessions run in: its chat directory, and the worktree of each approved plan it is
   * carrying out, where that plan's session runs (its prompts, questions and events come from there).
   */
  async ownerDirectories(ownerId: string) {
    const plans = (await this.runtime.ledger.list()).filter(item => item.owner === ownerId && item.planWorktree);
    return [...new Set([await this.directory(ownerId), ...plans.map(item => item.planWorktree!)])];
  }

  /** Where one of an owner's sessions runs: a plan's session where the item records it, any other in the chat directory. */
  async sessionDirectory(ownerId: string, sessionID: string) {
    const item = (await this.runtime.ledger.list()).find(candidate => candidate.owner === ownerId && candidate.session?.sessionID === sessionID);
    return item?.session?.directory ?? this.directory(ownerId);
  }

  /** The owner's directory a prompt or question waits in; the chat directory when none lists it. */
  async pendingDirectory(ownerId: string, kind: 'permission' | 'question', requestID: string) {
    const listers: Record<typeof kind, (directory: string) => Promise<{ id: string }[]>> = {
      permission: directory => this.opencode.permissions(directory),
      question: directory => this.opencode.questions(directory),
    };
    for (const directory of await this.ownerDirectories(ownerId)) {
      const pending = await listers[kind](directory).catch(() => []);
      if (pending.some(entry => entry.id === requestID)) return directory;
    }
    return this.directory(ownerId);
  }

  /** An owner's chats across its directories, root sessions and subagents alike, with each directory's session status. */
  async chatSessions(ownerId: string) {
    const [directory, ...planDirectories] = await this.ownerDirectories(ownerId);
    const listed = await Promise.all([
      this.directorySessions(directory!),
      ...planDirectories.map(planDirectory => this.directorySessions(planDirectory).catch(() => ({ sessions: [], status: {} }))),
    ]);
    return {
      directory: directory!, directories: [directory!, ...planDirectories],
      sessions: listed.flatMap(entry => entry.sessions), status: Object.assign({}, ...listed.map(entry => entry.status)) as Record<string, unknown>,
    };
  }

  private async directorySessions(directory: string) {
    const [sessions, status] = await Promise.all([this.opencode.listSessions(directory), this.opencode.status(directory).catch(() => ({}))]);
    return { sessions, status };
  }

  private nameOf(ownerId: string) {
    return this.runtime.declarations.owners.get(ownerId)?.persona?.name ?? ownerId;
  }

  private initiativeEntry(initiative: Initiative): InboxEntry {
    const reports = [...new Set(initiative.assignments.map(assignment => assignment.to))].join(', ');
    return {
      kind: 'initiative', id: initiative.id, owner: initiative.owner, title: `Initiative: ${initiative.title}`,
      detail: `${initiative.assignments.length} assignments to ${reports}. ${initiative.goal}`, at: initiative.updatedAt,
    };
  }

  /** The manager holding this plan's approve-plans grant, when her review comes before the person's. */
  private planReviewer(item: WorkItem, initiatives: readonly Initiative[]) {
    const initiative = initiatives.find(candidate => candidate.id === item.assignment?.initiative && candidate.status === 'approved');
    if (!initiative) return undefined;
    const owner = this.runtime.declarations.owners.get(item.owner);
    const repository = this.runtime.repositoryFor(item).domain.name;
    return owner && planGrantFor(owner, initiative.owner, repository) ? this.nameOf(initiative.owner) : undefined;
  }

  private planEntry(item: WorkItem, initiatives: readonly Initiative[]): InboxEntry {
    const reviewer = this.planReviewer(item, initiatives);
    const summary = item.proposal.goal;
    return {
      kind: 'plan', id: item.id, owner: item.owner, title: item.proposal.title, at: item.updatedAt,
      detail: reviewer ? `${reviewer} reviews under standing grant. ${summary}` : summary,
    };
  }

  /** Every owner with its manager, for the org chart. */
  org(): OrgEntry[] {
    return [...this.runtime.declarations.owners.values()].map(owner => ({
      id: owner.id, name: owner.persona?.name ?? owner.id, title: owner.persona?.title ?? '', icon: owner.persona?.icon ?? 'briefcase',
      domain: domainSummary(owner), manager: managerOf(this.runtime.declarations, owner.id)?.id,
    }));
  }

  async initiatives() {
    return (await initiativeViews(this.runtime)).map(initiativeSummary);
  }

  async initiative(initiativeId: string) {
    const view = (await initiativeViews(this.runtime)).find(candidate => candidate.id === initiativeId);
    if (!view) throw new Error(`initiative_not_found: ${initiativeId}`);
    return publicInitiative(view);
  }

  async owners(snapshot?: ChatSnapshot): Promise<OwnerSummary[]> {
    const chats = snapshot ?? await this.inboxSnapshot();
    const items = await this.runtime.ledger.list();
    const { ownerOrder } = await this.settings.read();
    return ordered([...this.runtime.declarations.owners.values()], ownerOrder).map(owner => this.ownerSummary(owner, chats, items));
  }

  private ownerSummary(owner: OwnerDeclaration, chats: ChatSnapshot, items: readonly WorkItem[]): OwnerSummary {
    const runtimeWork = runtimeWorkOf(items, owner.id);
    return {
      id: owner.id,
      name: owner.persona?.name ?? owner.id,
      title: owner.persona?.title ?? '',
      source: owner.persona?.source ?? '',
      icon: owner.persona?.icon ?? 'briefcase',
      color: owner.persona?.color ?? 'primary',
      model: owner.model,
      domain: domainSummary(owner),
      chat: Boolean(owner.persona),
      hasDesk: true,
      waiting: chats.inbox.filter(entry => entry.owner === owner.id).length,
      running: items.filter(item => item.owner === owner.id && RUNNING.has(item.status)).length,
      runtimeWork,
      activity: chatActivity(owner.id, chats, runtimeWork),
    };
  }

  async owner(ownerId: string) {
    return deskState(this.runtime, { owner: ownerId });
  }

  /** The operator's entry in the surface, when the person declared one: a chat of its own, apart from the owners. */
  async operator(snapshot: ChatSnapshot): Promise<OwnerSummary | undefined> {
    const operator = this.runtime.declarations.operator;
    if (!operator) return undefined;
    return {
      id: OPERATOR_ID, name: operator.name, title: operator.title, source: '', icon: operator.icon, color: 'primary',
      model: operator.model, domain: operator.directory, chat: true, hasDesk: false,
      waiting: snapshot.inbox.filter(entry => entry.owner === OPERATOR_ID).length, running: 0, runtimeWork: [],
      activity: chatActivity(OPERATOR_ID, snapshot, []),
    };
  }

  /** A work item, with the decision it waits on in the inbox's terms, so its page can take it with the same card. */
  async item(itemId: string) {
    const item = await this.runtime.ledger.get(itemId);
    const initiatives = await this.runtime.initiatives.list();
    const decisions: [(candidate: WorkItem) => boolean, (candidate: WorkItem) => InboxEntry][] = [
      [waitsInInbox, candidate => this.planEntry(candidate, initiatives)], [awaitsPush, pushEntry],
    ];
    const waiting = decisions.find(([applies]) => applies(item))?.[1](item);
    return { item, waiting, text: itemText(item), done: DONE.has(item.status) };
  }

  /** Public view excludes the saved directory, which is only for host-side notice delivery. */
  private publicFriction(record: FrictionRecord): PublicFrictionRecord {
    const { origin, ...fields } = record;
    return { ...fields, sessionID: origin.sessionID };
  }

  async friction() {
    return (await listFriction(this.runtime)).map(record => this.publicFriction(record));
  }

  async frictionRecord(id: string) {
    return this.publicFriction(await frictionDetail(this.runtime, id));
  }

  /** The owner session carrying out an item's plan, and the subagent sessions it started. */
  private async ownerSessions(item: WorkItem): Promise<ItemSession[]> {
    if (!item.session) return [];
    const { sessionID, directory } = item.session;
    const sessions = await this.opencode.listSessions(directory).catch(() => []) as OpencodeSession[];
    const related = sessions.filter(session => session.id === sessionID || session.parentID === sessionID);
    return related.map(session => ({
      ...session, kind: 'owner' as const, label: session.id === sessionID ? 'work session' : session.title,
    }));
  }

  /**
   * The sessions of a work item, oldest first: the hires onionsoup ran for it (found by the title every hire gets,
   * "<item>: <stage>"), and the owner session carrying out its plan with its subagents. Each carries its directory.
   */
  async itemSessions(itemId: string): Promise<ItemSession[]> {
    const item = await this.runtime.ledger.get(itemId);
    const hires = this.hireSessions(`${item.id}: `).map(session => ({ ...session, kind: 'hire' as const, label: session.title.slice(item.id.length + 2) }));
    return [...hires, ...await this.ownerSessions(item)].sort((left, right) => left.time.created - right.time.created);
  }

  /** One of an item's sessions, read where it lives. */
  async itemSessionMessages(itemId: string, sessionID: string) {
    const session = (await this.itemSessions(itemId)).find(candidate => candidate.id === sessionID);
    if (!session) return undefined;
    const readers: Record<ItemSession['kind'], () => Promise<unknown[]> | unknown[]> = {
      hire: () => this.hireMessages(session.id),
      owner: () => this.opencode.messages(session.directory, session.id),
    };
    return readers[session.kind]();
  }

  /** A person's decision on an engine gate. Returns a one-line outcome. */
  async decide(decision: Decision, by: string) {
    const reason = decision.reason?.trim();
    const actions: Record<string, () => Promise<string>> = {
      'approve-plan': async () => (await approvePlan(this.runtime, decision.id, by, decision.note)).status,
      'revise-plan': async () => (await revisePlan(this.runtime, decision.id, by, required(decision.note, 'note'))).status,
      'approve-push': async () => (await approvePush(this.runtime, decision.id, by)).status,
      'approve-create': async () => (await approveCreate(this.runtime, decision.id, by, decision.withDelete ?? true)).status,
      'approve-delete': async () => (await approveDelete(this.runtime, decision.id, by)).status,
      'deny-request': async () => (await denyRequest(this.runtime, decision.id, by, reason || 'denied from the surface')).status,
      'resume-item': async () => (await resumeItem(this.runtime, decision.id, by, reason)).status,
      'retry-item': async () => (await retryItem(this.runtime, decision.id, by, reason)).status,
      'cancel-item': async () => (await cancelItem(this.runtime, decision.id, by, required(reason, 'reason'))).status,
      'reconcile-request': async () => (await reconcileRequest(this.runtime, decision.id)).status,
      'retry-request': async () => (await recoverRequest(this.runtime, decision.id, 'retry', by, required(reason, 'reason'))).status,
      'cancel-request': async () => (await recoverRequest(this.runtime, decision.id, 'cancel', by, required(reason, 'reason'))).status,
      'acknowledge-attention': async () => (await changeAttention(this.runtime, decision.id, 'acknowledged', by, required(reason, 'reason'))).status,
      'resolve-attention': async () => (await changeAttention(this.runtime, decision.id, 'resolved', by, required(reason, 'reason'))).status,
      'approve-initiative': async () => (await approveInitiative(this.runtime, decision.id, by, decision.note)).status,
      'revise-initiative': async () => (await reviseInitiative(this.runtime, decision.id, by, required(decision.note, 'note'))).status,
      'cancel-initiative': async () => (await cancelInitiative(this.runtime, decision.id, by, required(reason, 'reason'))).status,
      'cancel-reminder': async () => (await cancelReminder(this.runtime, decision.id, by, reason ?? '')).status,
    };
    const action = actions[decision.action];
    if (!action) throw new Error(`unknown_decision: ${decision.action}`);
    return action();
  }

  async retract(ownerId: string, note: string) {
    const notebook = this.runtime.notebook(ownerId);
    await notebook.journal({ kind: 'retracted', note });
    await notebook.commit('retraction').catch(() => undefined);
  }

  /**
   * Answer "allow once" to pending permission prompts in chats the person set to auto-accept, including sub-chats of
   * such a chat (a subagent's session inherits its parent's setting). Returns how many were answered.
   */
  async autoAnswer(directory: string) {
    const { autoAccept } = await this.settings.read();
    if (!Object.keys(autoAccept).length) return 0;
    const pending = await this.opencode.permissions(directory);
    if (!pending.length) return 0;
    const sessions = await this.opencode.listSessions(directory).catch(() => []) as { id: string; parentID?: string }[];
    const parent = new Map(sessions.map(session => [session.id, session.parentID]));
    const accepted = (sessionID: string) => {
      for (let current: string | undefined = sessionID, depth = 0; current && depth < 10; current = parent.get(current), depth++) {
        if (autoAccept[current]) return true;
      }
      return false;
    };
    let answered = 0;
    for (const permission of pending.filter(entry => accepted(entry.sessionID) && !PERSON_GATES.has(entry.permission))) {
      await this.opencode.replyPermission(directory, permission.id, 'once');
      answered++;
    }
    return answered;
  }

  async autoAnswerAll() {
    const { autoAccept } = await this.settings.read();
    if (!Object.keys(autoAccept).length) return;
    for (const chatId of this.chatIds()) {
      const directories = await this.ownerDirectories(chatId).catch(() => []);
      for (const directory of directories) await this.autoAnswer(directory);
    }
  }

  /** A cheap fingerprint of engine state, so the event stream can say "onionsoup changed" only when it did. */
  async fingerprint() {
    const items = await this.runtime.ledger.list();
    const requests = await this.runtime.requests.list();
    return JSON.stringify([
      items.map(item => [item.id, item.status, item.updatedAt, item.activeRunner]),
      requests.map(request => [request.id, request.status, request.updatedAt]),
      (await this.runtime.initiatives.list()).map(initiative => [initiative.id, initiative.status, initiative.updatedAt]),
      await memoryFingerprint(this.runtime),
      await listAttention(this.runtime),
      (await listFriction(this.runtime)).map(entry => [entry.id, entry.count, entry.lastSeen]),
      (await this.runtime.providerHealth.list()).map(record => [record.provider, record.status, record.failures]),
    ]);
  }
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
