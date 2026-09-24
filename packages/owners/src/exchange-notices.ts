import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { clipped } from './chat-context.ts';
import { ownsRepositories } from './declarations.ts';
import { isRuntimeNotice, NOTICE_PREFIX } from './notices.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const NoticeChat = z.object({
  id: z.string(), directory: z.string(), parentID: z.string().optional(),
  time: z.object({ updated: z.number() }),
});
export type NoticeChat = z.infer<typeof NoticeChat>;
export const NoticeMessage = z.object({
  info: z.object({ id: z.string(), role: z.string(), agent: z.string().optional(), time: z.object({ created: z.number() }) }),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional(), synthetic: z.boolean().optional() })),
});
export type NoticeMessage = z.infer<typeof NoticeMessage>;
const Target = z.object({ sessionID: z.string(), directory: z.string() });
export const ExchangeNotice = z.object({
  id: z.string(), owner: z.string(), text: z.string(), at: z.string(), target: Target.optional(),
});
export type ExchangeNotice = z.infer<typeof ExchangeNotice>;

type NoticeError = (id: string, error: unknown) => void;

export interface ExchangeClient {
  sessions(directory: string): Promise<NoticeChat[]>;
  messages(target: z.infer<typeof Target>): Promise<NoticeMessage[]>;
  idle(target: z.infer<typeof Target>): Promise<boolean>;
  post(target: z.infer<typeof Target>, body: { agent: string; noReply: true; messageID: string; parts: { type: 'text'; text: string }[] }): Promise<void>;
}

function paths(runtime: Runtime) {
  const root = join(runtime.stateDirectory, 'notices', 'exchanges');
  return { pending: join(root, 'pending'), delivered: join(root, 'delivered') };
}

async function save(path: string, notice: ExchangeNotice) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(notice) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function queueExchangeNotice(runtime: Runtime, owner: string, text: string) {
  const notice = ExchangeNotice.parse({ id: `msg_${randomUUID().replaceAll('-', '')}`, owner,
    text, at: new Date().toISOString() });
  const { pending } = paths(runtime);
  await mkdir(pending, { recursive: true });
  await save(join(pending, `${notice.id}.json`), notice);
  return notice;
}

function personMessage(message: NoticeMessage, agent: string) {
  if (message.info.role !== 'user' || message.info.agent !== agent) return false;
  const real = message.parts.filter(part => !part.synthetic);
  const text = real.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
  return !isRuntimeNotice(text) && real.some(part => part.type === 'text' || part.type === 'file');
}

async function latestPersonChat(runtime: Runtime, ownerId: string, client: ExchangeClient, onError: NoticeError) {
  const owner = runtime.owner(ownerId);
  if (!owner.persona) return undefined;
  const directories = new Set([owner.workspace, ownsRepositories(owner) ? join(runtime.desksRoot, owner.id) : runtime.evidenceDirectory(owner.id)]);
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
    const at = Math.max(-1, ...messages.filter(message => personMessage(message, owner.persona!.name)).map(message => message.info.time.created));
    if (at >= 0 && (!selected || at > selected.at)) selected = { target, at };
  }
  return selected?.target;
}

function noticeText(notice: ExchangeNotice, limit: number) {
  const reference = `Full exchange record: notices/exchanges/{pending,delivered}/${notice.id}.json`;
  return `${NOTICE_PREFIX} Owner exchange (${notice.id})\n${clipped(notice.text, limit)}\n\n${reference}`;
}

async function deliverOne(runtime: Runtime, file: string, client: ExchangeClient, onError: NoticeError) {
  const { pending, delivered } = paths(runtime);
  const path = join(pending, file);
  return withRecordLock(`${path}.lock`, async () => {
    const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!contents) return;
    const notice = ExchangeNotice.parse(JSON.parse(contents));
    const owner = runtime.owner(notice.owner);
    if (!owner.persona) return;
    const target = notice.target ?? await latestPersonChat(runtime, owner.id, client, onError);
    if (!target || !(await client.idle(target))) return;
    await save(path, { ...notice, target });
    const messages = await client.messages(target);
    if (!messages.some(message => message.info.id === notice.id)) {
      await client.post(target, { agent: owner.persona.name, noReply: true, messageID: notice.id,
        parts: [{ type: 'text', text: noticeText(notice, owner.chatContext.noticeChars) }] });
    }
    await mkdir(delivered, { recursive: true });
    await rename(path, join(delivered, file));
  });
}

/** Durable retry and a stable message ID reconcile acceptance when a server dies before recording delivery. */
export async function deliverExchangeNotices(runtime: Runtime, client: ExchangeClient,
  onError: NoticeError = (id, error) => console.warn(`exchange_notice_failed: ${id}`, error)) {
  const files = (await readdir(paths(runtime).pending).catch(() => []))
    .filter(file => file.endsWith('.json')).sort();
  for (const file of files) {
    try {
      await deliverOne(runtime, file, client, onError);
    } catch (error) {
      onError(file, error);
    }
  }
}
