import { join } from 'node:path';
import {
  approveCreate, approveDelete, approvePlan, approvePush, awaitingPublish, chatDirectory, denyRequest, deskState, describeAsk,
  domainSummary, itemText, publish, rejectPlan, revisePlan, type Runtime,
} from '@onionsoup/owners';
import type { OpencodeApi, PendingPermission, PendingQuestion } from './opencode.ts';
import { readSessionMessages } from './hire-store.ts';
import { ordered, SettingsStore } from './settings.ts';

/**
 * The surface's view of onionsoup: owners with what waits on the person, one inbox across all of them, and the
 * decisions the person takes. Reads and decisions go through the same engine functions the CLI uses, lock-free,
 * so the running daemon carries on from whatever is decided here.
 */
const DONE = new Set(['landed', 'failed', 'rejected']);
const RUNNING = new Set(['planning', 'implementing', 'reviewing', 'landing']);

export interface InboxEntry {
  kind: 'plan' | 'push' | 'publish' | 'create' | 'delete' | 'permission' | 'question';
  id: string;
  owner: string;
  title: string;
  detail: string;
  at?: string;
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
    const items = await this.runtime.ledger.list();
    const requests = await this.runtime.requests.list();
    const entries: InboxEntry[] = [
      ...items.filter(item => item.status === 'awaiting-plan-approval').map(item => ({ kind: 'plan' as const, id: item.id, owner: item.owner, title: item.proposal.title, detail: item.plan?.summary ?? item.proposal.goal, at: item.updatedAt })),
      ...items.filter(item => item.status === 'awaiting-push-approval').map(item => ({ kind: 'push' as const, id: item.id, owner: item.owner, title: item.proposal.title, detail: item.rebaseOf?.prUrl ?? '', at: item.updatedAt })),
      ...items.filter(awaitingPublish).map(item => ({ kind: 'publish' as const, id: item.id, owner: item.owner, title: item.proposal.title, detail: `Landed on ${item.branch}; publishing opens a draft PR.`, at: item.updatedAt })),
      ...requests.filter(request => request.status === 'awaiting-create-approval').map(request => ({ kind: 'create' as const, id: request.id, owner: request.to, title: `${request.from} asks: ${describeAsk(request.ask)}`, detail: request.ask.purpose, at: request.updatedAt })),
      ...requests.filter(request => request.status === 'awaiting-delete-approval').map(request => ({ kind: 'delete' as const, id: request.id, owner: request.to, title: `Delete ${request.instance?.remote}:${request.instance?.name}`, detail: request.followUpResult?.summary ?? '', at: request.updatedAt })),
    ];
    for (const owner of this.chatOwners()) {
      const directory = await this.directory(owner.id).catch(() => undefined);
      if (!directory) continue;
      const [permissions, questions] = await Promise.all([
        this.opencode.permissions(directory).catch(() => []),
        this.opencode.questions(directory).catch(() => []),
      ]);
      for (const permission of permissions) entries.push({ kind: 'permission', id: permission.id, owner: owner.id, sessionID: permission.sessionID, title: `${permission.permission}: ${permission.patterns.join(', ')}`, detail: '', permission });
      for (const question of questions) entries.push({ kind: 'question', id: question.id, owner: owner.id, sessionID: question.sessionID, title: question.questions[0]?.question ?? 'A question', detail: '', question });
    }
    return entries;
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

  /**
   * The sessions onionsoup ran for a work item (plan, owner answers, implementations, reviews, learnings), found by
   * the title every hire gets ("<item>: <stage>") in the two places hires run: the owner's checkout and the item's
   * worktree. Oldest first; each carries the directory it lives in.
   */
  async itemSessions(itemId: string) {
    const item = await this.runtime.ledger.get(itemId);
    const directories = new Set<string>();
    try {
      directories.add(this.runtime.repositoryFor(item).workspace);
    } catch {
      directories.add(this.runtime.owner(item.owner).workspace);
    }
    directories.add(item.worktree ?? join(this.runtime.worktreesRoot, item.owner, item.id));
    const found = new Map<string, { id: string; title: string; directory: string; time: { created: number; updated: number } }>();
    for (const directory of directories) {
      const sessions = await this.opencode.listSessions(directory).catch(() => []) as { id: string; title?: string; directory?: string; time: { created: number; updated: number } }[];
      for (const session of sessions) {
        if (session.title?.startsWith(`${item.id}: `)) found.set(session.id, { id: session.id, title: session.title, directory: session.directory ?? directory, time: session.time });
      }
    }
    return [...found.values()].sort((left, right) => left.time.created - right.time.created);
  }

  /** A person's decision on an engine gate. Returns a one-line outcome. */
  async decide(decision: { action: string; id: string; note?: string; reason?: string; withDelete?: boolean }, by: string) {
    const reason = decision.reason?.trim();
    switch (decision.action) {
      case 'approve-plan': return (await approvePlan(this.runtime, decision.id, by, decision.note)).status;
      case 'revise-plan': return (await revisePlan(this.runtime, decision.id, by, required(decision.note, 'note'))).status;
      case 'reject-plan': return (await rejectPlan(this.runtime, decision.id, by, required(reason, 'reason'))).status;
      case 'approve-push': return (await approvePush(this.runtime, decision.id, by)).status;
      case 'publish': return (await publish(this.runtime, decision.id, by)).publication?.url ?? 'published';
      case 'approve-create': return (await approveCreate(this.runtime, decision.id, by, decision.withDelete ?? true)).status;
      case 'approve-delete': return (await approveDelete(this.runtime, decision.id, by)).status;
      case 'deny-request': return (await denyRequest(this.runtime, decision.id, by, reason || 'denied from the surface')).status;
      default: throw new Error(`unknown_decision: ${decision.action}`);
    }
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
    for (const permission of pending.filter(entry => accepted(entry.sessionID))) {
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
    return JSON.stringify([items.map(item => [item.id, item.status, item.updatedAt]), requests.map(request => [request.id, request.status, request.updatedAt])]);
  }
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
