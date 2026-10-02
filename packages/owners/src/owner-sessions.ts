import type { Plugin } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { ChatOrigin } from './chat-origin.ts';
import { chatDirectory } from './chats.ts';
import { deskSyncText, syncOwnerDesk, type DeskSyncReport } from './desk-sync.ts';
import type { WorkItem } from './ledger.ts';
import { isPaused } from './ledger.ts';
import { executionPrompt, OWNER_CHANGE_WORKFLOW, planningPrompt } from './plan-work.ts';
import { ensurePlanWorktree, syncPlanWorktree } from './plan-worktrees.ts';
import { rememberSession, itemSessionHistory } from './session-history.ts';
import type { Runtime } from './runtime.ts';
import type { MaintenanceContext } from './maintenance-context.ts';
import { SessionOpeningStore, type SessionOpening } from './session-opening-store.ts';

/**
 * The runtime opens owner sessions on the surface's opencode, where the person can watch and step in: one where an
 * owner plans delegated work alone, and one that carries out each approved plan. The daemon and the surface record
 * approvals; the plugin, which holds the opencode client, notices items that need a session and opens it.
 */
export interface PermissionRule { permission: string; pattern: string; action: 'allow' | 'ask' | 'deny' }

/** Whether a session is working now, and when it last changed (ms since the epoch); undefined when it is gone. */
export interface SessionActivity { isBusy: boolean; updatedAt: number | undefined }

export interface OwnerSessionClient {
  create(directory: string, title: string, permission: readonly PermissionRule[]): Promise<string>;
  prompt(target: ChatOrigin, agent: string, text: string, messageID?: string): Promise<void>;
  remove(target: ChatOrigin): Promise<void>;
  activity(target: ChatOrigin): Promise<SessionActivity>;
}

/** Where a session runs, and what its first message adds about that place (how a sync went, if it said anything). */
export interface SessionPlace { directory: string; note: string }

interface SessionKind {
  isNeeded: (item: WorkItem) => boolean;
  title: (item: WorkItem) => string;
  prompt: (item: WorkItem) => string;
  /** Ready the directory the session runs in, before it opens. */
  place: (runtime: Runtime, item: WorkItem, context?: MaintenanceContext) => Promise<SessionPlace>;
  /** Exact session identity retained on the item, including uncertain prompt delivery. */
  recorded: (origin: ChatOrigin, owner: string) => Partial<WorkItem>;
  /** Additional session rules, never overrides of the owner's declared denies. */
  permission: readonly PermissionRule[];
}

function syncNote(sync: DeskSyncReport | undefined) {
  return sync ? `\n\n${deskSyncText(sync)}` : '';
}

/**
 * A session in the owner's chat directory reads its desks, so they are synced first: the session starts from the
 * base branch as it is now, not where a desk was left. A failed sync is logged and does not stop the session.
 */
export async function syncedChatPlace(runtime: Runtime, ownerId: string, repositories: readonly (string | undefined)[], label: string, context?: MaintenanceContext): Promise<SessionPlace> {
  const syncs = await Promise.all(repositories.map(repository => sessionOpeningPhase(context, 'desk-sync',
    () => syncOwnerDesk(runtime, ownerId, repository, context)).catch((error: unknown) => {
    context?.check();
    console.warn('owner_session_desk_sync_failed', label, error);
    return undefined;
  })));
  context?.check();
  const directory = await sessionOpeningPhase(context, 'chat-place', () => chatDirectory(runtime, ownerId));
  context?.check();
  return { directory, note: syncs.map(syncNote).join('') };
}

/** Planning reads the item's repository in the owner's chat directory, synced so the plan is made against the base. */
async function planningPlace(runtime: Runtime, item: WorkItem, context?: MaintenanceContext) {
  return syncedChatPlace(runtime, item.owner, [item.proposal.repository], item.id, context);
}

/**
 * Carrying out a plan happens in the plan's own worktree, new from the current base; one that already exists (a
 * session reopened after a failed start) is brought up to date instead.
 */
async function executionPlace(runtime: Runtime, item: WorkItem, context?: MaintenanceContext): Promise<SessionPlace> {
  const worktree = await sessionOpeningPhase(context, 'plan-place', () => ensurePlanWorktree(runtime, item, context));
  context?.check();
  if (worktree.isNew) return { directory: worktree.path, note: '' };
  const sync = await sessionOpeningPhase(context, 'plan-sync', () => syncPlanWorktree(runtime, item.owner, item.id, context)).catch((error: unknown) => {
    context?.check();
    console.warn('owner_session_plan_sync_failed', item.id, error);
    return undefined;
  });
  context?.check();
  return { directory: worktree.path, note: syncNote(sync) };
}

