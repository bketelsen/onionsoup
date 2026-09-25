import { join } from 'node:path';
import { z } from 'zod';
import {
  approveCreate, approveDelete, approvePlan, approvePush, chatDirectory, denyRequest, deskState, describeAsk,
  domainSummary, itemText, revisePlan, resumeItem, retryItem, cancelItem, memoryFingerprint, type ResourceRequest, type Runtime,
  listAttention, changeAttention, recoverRequest, reconcileRequest,
  listFriction, frictionDetail, type FrictionRecord,
  approveInitiative, reviseInitiative, cancelInitiative, initiativeViews, managerOf, planGrantFor,
  type AssignmentView, type Initiative, type InitiativeView, type WorkItem,
  isDelegated, OWNER_CHANGE_WORKFLOW, PLAN_APPROVAL_PERMISSION,
} from '@onionsoup/owners';
import type { OpencodeApi, PendingPermission, PendingQuestion } from './opencode.ts';
import { readSessionMessages, readSessionsTitled } from './hire-store.ts';
import { ordered, SettingsStore } from './settings.ts';
import type { PublicFrictionRecord } from './friction-public.ts';
import type { InitiativeSummary, OrgEntry, PublicAssignment, PublicInitiative } from './initiative-public.ts';
import { InboxReadError } from './inbox-errors.ts';

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

/** Gates asked in chat that only the person answers: auto-accept never approves a plan, a ship or an owner change. */
const PERSON_GATES = new Set([PLAN_APPROVAL_PERMISSION, 'onionsoup_ship', 'onionsoup_owner_change']);

/** Delegated plans wait in the inbox; a plan submitted from the person's chat is answered there instead. */
function waitsInInbox(item: WorkItem) {
  return item.status === 'awaiting-plan-approval' && item.workflow === OWNER_CHANGE_WORKFLOW && isDelegated(item);
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
  kind: 'plan' | 'push' | 'create' | 'delete' | 'permission' | 'question' | 'request-recovery' | 'attention' | 'initiative';
  id: string;
  owner: string;
  title: string;
  detail: string;
  at?: string;
  attentionStatus?: string;
  /** For permission and question entries: the chat they came from. */
  sessionID?: string;
  permission?: PendingPermission;
  question?: PendingQuestion;
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
  waiting: number;
  running: number;
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

  /** The owner's chat directory (desk or evidence folder), resolved once. */
  async directory(ownerId: string) {
    const known = this.directories.get(ownerId);
    if (known) return known;
    const path = await this.resolveDirectory(this.runtime, ownerId);
    this.directories.set(ownerId, path);
    return path;
  }

  agentOf(ownerId: string) {
    const owner = this.runtime.owner(ownerId);
    if (!owner.persona) throw new Error(`no_chat: ${ownerId} has no persona, so no chat agent`);
    return owner.persona.name;
  }

  private chatOwners() {
    return [...this.runtime.declarations.owners.values()].filter(owner => owner.persona);
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
    const entries: InboxEntry[] = [
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
      ...items.filter(item => item.status === 'awaiting-push-approval').map(item => ({ kind: 'push' as const, id: item.id, owner: item.owner, title: item.proposal.title, detail: item.rebaseOf?.prUrl ?? '', at: item.updatedAt })),
      ...requests.filter(request => request.status === 'awaiting-create-approval').map(request => ({ kind: 'create' as const, id: request.id, owner: request.to, title: `${request.from} asks: ${describeAsk(request.ask)}`, detail: request.ask.purpose, at: request.updatedAt })),
      ...requests.filter(request => request.status === 'awaiting-delete-approval').map(request => ({ kind: 'delete' as const, id: request.id, owner: request.to, title: `Delete ${request.instance?.remote}:${request.instance?.name}`, detail: request.followUpResult?.summary ?? '', at: request.updatedAt })),
    ];
    const chats = await this.chatInbox();
    return { inbox: [...entries, ...chats.entries], inboxErrors: chats.errors };
  }

  private async chatInbox() {
    const entries: InboxEntry[] = [];
    const errors: InboxReadError[] = [];
    for (const owner of this.chatOwners()) {
      const unavailable = (code: InboxReadError['code']) => {
        errors.push(InboxReadError.parse({ owner: owner.id, code }));
        return [];
      };
      const directory = await this.directory(owner.id).catch(() => {
        unavailable('chat_directory_failed');
        return undefined;
      });
      if (!directory) continue;
      const [permissions, questions] = await Promise.all([
        this.opencode.permissions(directory).catch(() => unavailable('permission_list_failed')),
        this.opencode.questions(directory).catch(() => unavailable('question_list_failed')),
      ]);
      for (const permission of permissions) entries.push({ kind: 'permission', id: permission.id, owner: owner.id, sessionID: permission.sessionID, title: `${permission.permission}: ${permission.patterns.join(', ')}`, detail: '', permission });
      for (const question of questions) entries.push({ kind: 'question', id: question.id, owner: owner.id, sessionID: question.sessionID, title: question.questions[0]?.question ?? 'A question', detail: '', question });
    }
    return { entries, errors };
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

  async owners(inbox?: InboxEntry[]): Promise<OwnerSummary[]> {
    const waiting = inbox ?? await this.inbox();
    const items = await this.runtime.ledger.list();
    const { ownerOrder } = await this.settings.read();
    return ordered([...this.runtime.declarations.owners.values()], ownerOrder).map(owner => ({
      id: owner.id,
      name: owner.persona?.name ?? owner.id,
      title: owner.persona?.title ?? '',
      source: owner.persona?.source ?? '',
      icon: owner.persona?.icon ?? 'briefcase',
      color: owner.persona?.color ?? 'primary',
      model: owner.model,
      domain: domainSummary(owner),
      chat: Boolean(owner.persona),
      waiting: waiting.filter(entry => entry.owner === owner.id).length,
      running: items.filter(item => item.owner === owner.id && RUNNING.has(item.status)).length,
    }));
  }

  async owner(ownerId: string) {
    return deskState(this.runtime, { owner: ownerId });
  }

  async item(itemId: string) {
    const item = await this.runtime.ledger.get(itemId);
    return { item, text: itemText(item), done: DONE.has(item.status) };
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

  /**
   * The sessions onionsoup ran for a work item (plan, owner answers, implementations, reviews, learnings), found by
   * the title every hire gets ("<item>: <stage>"). Oldest first; each carries the directory it lives in.
   */
  async itemSessions(itemId: string) {
    const item = await this.runtime.ledger.get(itemId);
    return this.hireSessions(`${item.id}: `);
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
    for (const owner of this.chatOwners()) {
      const directory = await this.directory(owner.id).catch(() => undefined);
      if (directory) await this.autoAnswer(directory);
    }
  }

  /** A cheap fingerprint of engine state, so the event stream can say "onionsoup changed" only when it did. */
  async fingerprint() {
    const items = await this.runtime.ledger.list();
    const requests = await this.runtime.requests.list();
    return JSON.stringify([
      items.map(item => [item.id, item.status, item.updatedAt]),
      requests.map(request => [request.id, request.status, request.updatedAt]),
      (await this.runtime.initiatives.list()).map(initiative => [initiative.id, initiative.status, initiative.updatedAt]),
      await memoryFingerprint(this.runtime),
      await listAttention(this.runtime),
      (await listFriction(this.runtime)).map(entry => [entry.id, entry.count, entry.lastSeen]),
    ]);
  }
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
