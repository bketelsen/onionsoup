import type { Plugin } from '@opencode-ai/plugin';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { chatDirectory, chatPath } from './chats.ts';
import type { ChatOrigin } from './chat-origin.ts';
import { exchangeClient } from './exchange-client.ts';
import type { NoticeMessage } from './exchange-notices.ts';
import type { WorkItem } from './ledger.ts';
import type { MaintenancePass } from './plugin-maintenance.ts';
import type { WorkNotice } from './notices.ts';
import { ownerChatAgent } from './owner-chat.ts';
import { createOpeningSession, neededSession, openOwnerSession, ownerSessionClient } from './owner-sessions.ts';
import { ownerMessageId } from './owner-messages.ts';
import { itemSessionHistory, rememberedSession, rememberSession } from './session-history.ts';
import { SessionOpeningStore } from './session-opening-store.ts';
import type { Runtime } from './runtime.ts';

export const ObservedOwnerSession = z.object({
  id: z.string(), directory: z.string(), title: z.string().default(''),
  parentID: z.string().optional(), time: z.object({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
});
export type ObservedOwnerSession = z.infer<typeof ObservedOwnerSession>;
export const OWNER_CONTINUATION_LIMITS = { historyChars: 12_000, retiredSessionHops: 32 };

async function isDirectory(directory: string) {
  return stat(directory).then(entry => entry.isDirectory(), error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
}

/** Historical transcript reads must not start an OpenCode instance in a removed or reused directory. */
export async function ownerTranscriptTarget(runtime: Runtime, target: ChatOrigin) {
  const known = await rememberedSession(runtime, target.sessionID);
  if (!known?.archived && await isDirectory(target.directory)) return target;
  if (!known || known.directory !== target.directory) throw new Error('owner_message_history_identity_missing');
  return { ...target, directory: chatPath(runtime, known.owner) };
}

async function observedSession(client: Parameters<Plugin>[0]['client'], target: ChatOrigin) {
  const reply = await client.session.get({ path: { id: target.sessionID }, query: { directory: target.directory } });
  if (reply.error) {
    if (reply.response.status === 404) return undefined;
    throw new Error('owner_message_session_read_unavailable');
  }
  const session = ObservedOwnerSession.parse(reply.data);
  if (session.id !== target.sessionID || session.directory !== target.directory) throw new Error('owner_message_session_identity_conflict');
  return session;
}

export async function rememberObservedOwnerSession(runtime: Runtime, owner: string, session: ObservedOwnerSession) {
  await rememberSession(runtime, { ...session, owner, archived: Boolean(session.time.archived) });
}

async function ownedTarget(runtime: Runtime, notice: WorkNotice, target: ChatOrigin,
  client: Parameters<Plugin>[0]['client'], item?: WorkItem) {
  const known = await rememberedSession(runtime, target.sessionID);
  if (known) return known.owner === notice.owner && known.directory === target.directory && !known.parentID;
  const reference = item && itemSessionHistory(item).find(session => session.id === target.sessionID && session.directory === target.directory);
  if (reference) {
    await rememberSession(runtime, reference);
    return true;
  }
  if (!await isDirectory(target.directory)) return false;
  const session = await observedSession(client, target);
  if (!session || session.parentID) return false;
  const messages = await exchangeClient(client).messages(target);
  if (!messages.some(message => message.info.agent === ownerChatAgent(runtime.owner(notice.owner)))) return false;
  await rememberObservedOwnerSession(runtime, notice.owner, session);
  return true;
}

async function usableTarget(runtime: Runtime, client: Parameters<Plugin>[0]['client'], target: ChatOrigin) {
  const known = await rememberedSession(runtime, target.sessionID);
  if (known?.archived || !await isDirectory(target.directory)) return false;
  const session = await observedSession(client, target);
  return !!session && !session.parentID && !session.time.archived;
}

async function recipientItem(runtime: Runtime, notice: WorkNotice, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass) {
  const item = notice.workItem ? await runtime.ledger.get(notice.workItem) : undefined;
  if (!item || item.owner !== notice.owner) return undefined;
  if (item.activeRunner) throw new Error('owner_message_item_runner_busy');
  if (!neededSession(item)) return item;
  // The canonical reservation owns initial planning/execution. A message cannot race it with another opener.
  await openOwnerSession(runtime, ownerSessionClient(client), item.id, pass);
  const opened = await runtime.ledger.get(item.id);
  if (neededSession(opened)) throw new Error('owner_message_item_opening_pending');
  return opened;
}

async function targetForNotice(runtime: Runtime, notice: WorkNotice, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass) {
  const item = await recipientItem(runtime, notice, client, pass);
  const candidates = [item?.session, item?.origin, notice.origin].filter(target => target !== undefined);
  let historical: ChatOrigin | undefined;
  for (const target of candidates) {
    if (!await ownedTarget(runtime, notice, target, client, item)) continue;
    if (await usableTarget(runtime, client, target)) return { target, item, isUsable: true };
    historical ??= target;
  }
  return { target: historical, item, isUsable: false };
}

function transcriptContext(messages: NoticeMessage[]) {
  const transcript = messages.flatMap(message => message.parts.filter(part => part.type === 'text' && !part.ignored)
    .map(part => `${message.info.role}: ${part.text ?? ''}`)).join('\n\n');
  return transcript.slice(-OWNER_CONTINUATION_LIMITS.historyChars);
}

async function historicalContext(runtime: Runtime, client: Parameters<Plugin>[0]['client'], target: ChatOrigin | undefined) {
  if (!target) return '';
  const known = await rememberedSession(runtime, target.sessionID);
  if (!known) throw new Error('owner_message_history_identity_missing');
  // Query the retained transcript through a current declared directory, never instantiate the retired path.
  const readTarget = await ownerTranscriptTarget(runtime, target);
  const transcript = transcriptContext(await exchangeClient(client).messages(readTarget));
  return `Historical session ${target.sessionID} in ${target.directory} remains in history.\n`
    + `<previous-conversation>\n${transcript}\n</previous-conversation>`;
}

async function createContinuation(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass,
  store: SessionOpeningStore, reservation: NonNullable<Awaited<ReturnType<SessionOpeningStore['reserve']>>>,
  notice: WorkNotice, item: WorkItem | undefined) {
  try {
    pass.check();
    const directory = item?.status === 'working' && item.planApproval && item.planWorktree && await isDirectory(item.planWorktree)
      ? item.planWorktree : await chatDirectory(runtime, notice.owner);
    pass.check();
    const permission = directory === item?.planWorktree ? [{ permission: 'edit', pattern: '*', action: 'allow' as const }] : [];
    const origin = await createOpeningSession(store, reservation, ownerSessionClient(client), directory,
      `Continuation ${reservation.token}: ${item?.proposal.title ?? notice.owner}`, permission, pass);
    await rememberSession(runtime, { id: origin.sessionID, owner: notice.owner, directory, item: item?.id,
      title: `Continuation: ${item?.proposal.title ?? notice.owner}`, time: { created: Date.now(), updated: Date.now() } });
    await store.advance(reservation, 'opened');
    return origin;
  } catch (error) {
    await store.failed(reservation);
    throw error;
  }
}

async function continuation(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass,
  notice: WorkNotice, previous: ChatOrigin | undefined, item: WorkItem | undefined) {
  const store = new SessionOpeningStore(runtime.stateDirectory);
  let predecessor = previous;
  for (let hop = 0; hop < OWNER_CONTINUATION_LIMITS.retiredSessionHops; hop += 1) {
    const key = { entity: 'owner-continuation' as const, kind: 'continuation' as const, owner: notice.owner,
      id: ownerMessageId([notice.owner, predecessor?.sessionID ?? item?.id ?? 'unaddressed']) };
    const existing = await store.read(key);
    if (existing?.origin) {
      const known = await rememberedSession(runtime, existing.origin.sessionID);
      if (known && (known.owner !== notice.owner || known.directory !== existing.origin.directory || known.parentID)) {
        throw new Error('owner_message_continuation_identity_conflict');
      }
      if (await usableTarget(runtime, client, existing.origin)) return existing.origin;
      if (known) await rememberSession(runtime, { ...known, archived: true });
      predecessor = existing.origin;
      continue;
    }
    const reservation = await store.reserve(key);
    if (!reservation) throw new Error('owner_message_continuation_creation_uncertain');
    return createContinuation(runtime, client, pass, store, reservation, notice, item);
  }
  throw new Error('owner_message_continuation_history_limit');
}

/** Exact owned sessions win. Only positive retirement/absence permits a fresh declared-workspace continuation. */
export async function routeOwnerNotice(runtime: Runtime, client: Parameters<Plugin>[0]['client'], pass: MaintenancePass, notice: WorkNotice) {
  const { target, item, isUsable } = await targetForNotice(runtime, notice, client, pass);
  if (target && isUsable) return { origin: target, context: '' };
  const remembered = target ? await rememberedSession(runtime, target.sessionID) : undefined;
  if (target) {
    if (remembered) await rememberSession(runtime, { ...remembered, archived: true });
  }
  const origin = await continuation(runtime, client, pass, notice, target, item);
  const context = await historicalContext(runtime, client, target);
  const work = item ? `Continue the ORIGINAL work ${item.id}${item.request ? `, request ${item.request}` : ''}. `
    + `Goal: ${item.proposal.goal}. Status: ${item.status}. Do not cancel or create replacement work. `
    + `Keep all existing plan/effect gates.${item.planDocument ? `\n<current-plan>\n${item.planDocument.markdown}\n</current-plan>` : ''}` : '';
  return { origin, context: [context, work].filter(Boolean).join('\n\n') };
}