function isOwnerPlan(item: WorkItem) {
  return item.workflow === OWNER_CHANGE_WORKFLOW && !item.activeRunner;
}

export const OWNER_SESSIONS = {
  planning: {
    isNeeded: item => isOwnerPlan(item) && item.status === 'planning' && !item.origin,
    title: item => `Request ${item.request ?? item.id}: ${item.proposal.title}`,
    prompt: planningPrompt,
    place: planningPlace,
    recorded: (origin, owner) => ({ origin, originOwner: owner }),
    permission: [],
  },
  execution: {
    isNeeded: item => isOwnerPlan(item) && item.status === 'working' && !item.session,
    title: item => `Plan ${item.id}: ${item.proposal.title}`,
    prompt: executionPrompt,
    place: executionPlace,
    recorded: origin => ({ session: origin }),
    permission: [],
  },
} satisfies Record<string, SessionKind>;

export type OwnerSessionKind = keyof typeof OWNER_SESSIONS;

export function neededSession(item: WorkItem): OwnerSessionKind | undefined {
  return (Object.keys(OWNER_SESSIONS) as OwnerSessionKind[]).find(kind => OWNER_SESSIONS[kind].isNeeded(item));
}

/** Placement legitimately records its worktree identity; every other item field must remain unchanged. */
function openingItemBinding(item: WorkItem) {
  const { updatedAt: _updatedAt, planWorktree: _path, planWorktreeGeneration: _generation, ...binding } = item;
  return JSON.stringify(binding);
}

