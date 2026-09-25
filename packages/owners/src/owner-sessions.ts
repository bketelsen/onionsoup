import type { Plugin } from '@opencode-ai/plugin';
import type { ChatOrigin } from './chat-origin.ts';
import { chatDirectory } from './chats.ts';
import { deskSyncText, syncOwnerDesk } from './desk-sync.ts';
import type { WorkItem } from './ledger.ts';
import { executionPrompt, OWNER_CHANGE_WORKFLOW, planningPrompt } from './plan-work.ts';
import type { Runtime } from './runtime.ts';

/**
 * The runtime opens owner sessions on the surface's opencode, where the person can watch and step in: one where an
 * owner plans delegated work alone, and one that carries out each approved plan. The daemon and the surface record
 * approvals; the plugin, which holds the opencode client, notices items that need a session and opens it.
 */
export interface PermissionRule { permission: string; pattern: string; action: 'allow' | 'ask' | 'deny' }

export interface OwnerSessionClient {
  create(directory: string, title: string, permission: readonly PermissionRule[]): Promise<string>;
  prompt(target: ChatOrigin, agent: string, text: string): Promise<void>;
  remove(target: ChatOrigin): Promise<void>;
}

interface SessionKind {
  isNeeded: (item: WorkItem) => boolean;
  title: (item: WorkItem) => string;
  prompt: (item: WorkItem) => string;
  /** What the item records about its session; undefined takes the record back when the session never started. */
  recorded: (origin: ChatOrigin | undefined) => Partial<WorkItem>;
  /** Session-level rules on top of the owner's agent: the execution session edits the desk without asking. */
  permission: readonly PermissionRule[];
}

/** Planning and carrying out a plan start from the base branch as it is now, not from where the desk was left. */
async function syncBeforeSession(runtime: Runtime, item: WorkItem) {
  const sync = await syncOwnerDesk(runtime, item.owner, item.proposal.repository).catch((error: unknown) => {
    console.warn('owner_session_desk_sync_failed', item.id, error);
    return undefined;
  });
  return sync ? `\n\n${deskSyncText(sync)}` : '';
}

function isOwnerPlan(item: WorkItem) {
  return item.workflow === OWNER_CHANGE_WORKFLOW && !item.activeRunner;
}

export const OWNER_SESSIONS = {
  planning: {
    isNeeded: item => isOwnerPlan(item) && item.status === 'planning' && !item.origin,
    title: item => `Request ${item.request ?? item.id}: ${item.proposal.title}`,
    prompt: planningPrompt,
    recorded: origin => ({ origin }),
    permission: [],
  },
  execution: {
    isNeeded: item => isOwnerPlan(item) && item.status === 'working' && !item.session,
    title: item => `Plan ${item.id}: ${item.proposal.title}`,
    prompt: executionPrompt,
    recorded: origin => ({ session: origin }),
    permission: [{ permission: 'edit', pattern: '*', action: 'allow' }],
  },
} satisfies Record<string, SessionKind>;

export type OwnerSessionKind = keyof typeof OWNER_SESSIONS;

export function neededSession(item: WorkItem): OwnerSessionKind | undefined {
  return (Object.keys(OWNER_SESSIONS) as OwnerSessionKind[]).find(kind => OWNER_SESSIONS[kind].isNeeded(item));
}

/** Record the session on the item unless another opener got there first. */
async function claim(runtime: Runtime, item: WorkItem, kind: SessionKind, origin: ChatOrigin) {
  try {
    return await runtime.ledger.update(item.id, current => {
      if (!kind.isNeeded(current)) throw new Error('owner_session_already_open');
      return { ...current, ...kind.recorded(origin) };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'owner_session_already_open') return undefined;
    throw error;
  }
}

async function unclaim(runtime: Runtime, item: WorkItem, kind: SessionKind) {
  await runtime.ledger.update(item.id, current => ({ ...current, ...kind.recorded(undefined) }));
}

/** Open the session an item needs, record it, and send its first message; returns the session, if one was opened. */
export async function openOwnerSession(runtime: Runtime, client: OwnerSessionClient, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  const kindName = neededSession(item);
  const persona = runtime.owner(item.owner).persona;
  if (!kindName || !persona) return undefined;
  const kind: SessionKind = OWNER_SESSIONS[kindName];
  const directory = await chatDirectory(runtime, item.owner);
  const origin = { sessionID: await client.create(directory, kind.title(item), kind.permission), directory };
  const claimed = await claim(runtime, item, kind, origin);
  if (!claimed) {
    await client.remove(origin).catch(() => undefined);
    return undefined;
  }
  try {
    await client.prompt(origin, persona.name, `${kind.prompt(claimed)}${await syncBeforeSession(runtime, claimed)}`);
  } catch (error) {
    await unclaim(runtime, claimed, kind);
    await client.remove(origin).catch(() => undefined);
    throw error;
  }
  await runtime.notebook(item.owner).journal({ kind: 'owner-session-opened', workItem: item.id, outcome: kindName, session: origin.sessionID });
  return origin;
}

/** Every item waiting for a session, opened one at a time; a failure leaves that item for the next pass. */
export async function openNeededSessions(runtime: Runtime, client: OwnerSessionClient, onError: (itemId: string, error: unknown) => void) {
  const waiting = (await runtime.ledger.list()).filter(item => neededSession(item) && runtime.declarations.owners.get(item.owner)?.persona);
  for (const item of waiting) await openOwnerSession(runtime, client, item.id).catch(error => onError(item.id, error));
}

/** The plugin's opencode client as the session opener needs it. */
export function ownerSessionClient(client: Parameters<Plugin>[0]['client']): OwnerSessionClient {
  return {
    async create(directory, title, permission) {
      const created = await client.session.create({ body: { title, permission } as never, query: { directory } });
      if (!created.data?.id) throw new Error('owner_session_create_failed');
      return created.data.id;
    },
    async prompt(target, agent, text) {
      const sent = await client.session.promptAsync({
        path: { id: target.sessionID }, query: { directory: target.directory }, body: { agent, parts: [{ type: 'text', text }] },
      });
      if (sent.error) throw new Error('owner_session_prompt_failed');
    },
    async remove(target) {
      await client.session.delete({ path: { id: target.sessionID }, query: { directory: target.directory } });
    },
  };
}
