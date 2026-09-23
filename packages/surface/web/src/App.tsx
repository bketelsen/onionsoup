import { useCallback, useEffect, useState } from 'react';
import { api, opencodePayload, useEvents, useRoute } from './api.ts';
import { InboxView } from './components/InboxView.tsx';
import { ItemView } from './components/ItemView.tsx';
import { OwnerView } from './components/OwnerView.tsx';
import { Rail } from './components/Rail.tsx';
import type { SurfaceState } from './types.ts';

const REFRESH_TYPES = new Set(['permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected', 'session.status']);

export function App() {
  const route = useRoute();
  const [state, setState] = useState<SurfaceState>();
  const refresh = useCallback(() => { void api<SurfaceState>('/api/state').then(setState, () => undefined); }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEvents(event => {
    if (event.type !== 'opencode' || REFRESH_TYPES.has(opencodePayload(event.data).type)) refresh();
  }, [refresh]);

  const owner = route[0] === 'owner' ? state?.owners.find(candidate => candidate.id === route[1]) : undefined;
  return (
    <div className="h-full flex bg-background text-foreground">
      <Rail state={state} route={route} />
      {route[0] === 'item' && route[1] ? <ItemView itemId={route[1]} />
        : owner ? <OwnerView key={owner.id} owner={owner} inbox={state?.inbox ?? []} sessionId={route[2] === 'chat' ? route[3] : undefined} refresh={refresh} />
          : <InboxView state={state} refresh={refresh} />}
    </div>
  );
}