/** Record the session on the item unless another opener got there first. */
async function claim(runtime: Runtime, item: WorkItem, kind: SessionKind, origin: ChatOrigin) {
  try {
    return await runtime.ledger.update(item.id, current => {
      const comparable = isPaused(current) && current.pauses.at(-1)?.resumeStatus === item.status
        ? { ...current, status: item.status, reason: item.reason, humanNotes: item.humanNotes,
          pauses: item.pauses, updatedAt: item.updatedAt }
        : current;
      if (!kind.isNeeded(comparable) || JSON.stringify(comparable) !== JSON.stringify(item)) {
        throw new Error('owner_session_already_open');
      }
      return { ...current, ...kind.recorded(origin, current.owner) };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'owner_session_already_open') return undefined;
    throw error;
  }
}

/** The lifecycle context checks both the boundary and the result of a potentially slow operation. */
export async function sessionOpeningPhase<T>(context: MaintenanceContext | undefined, name: string, operation: () => Promise<T>) {
  context?.check();
  const value = context ? await context.phase(name, operation) : await operation();
  context?.check();
  return value;
}

/** Save identity even when a delayed create response arrives after maintenance has stopped. */
export async function createOpeningSession(store: SessionOpeningStore, reservation: SessionOpening,
  client: OwnerSessionClient, directory: string, title: string, permission: readonly PermissionRule[],
  context?: MaintenanceContext, beforeCreate?: () => Promise<void>) {
  context?.check();
  await store.advance(reservation, 'creating', { directory });
  return sessionOpeningPhase(context, 'session-create', async () => {
    context?.check();
    try {
      await beforeCreate?.();
    } catch (error) {
      await store.stoppedBeforeCreate(reservation);
      throw error;
    }
    const origin = { sessionID: await client.create(directory, title, permission), directory };
    await store.advance(reservation, 'created', { origin });
    return origin;
  });
}

export async function promptOpeningSession(store: SessionOpeningStore, reservation: SessionOpening,
  client: OwnerSessionClient, origin: ChatOrigin, agent: string, text: string,
  context?: MaintenanceContext, beforePrompt?: () => Promise<void>) {
  context?.check();
  await store.advance(reservation, 'prompting');
  await sessionOpeningPhase(context, 'session-prompt', async () => {
    context?.check();
    try {
      await beforePrompt?.();
    } catch (error) {
      await store.stoppedBeforePrompt(reservation);
      throw error;
    }
    await client.prompt(origin, agent, text, reservation.messageID);
    await store.advance(reservation, 'opened');
  });
}

/** A durable reservation precedes creation. Ambiguous effects retain their identity and are never retried here. */
export async function openOwnerSession(runtime: Runtime, client: OwnerSessionClient, itemId: string, context?: MaintenanceContext) {
  const item = await runtime.ledger.get(itemId);
  context?.check();
  const kindName = neededSession(item);
  const persona = runtime.owner(item.owner).persona;
  if (!kindName || !persona) return undefined;
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const reservation = await store.reserve({ entity: 'owner-item', id: item.id, owner: item.owner, kind: kindName });
  if (!reservation) return undefined;
  let createdOrigin: ChatOrigin | undefined;
  try {
    const kind: SessionKind = OWNER_SESSIONS[kindName];
    const current = await runtime.ledger.get(itemId);
    context?.check();
    if (!kind.isNeeded(current) || current.owner !== item.owner) throw new Error('owner_session_item_changed');
    const { directory, note } = await kind.place(runtime, current, context);
    context?.check();
    const afterPlace = await runtime.ledger.get(itemId);
    context?.check();
    if (openingItemBinding(afterPlace) !== openingItemBinding(current)) throw new Error('owner_session_item_changed');
    const origin = await createOpeningSession(store, reservation, client, directory, kind.title(current), kind.permission,
      context, () => requireOpeningItem(runtime, afterPlace));
    createdOrigin = origin;
    const claimed = await claim(runtime, afterPlace, kind, origin);
    context?.check();
    if (!claimed) throw new Error('owner_session_item_changed');
    for (const session of itemSessionHistory(claimed)) {
      await rememberSession(runtime, session).catch(() => console.warn('owner_session_history_not_recorded', item.id, session.id));
    }
    if (isPaused(await runtime.ledger.get(itemId))) throw new Error('work_item_paused');
    await promptOpeningSession(store, reservation, client, origin, persona.name, `${kind.prompt(claimed)}${note}`,
      context, async () => {
        if (isPaused(await runtime.ledger.get(itemId))) throw new Error('work_item_paused');
      });
    context?.check();
    await runtime.notebook(item.owner).journal({ kind: 'owner-session-opened', workItem: item.id, outcome: kindName, session: origin.sessionID });
    return origin;
  } catch (error) {
    if (createdOrigin && (await store.read(reservation.key))?.phase === 'created') {
      await store.stoppedBeforePrompt(reservation);
    }
    await store.failed(reservation);
    throw error;
  }
}

async function requireOpeningItem(runtime: Runtime, expected: WorkItem) {
  const current = await runtime.ledger.get(expected.id);
  if (isPaused(current)) throw new Error('work_item_paused');
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('owner_session_item_changed');
}

/** Every eligible item is considered once per pass; uncertain reservations remain inspectable and fenced. */
export async function openNeededSessions(runtime: Runtime, client: OwnerSessionClient,
  onError: (itemId: string, error: unknown) => void, context?: MaintenanceContext) {
  const waiting = (await runtime.ledger.list()).filter(item => neededSession(item) && runtime.declarations.owners.get(item.owner)?.persona);
  context?.check();
  for (const item of waiting) {
    context?.check();
    await openOwnerSession(runtime, client, item.id, context).catch(error => onError(item.id, error));
  }
}

/** The plugin's opencode client as the session opener needs it. */
export function ownerSessionClient(client: Parameters<Plugin>[0]['client']): OwnerSessionClient {
  return {
    async create(directory, title, permission) {
      const created = await client.session.create({ body: { title, permission } as never, query: { directory } });
      if (created.error || !created.data?.id) throw new Error('owner_session_create_failed');
      return created.data.id;
    },
    async prompt(target, agent, text, messageID) {
      const sent = await client.session.promptAsync({
        path: { id: target.sessionID }, query: { directory: target.directory }, body: { agent, messageID, parts: [{ type: 'text', text }] },
      });
      if (sent.error) throw new Error('owner_session_prompt_failed');
    },
    async remove(target) {
      await client.session.delete({ path: { id: target.sessionID }, query: { directory: target.directory } });
    },
    async activity(target) {
      const query = { directory: target.directory };
      const [statuses, session] = await Promise.all([
        client.session.status({ query }), client.session.get({ path: { id: target.sessionID }, query }),
      ]);
      if (statuses.error) throw new Error('owner_session_status_failed');
      const isGone = session.response?.status === 404;
      if (session.error && !isGone) throw new Error('owner_session_read_failed');
      return { isBusy: directoryHasBusySession(statuses.data), updatedAt: session.data?.time.updated };
    },
  };
}

/** opencode lists only sessions that are not idle; a retrying session is still working. */
const IS_WORKING: Record<'idle' | 'busy' | 'retry', boolean> = { idle: false, busy: true, retry: true };
const DirectoryStatus = z.record(z.string(), z.object({ type: z.enum(['idle', 'busy', 'retry']) }));

function directoryHasBusySession(statuses: unknown) {
  const parsed = DirectoryStatus.safeParse(statuses);
  if (!parsed.success) throw new Error('owner_session_status_invalid');
  return Object.values(parsed.data).some(status => IS_WORKING[status.type]);
}
