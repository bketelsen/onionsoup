import { ownerChatAgent } from './owner-chat.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { clipped } from './chat-context.ts';
import { chatPath } from './chats.ts';
import { isRuntimeNotice, NOTICE_PREFIX } from './notices.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';
import { postExchangeNotice } from './exchange-notice-delivery.ts';

export const NoticeChat = z.object({
  id: z.string(), directory: z.string(), parentID: z.string().optional(),
  time: z.object({ updated: z.number() }),
});
export type NoticeChat = z.infer<typeof NoticeChat>;
export const NoticeMessage = z.object({
  info: z.object({ id: z.string(), role: z.string(), agent: z.string().optional(), time: z.object({ created: z.number() }) }),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional(), synthetic: z.boolean().optional(), ignored: z.boolean().optional() })),
});
export type NoticeMessage = z.infer<typeof NoticeMessage>;
const Target = z.object({ sessionID: z.string(), directory: z.string() });
export const ExchangeNotice = z.object({
  id: z.string(), owner: z.string(), text: z.string(), at: z.string(), target: Target.optional(),
  delivery: z.object({ agent: z.string(), text: z.string() }).optional(),
  undeliverableReason: z.enum(['owner_retired', 'owner_has_no_persona']).optional(),
});
export type ExchangeNotice = z.infer<typeof ExchangeNotice>;

type NoticeError = (id: string, error: unknown) => void;

export interface ExchangeClient {
  sessions(directory: string): Promise<NoticeChat[]>;
  messages(target: z.infer<typeof Target>): Promise<NoticeMessage[]>;
  idle(target: z.infer<typeof Target>): Promise<boolean>;
  post(target: z.infer<typeof Target>, body: { agent: string; noReply: true; messageID: string; parts: { type: 'text'; text: string; metadata?: Record<string, unknown> }[] }): Promise<void>;
}

function paths(runtime: Runtime) {
  const root = join(runtime.stateDirectory, 'notices', 'exchanges');
  return { pending: join(root, 'pending'), delivered: join(root, 'delivered'), undeliverable: join(root, 'undeliverable') };
}

async function save(path: string, notice: ExchangeNotice) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(notice) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function queueExchangeNotice(runtime: Runtime, owner: string, text: string,
  delivery?: Pick<ExchangeNotice, 'id' | 'at' | 'target'>) {
  const notice = ExchangeNotice.parse({ id: delivery?.id ?? `msg_${randomUUID().replaceAll('-', '')}`, owner,
    text, at: delivery?.at ?? new Date().toISOString(), target: delivery?.target });
  if (!/^msg_[a-f0-9]{32}$/.test(notice.id)) throw new Error('exchange_notice_identity_invalid');
  const locations = paths(runtime);
  await mkdir(locations.pending, { recursive: true });
  return withRecordLock(join(locations.pending, `${notice.id}.queue.lock`), async () => {
    for (const directory of Object.values(locations)) {
      const existing = await readFile(join(directory, `${notice.id}.json`), 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!existing) continue;
      const previous = ExchangeNotice.parse(JSON.parse(existing));
      if (previous.owner !== notice.owner || previous.text !== notice.text || previous.at !== notice.at
        || (notice.target && JSON.stringify(previous.target) !== JSON.stringify(notice.target))) {
        throw new Error('exchange_notice_identity_conflict');
      }
      return previous;
    }
    await save(join(locations.pending, `${notice.id}.json`), notice);
    return notice;
  });
}

function personMessage(message: NoticeMessage, agent: string) {
  if (message.info.role !== 'user' || message.info.agent !== agent) return false;
  const real = message.parts.filter(part => !part.synthetic);
  const text = real.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
  return !isRuntimeNotice(text) && real.some(part => part.type === 'text' || part.type === 'file');
}

async function latestPersonChat(runtime: Runtime, ownerId: string, client: ExchangeClient, onError: NoticeError) {
  const owner = runtime.owner(ownerId);
  const directories = new Set([owner.workspace, chatPath(runtime, owner.id)]);
  for (const view of runtime.repositoryViews(ownerId)) if (view.desk) directories.add(view.desk);
  const sessions = (await Promise.all([...directories].map(directory => client.sessions(directory)))).flat();
  const unique = [...new Map(sessions.filter(session => !session.parentID).map(session => [session.id, session])).values()]
    .sort((left, right) => right.time.updated - left.time.updated).slice(0, owner.chatContext.noticeSessions);
  let selected: { target: z.infer<typeof Target>; at: number } | undefined;
  for (const session of unique) {
    const target = { sessionID: session.id, directory: session.directory };
    const messages = await client.messages(target).catch(error => {
      onError(`session:${session.id}`, error);
      return [];
    });
    const at = Math.max(-1, ...messages.filter(message => personMessage(message, ownerChatAgent(owner))).map(message => message.info.time.created));
    if (at >= 0 && (!selected || at > selected.at)) selected = { target, at };
  }
  return selected?.target;
}

