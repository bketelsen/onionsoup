import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, navigate, opencodePayload, useEvents, useRoute } from './api.ts';
import { InboxView } from './components/InboxView.tsx';
import { ItemView } from './components/ItemView.tsx';
import { OwnerView } from './components/OwnerView.tsx';
import { Rail } from './components/Rail.tsx';
import { FrictionView } from './components/FrictionView.tsx';
import { InitiativePage } from './components/InitiativeView.tsx';
import { OrgView } from './components/OrgView.tsx';
import { InboxErrors } from './components/InboxErrors.tsx';
import { ProviderHealthBanner } from './components/ProviderHealthBanner.tsx';
import { MobileBar } from './components/Drawer.tsx';
import type { InboxEntry, OwnerSummary, SurfaceState } from './types.ts';

/** What a notification says about a new inbox entry, by kind; other kinds say they are waiting. */
const NOTIFICATION_TITLES: Partial<Record<InboxEntry['kind'], string>> = {
  permission: 'permission needed',
  question: 'a question for you',
  'provider-auth': 'model provider authentication failing',
};

/** What a page is drawn from: the route, the surface's state, and the owner the route names, if any. */
interface PageProps { route: string[]; state?: SurfaceState; owner?: OwnerSummary; refresh: () => void }

/**
 * Each route's page. A page with a title gets the narrow-screen bar from here; one without draws its own (the owner
 * and item pages, whose bars carry their own buttons). An unknown route, or an owner that is not there, is the inbox.
 */
interface PageView {
  title?: string;
  /** Whether the route names what the page needs; the inbox shows when it does not. */
  hasSubject?: (route: string[], owner: OwnerSummary | undefined) => boolean;
  render: (props: PageProps) => ReactNode;
}

const hasId = (route: string[]) => Boolean(route[1]);

const INBOX_PAGE: PageView = { title: 'Inbox', render: ({ state, refresh }) => <InboxView state={state} refresh={refresh} /> };

const PAGES: Record<string, PageView> = {
  inbox: INBOX_PAGE,
  item: { hasSubject: hasId, render: ({ route }) => <ItemView itemId={route[1]!} /> },
  friction: { title: 'Friction', render: ({ route }) => <FrictionView recordId={route[1]} /> },
  org: { title: 'Org', render: () => <OrgView /> },
  initiative: { title: 'Initiative', hasSubject: hasId, render: ({ route }) => <InitiativePage initiativeId={route[1]!} /> },
  owner: {
    hasSubject: (_route, owner) => Boolean(owner),
    render: ({ route, state, owner, refresh }) => <OwnerView key={owner!.id} owner={owner!} inbox={state?.inbox ?? []} sessionId={route[2] === 'chat' ? route[3] : undefined} refresh={refresh} />,
  },
};

/** The page for a route, falling back to the inbox when the route lacks what its page needs. */
function pageFor(route: string[], owner: OwnerSummary | undefined): PageView {
  const page = PAGES[route[0] ?? ''];
  return page && (page.hasSubject?.(route, owner) ?? true) ? page : INBOX_PAGE;
}

const REFRESH_TYPES = new Set(['permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected', 'session.status', 'session.idle']);

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
      const title = NOTIFICATION_TITLES[entry.kind] ?? `${entry.kind} waiting`;
      const notification = new Notification(`${name}: ${title}`, { body: entry.title, tag: `${entry.kind}:${entry.id}` });
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
  const page = pageFor(route, owner);
  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      <ProviderHealthBanner providerHealth={state?.providerHealth ?? []} />
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
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {page.title && <MobileBar title={page.title} />}
        <div className="flex-1 flex min-w-0 min-h-0">{page.render({ route, state, owner, refresh })}</div>
      </div>
      </div>
    </div>
  );
}
