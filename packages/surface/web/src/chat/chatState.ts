import type { Message, MessageInfo, Part } from '../types.ts';

// How one chat's messages follow opencode's events. Pure (a map in, what changed out), so it is tested without a
// browser; useChat.ts holds the map and re-renders.

export type Messages = Map<string, Message>;

export interface ChatChange {
  /** The messages changed and should be shown again. */
  messages: boolean;
  /** The chat started or stopped working. */
  busy?: boolean;
  /** A session error the person should see (an abort is not one). */
  error?: string;
}

function upsertPart(messages: Messages, part: Part) {
  const message = messages.get(part.messageID) ?? { info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant', time: { created: Date.now() } } as MessageInfo, parts: [] };
  const index = message.parts.findIndex(existing => existing.id === part.id);
  const parts = index >= 0 ? message.parts.map((existing, position) => (position === index ? part : existing)) : [...message.parts, part];
  messages.set(part.messageID, { ...message, parts });
}

/** Apply one opencode event to a chat's messages. Events for other sessions change nothing. */
export function applyChatEvent(messages: Messages, sessionId: string, type: string, properties: Record<string, unknown>): ChatChange {
  if (properties.sessionID !== sessionId) return { messages: false };
  switch (type) {
    case 'message.updated': {
      const info = properties.info as MessageInfo;
      messages.set(info.id, { info, parts: messages.get(info.id)?.parts ?? [] });
      return { messages: true };
    }
    case 'message.removed':
      return { messages: messages.delete(properties.messageID as string) };
    case 'message.part.updated':
      upsertPart(messages, properties.part as Part);
      return { messages: true };
    case 'message.part.delta': {
      const { messageID, partID, field, delta } = properties as { messageID: string; partID: string; field: string; delta: string };
      const part = messages.get(messageID)?.parts.find(candidate => candidate.id === partID);
      if (!part || field !== 'text') return { messages: false };
      upsertPart(messages, { ...part, text: (part.text ?? '') + delta });
      return { messages: true };
    }
    case 'message.part.removed': {
      const message = messages.get(properties.messageID as string);
      if (!message) return { messages: false };
      messages.set(message.info.id, { ...message, parts: message.parts.filter(part => part.id !== properties.partID) });
      return { messages: true };
    }
    case 'session.status': {
      const status = (properties.status as { type: string }).type;
      return { messages: false, busy: status === 'busy' || status === 'retry' };
    }
    case 'session.idle':
      return { messages: false, busy: false };
    case 'session.error': {
      const error = properties.error as { name?: string; data?: { message?: string } } | undefined;
      if (!error || error.name === 'MessageAbortedError') return { messages: false };
      return { messages: false, error: error.data?.message ?? error.name ?? 'error' };
    }
    default:
      return { messages: false };
  }
}

/** Messages in the order they were sent. */
export function orderedMessages(messages: Messages) {
  return [...messages.values()].sort((left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id));
}