function noticeText(runtime: Runtime, notice: ExchangeNotice, limit: number) {
  const file = `${notice.id}.json`;
  const reference = `Full exchange record: ${join(paths(runtime).delivered, file)}\nWhile delivery is pending: ${join(paths(runtime).pending, file)}`;
  return `${NOTICE_PREFIX} Owner exchange (${notice.id})\n${clipped(notice.text, limit)}\n\n${reference}`;
}

function matchesDelivery(message: NoticeMessage, notice: ExchangeNotice) {
  return !!notice.delivery && message.info.id === notice.id && message.info.role === 'user'
    && message.info.agent === notice.delivery.agent && message.parts.length === 1
    && message.parts[0]?.type === 'text' && !message.parts[0].synthetic && !message.parts[0].ignored
    && message.parts[0].text === notice.delivery.text;
}

/** Legacy reconstruction is reserved for an explicitly pinned operator recovery, never a chat bypass. */
export async function deliveredExchangeNoticeProof(runtime: Runtime, target: z.infer<typeof Target>,
  message: unknown, options: { allowLegacy?: boolean } = {}) {
  const parsed = NoticeMessage.safeParse(message);
  if (!parsed.success || !/^msg_[a-f0-9]{32}$/.test(parsed.data.info.id)) return undefined;
  let raw: string;
  try { raw = await readFile(join(paths(runtime).delivered, `${parsed.data.info.id}.json`), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const notice = ExchangeNotice.parse(JSON.parse(raw));
  if (notice.id !== parsed.data.info.id || notice.target?.sessionID !== target.sessionID
    || notice.target.directory !== target.directory) return undefined;
  let delivery = notice.delivery;
  if (!delivery && options.allowLegacy && runtime.declarations.owners.has(notice.owner)) {
    const owner = runtime.owner(notice.owner);
    delivery = { agent: ownerChatAgent(owner), text: noticeText(runtime, notice, owner.chatContext.noticeChars) };
  }
  if (!delivery || !matchesDelivery(parsed.data, { ...notice, delivery })) return undefined;
  return { notice, raw, ...delivery };
}

async function deliverOne(runtime: Runtime, file: string, client: ExchangeClient, locate: (ownerId: string) => Promise<z.infer<typeof Target> | undefined>) {
  const { pending, delivered } = paths(runtime);
  const path = join(pending, file);
  return withRecordLock(`${path}.lock`, async () => {
    const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!contents) return;
    const notice = ExchangeNotice.parse(JSON.parse(contents));
    if (!runtime.declarations.owners.has(notice.owner)) await runtime.reloadDeclarations();
    const configured = runtime.declarations.owners.get(notice.owner);
    if (!configured) {
      const undeliverableReason = 'owner_retired';
      await save(path, { ...notice, undeliverableReason });
      await mkdir(paths(runtime).undeliverable, { recursive: true });
      await rename(path, join(paths(runtime).undeliverable, file));
      return;
    }
    const owner = runtime.owner(notice.owner);
    const target = notice.target ?? await locate(owner.id);
    if (!target || !(await client.idle(target))) return;
    const delivery = notice.delivery ?? { agent: ownerChatAgent(configured), text: noticeText(runtime, notice, owner.chatContext.noticeChars) };
    const prepared = { ...notice, target, delivery };
    const messages = await client.messages(target);
    const existing = messages.find(message => message.info.id === notice.id);
    if (existing && (!notice.delivery || !matchesDelivery(existing, prepared))) throw new Error('exchange_notice_message_conflict');
    await save(path, prepared);
    if (!existing) {
      await postExchangeNotice(runtime.stateDirectory, target, { agent: delivery.agent, noReply: true, messageID: notice.id,
        parts: [{ type: 'text', text: delivery.text }] }, client.post.bind(client));
    }
    await mkdir(delivered, { recursive: true });
    await rename(path, join(delivered, file));
  });
}

/** Durable retry and a stable message ID reconcile acceptance when a server dies before recording delivery. */
export async function deliverExchangeNotices(runtime: Runtime, client: ExchangeClient,
  onError: NoticeError = (id, error) => console.warn(`exchange_notice_failed: ${id}`, error)) {
  const targets = new Map<string, ReturnType<typeof latestPersonChat>>();
  const locate = (ownerId: string) => {
    if (!targets.has(ownerId)) targets.set(ownerId, latestPersonChat(runtime, ownerId, client, onError));
    return targets.get(ownerId)!;
  };
  const files = (await readdir(paths(runtime).pending).catch(() => []))
    .filter(file => file.endsWith('.json')).sort();
  for (const file of files) {
    try {
      await deliverOne(runtime, file, client, locate);
    } catch (error) {
      onError(file, error);
    }
  }
}
