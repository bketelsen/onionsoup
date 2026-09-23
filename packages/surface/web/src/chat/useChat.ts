import { useCallback, useEffect, useRef, useState } from 'react';
import { api, opencodePayload, useEvents } from '../api.ts';
import type { Message } from '../types.ts';
import { applyChatEvent, orderedMessages } from './chatState.ts';

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
      setState(current => ({ ...current, messages: orderedMessages(messages.current) }));
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

  useEvents(event => {
    if (event.type === 'reconnected') { void load(); return; }
    if (event.type !== 'opencode') return;
    const { directory: from, type, properties } = opencodePayload(event.data);
    if (from && directory && from !== directory) return;
    const change = applyChatEvent(messages.current, sessionId, type, properties);
    if (change.messages) publish();
    if (change.busy !== undefined) setState(current => ({ ...current, busy: change.busy! }));
    if (change.error) setState(current => ({ ...current, error: change.error! }));
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
