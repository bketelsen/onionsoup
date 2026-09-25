import { useCallback, useEffect, useRef, useState } from 'react';
import { api, navigate, opencodePayload, useEvents, useRoute } from './api.ts';
import { InboxView } from './components/InboxView.tsx';
import { ItemView } from './components/ItemView.tsx';
import { OwnerView } from './components/OwnerView.tsx';
import { Rail } from './components/Rail.tsx';
import { FrictionView } from './components/FrictionView.tsx';
import { InitiativePage } from './components/InitiativeView.tsx';
import { OrgView } from './components/OrgView.tsx';
import { InboxErrors } from './components/InboxErrors.tsx';
import type { SurfaceState } from './types.ts';

const REFRESH_TYPES = new Set(['permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected', 'session.status']);

export function App() {
  const route = useRoute();
  const [state, setState] = useState<SurfaceState>();
  const [refreshError, setRefreshError] = useState('');
  const refresh = useCallback(() => {
    void api<SurfaceState>('/api/state').then(snapshot => {
      setState(snapshot);
      setRefreshError('');
    }, failure => setRefreshError(failure instanceof Error ? failure.message : String(failure)));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEvents(event => {
    if (event.type !== 'opencode' || REFRESH_TYPES.has(opencodePayload(event.data).type)) refresh();
  }, [refresh]);

  // Tell the person when something new waits on them while the surface is in the background.
  const known = useRef<Set<string>>(undefined);
  useEffect(() => {
    if (!state) return;
    const keys = new Set(state.inbox.map(entry => `${entry.kind}:${entry.id}`));
    const previous = known.current;
    known.current = keys;
    if (!previous || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const entry of state.inbox.filter(candidate => !previous.has(`${candidate.kind}:${candidate.id}`))) {
      const name = [state.operator, ...state.owners].find(candidate => candidate?.id === entry.owner)?.name ?? entry.owner;
      const notification = new Notification(`${name}: ${entry.kind === 'permission' ? 'permission needed' : entry.kind === 'question' ? 'a question for you' : `${entry.kind} waiting`}`, { body: entry.title, tag: `${entry.kind}:${entry.id}` });
      notification.onclick = () => {
        window.focus();
        if (entry.sessionID) navigate('owner', entry.owner, 'chat', entry.sessionID);
        else navigate('inbox');
      };
    }
  }, [state]);

  // Keyboard: Alt+↑/↓ moves between owners, Alt+I opens the inbox, / focuses the message box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT');
      if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && state?.owners.length) {
        event.preventDefault();
        const ids = state.owners.map(candidate => candidate.id);
        const index = route[0] === 'owner' ? ids.indexOf(route[1] ?? '') : -1;
        const next = event.key === 'ArrowDown' ? (index + 1) % ids.length : (index <= 0 ? ids.length - 1 : index - 1);
        navigate('owner', ids[next]!);
      } else if (event.altKey && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        navigate('inbox');
      } else if (event.key === '/' && !typing) {
        const composer = document.querySelector<HTMLTextAreaElement>('form textarea');
        if (composer) { event.preventDefault(); composer.focus(); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [state, route]);

  const chats = state ? [...(state.operator ? [state.operator] : []), ...state.owners] : [];
  const owner = route[0] === 'owner' ? chats.find(candidate => candidate.id === route[1]) : undefined;
  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      <InboxErrors errors={state?.inboxErrors ?? []} refreshError={refreshError} />
      {state?.opencode && !state.opencode.ok && (
        <div role="alert" className="shrink-0 px-4 py-2 typography-meta border-b border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error)]">
          Chats are unavailable: {state.opencode.error}. If the surface is attached to another opencode (OPENCODE_URL), that opencode may have moved or stopped; restart the surface, or run it with its own opencode (the default).
        </div>
      )}
      <div className="flex-1 flex min-h-0">
      <Rail state={state} route={route} onReorder={order => {
        setState(current => current && { ...current, owners: order.map(id => current.owners.find(owner => owner.id === id)!).filter(Boolean) });
        void api('/api/settings/owner-order', { method: 'PUT', body: { order } }).catch(() => refresh());
      }} />
      {route[0] === 'item' && route[1] ? <ItemView itemId={route[1]} />
        : route[0] === 'friction' ? <FrictionView recordId={route[1]} />
        : route[0] === 'org' ? <OrgView />
        : route[0] === 'initiative' && route[1] ? <InitiativePage initiativeId={route[1]} />
        : owner ? <OwnerView key={owner.id} owner={owner} inbox={state?.inbox ?? []} sessionId={route[2] === 'chat' ? route[3] : undefined} refresh={refresh} />
          : <InboxView state={state} refresh={refresh} />}
      </div>
    </div>
  );
}
