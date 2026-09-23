import { useCallback, useEffect, useRef, useState } from 'react';
import { api, opencodePayload, useEvents } from '../api.ts';
import type { Message, MessageInfo, Part } from '../types.ts';

export interface ChatState {
  messages: Message[];
  busy: boolean;
  loaded: boolean;
  error: string;
}

/**
 * One chat's messages, kept live from opencode's events: message and part updates, streamed text deltas,
 * removals and the session's busy status. Messages are loaded once, then patched; a reconnect reloads.
 */
export function useChat(ownerId: string, sessionId: string, directory: string) {
  const [state, setState] = useState<ChatState>({ messages: [], busy: false, loaded: false, error: '' });
  const messages = useRef(new Map<string, Message>());
  const frame = useRef<ReturnType<typeof setTimeout>>(undefined);

  const publish = useCallback(() => {
    // A timer rather than requestAnimationFrame: frames never fire in a hidden tab, and a chat must keep up anyway.
    clearTimeout(frame.current);
    frame.current = setTimeout(() => {
      const ordered = [...messages.current.values()].sort((left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id));
      setState(current => ({ ...current, messages: ordered }));
    }, 16);
  }, []);

  const load = useCallback(async () => {
    try {
      const loaded = await api<Message[]>(`/api/owners/${ownerId}/sessions/${sessionId}/messages`);
      messages.current = new Map(loaded.map(message => [message.info.id, message]));
      setState(current => ({ ...current, loaded: true, error: '' }));
      publish();
    } catch (failure) {
      setState(current => ({ ...current, loaded: true, error: failure instanceof Error ? failure.message : String(failure) }));
    }
  }, [ownerId, sessionId, publish]);

  useEffect(() => {
    messages.current = new Map();
    setState({ messages: [], busy: false, loaded: false, error: '' });
    void load();
    void api<{ status: Record<string, { type: string }> }>(`/api/owners/${ownerId}/sessions`).then(result => {
      const status = result.status[sessionId]?.type;
      setState(current => ({ ...current, busy: status === 'busy' || status === 'retry' }));
    }, () => undefined);
    return () => clearTimeout(frame.current);
  }, [ownerId, sessionId, load]);

  const upsertPart = (part: Part) => {
    const message = messages.current.get(part.messageID) ?? { info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant', time: { created: Date.now() } } as MessageInfo, parts: [] };
    const index = message.parts.findIndex(existing => existing.id === part.id);
    const parts = index >= 0 ? message.parts.map((existing, position) => (position === index ? part : existing)) : [...message.parts, part];
    messages.current.set(part.messageID, { ...message, parts });
  };

  useEvents(event => {
    if (event.type === 'reconnected') { void load(); return; }
    if (event.type !== 'opencode') return;
    const { directory: from, type, properties } = opencodePayload(event.data);
    if (from && directory && from !== directory) return;
    if (properties.sessionID !== sessionId) return;
    switch (type) {
      case 'message.updated': {
        const info = properties.info as MessageInfo;
        const existing = messages.current.get(info.id);
        messages.current.set(info.id, { info, parts: existing?.parts ?? [] });
        publish();
        break;
      }
      case 'message.removed':
        messages.current.delete(properties.messageID as string);
        publish();
        break;
      case 'message.part.updated':
        upsertPart(properties.part as Part);
        publish();
        break;
      case 'message.part.delta': {
        const { messageID, partID, field, delta } = properties as { messageID: string; partID: string; field: string; delta: string };
        const message = messages.current.get(messageID);
        const part = message?.parts.find(candidate => candidate.id === partID);
        if (part && field === 'text') {
          upsertPart({ ...part, text: (part.text ?? '') + delta });
          publish();
        }
        break;
      }
      case 'message.part.removed': {
        const message = messages.current.get(properties.messageID as string);
        if (message) {
          messages.current.set(message.info.id, { ...message, parts: message.parts.filter(part => part.id !== properties.partID) });
          publish();
        }
        break;
      }
      case 'session.status': {
        const status = (properties.status as { type: string }).type;
        setState(current => ({ ...current, busy: status === 'busy' || status === 'retry' }));
        break;
      }
      case 'session.idle':
        setState(current => ({ ...current, busy: false }));
        break;
      case 'session.error': {
        const error = properties.error as { name?: string; data?: { message?: string } } | undefined;
        if (error && error.name !== 'MessageAbortedError') setState(current => ({ ...current, error: error.data?.message ?? error.name ?? 'error' }));
        break;
      }
    }
  }, [sessionId, directory, load, publish]);

  const send = useCallback(async (text: string) => {
    setState(current => ({ ...current, busy: true, error: '' }));
    try {
      await api(`/api/owners/${ownerId}/sessions/${sessionId}/prompt`, { method: 'POST', body: { text } });
    } catch (failure) {
      setState(current => ({ ...current, busy: false, error: failure instanceof Error ? failure.message : String(failure) }));
      throw failure;
    }
  }, [ownerId, sessionId]);

  const abort = useCallback(() => api(`/api/owners/${ownerId}/sessions/${sessionId}/abort`, { method: 'POST', body: {} }), [ownerId, sessionId]);

  return { ...state, send, abort, reload: load };
}
