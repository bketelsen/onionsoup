import { useEffect, useSyncExternalStore } from 'react';

/** JSON calls to the surface server. Errors carry the server's message. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

type Listener = (event: { type: string; data: unknown }) => void;

/**
 * One EventSource for the whole app. `opencode` events are opencode's global events ({directory, payload});
 * `onionsoup` says engine state changed. `connected` tracks the stream for a status dot.
 */
class Events {
  private source?: EventSource;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<() => void>();
  connected = false;

  start() {
    if (this.source) return;
    const source = new EventSource('/api/events');
    this.source = source;
    const setConnected = (value: boolean) => {
      this.connected = value;
      for (const listener of this.statusListeners) listener();
    };
    source.addEventListener('hello', () => {
      setConnected(true);
      this.emit('reconnected', {});
    });
    source.onerror = () => setConnected(false);
    for (const type of ['opencode', 'onionsoup']) {
      source.addEventListener(type, event => {
        try {
          this.emit(type, JSON.parse((event as MessageEvent).data));
        } catch {
          // Ignore malformed frames.
        }
      });
    }
  }

  private emit(type: string, data: unknown) {
    for (const listener of this.listeners) listener({ type, data });
  }

  subscribe(listener: Listener) {
    this.start();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeStatus = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  };
}

export const events = new Events();

export function useEvents(listener: Listener, deps: unknown[]) {
  useEffect(() => events.subscribe(listener), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useConnected() {
  return useSyncExternalStore(events.subscribeStatus, () => events.connected);
}

/** An opencode event's payload type and properties, whichever wrapper it arrived in. */
export function opencodePayload(data: unknown): { directory?: string; type: string; properties: Record<string, unknown> } {
  const outer = data as { directory?: string; payload?: { type: string; properties: Record<string, unknown> } };
  const payload = outer.payload ?? (data as { type: string; properties: Record<string, unknown> });
  return { directory: outer.directory, type: payload?.type ?? '', properties: payload?.properties ?? {} };
}

/** Current hash route, split into parts: #/owner/leto/chat/ses_1 → ['owner', 'leto', 'chat', 'ses_1']. */
function currentRoute() {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute() {
  const hash = useSyncExternalStore(
    listener => { addEventListener('hashchange', listener); return () => removeEventListener('hashchange', listener); },
    () => location.hash,
  );
  void hash;
  return currentRoute();
}

export function navigate(...parts: string[]) {
  location.hash = `#/${parts.map(encodeURIComponent).join('/')}`;
}
