import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { resolveOwnerId } from './ask.ts';
import { queueNotice, readNotice, type WorkNotice } from './notices.ts';
import { rememberedSession, sessionHistory } from './session-history.ts';
import type { Runtime } from './runtime.ts';
import { chatPath } from './chats.ts';

export const OWNER_MESSAGE_LIMITS = { textChars: 16_000 };
// The plugin bundles a different Zod minor version; share shapes without crossing incompatible schema instances.
export function ownerMessageShape<Id, Text, Item, Session>(id: Id, text: Text, item: Item, session: Session) {
  return { to: id, text, item, session };
}
export function ownerReplyShape<Id, Text>(message: Id, text: Text) {
  return { message, text };
}
export const OwnerMessageInput = z.object(ownerMessageShape(z.string().min(1),
  z.string().trim().min(1).max(OWNER_MESSAGE_LIMITS.textChars), z.string().optional(), ChatOrigin.optional()));
export type OwnerMessageInput = z.infer<typeof OwnerMessageInput>;
export const OwnerReplyInput = z.object(ownerReplyShape(z.string().min(1), OwnerMessageInput.shape.text));
export type OwnerReplyInput = z.infer<typeof OwnerReplyInput>;

export function ownerMessageId(binding: unknown) {
  return `owner-message-${createHash('sha256').update(JSON.stringify(binding)).digest('hex')}`;
}

export async function latestOwnerMessageTarget(runtime: Runtime, owner: string) {
  const directories = new Set([runtime.owner(owner).workspace, chatPath(runtime, owner)]);
  for (const repository of runtime.repositoryViews(owner)) if (repository.desk) directories.add(repository.desk);
  const sessions = (await sessionHistory(runtime, owner))
    .filter(session => !session.parentID && !session.item && directories.has(session.directory))
    .sort((left, right) => right.time.updated - left.time.updated);
  const selected = sessions.find(session => !session.archived) ?? sessions[0];
  return selected ? { sessionID: selected.id, directory: selected.directory } : undefined;
}

async function destination(runtime: Runtime, owner: string, input: OwnerMessageInput) {
  if (input.item) {
    const item = await runtime.ledger.get(input.item);
    if (item.owner !== owner) throw new Error('owner_message_item_not_recipient');
    return item.session ?? item.origin;
  }
  if (input.session) {
    const session = await rememberedSession(runtime, input.session.sessionID);
    if (!session || session.owner !== owner || session.directory !== input.session.directory || session.parentID) {
      throw new Error('owner_message_session_not_recipient');
    }
    return input.session;
  }
  return latestOwnerMessageTarget(runtime, owner);
}

/** The caller and invocation identity come from host tool context, never message arguments. */
export async function sendOwnerMessage(runtime: Runtime, from: string, input: OwnerMessageInput,
  source: ChatOrigin, invocation: string) {
  const parsed = OwnerMessageInput.parse(input);
  if (!runtime.owner(from).persona) throw new Error('owner_chat_observation_only');
  const to = resolveOwnerId(runtime, parsed.to);
  if (to === from) throw new Error('owner_message_self');
  if (parsed.item && parsed.session) throw new Error('owner_message_ambiguous_address');
  const sender = await rememberedSession(runtime, source.sessionID);
  if (!sender || sender.owner !== from || sender.directory !== source.directory || sender.parentID) {
    throw new Error('owner_message_sender_session_unproven');
  }
  const id = ownerMessageId([from, source, invocation, parsed]);
  const previous = await readNotice(runtime, id);
  return queueNotice(runtime, {
    id, owner: to, workItem: parsed.item,
    change: 'owner-message', text: parsed.text, origin: previous ? previous.origin : await destination(runtime, to, parsed),
    sender: { owner: from, origin: source }, at: new Date().toISOString(),
  });
}

/** Reply to the recorded sender's exact address, not a guessed chat or a consultation hire. */
export async function replyToOwnerMessage(runtime: Runtime, from: string, input: OwnerReplyInput,
  source: ChatOrigin, invocation: string) {
  const parsed = OwnerReplyInput.parse(input);
  if (!runtime.owner(from).persona) throw new Error('owner_chat_observation_only');
  const message = await readNotice(runtime, parsed.message);
  if (!message || message.owner !== from || !message.sender) throw new Error('owner_message_not_replyable');
  const sender = await rememberedSession(runtime, source.sessionID);
  if (!sender || sender.owner !== from || sender.directory !== source.directory || sender.parentID) {
    throw new Error('owner_message_sender_session_unproven');
  }
  runtime.owner(message.sender.owner);
  const reply: WorkNotice = {
    id: ownerMessageId([from, source, invocation, parsed]), owner: message.sender.owner,
    change: 'owner-reply', text: parsed.text, origin: message.sender.origin,
    sender: { owner: from, origin: source }, replyTo: message.id, at: new Date().toISOString(),
  };
  return queueNotice(runtime, reply);
}
