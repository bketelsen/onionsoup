import type { SurfaceState } from '../types.ts';
import { Decision } from './Decision.tsx';
import { Empty } from './ui.tsx';

/** Everything across all owners that waits on the person. */
export function InboxView({ state, refresh }: { state?: SurfaceState; refresh: () => void }) {
  const owners = new Map(state?.owners.map(owner => [owner.id, owner]));
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 lg:p-6 flex flex-col gap-3">
        <h1 className="typography-h text-xl font-semibold">Inbox</h1>
        <p className="typography-meta text-muted-foreground">What your owners are waiting on you for: plans, publishing, requests, and permissions asked in chats.</p>
        {!state && <Empty>Loading…</Empty>}
        {state && !state.inbox.length && <Empty>Nothing waits on you.</Empty>}
        {state?.inbox.map(entry => <Decision key={`${entry.kind}:${entry.id}`} entry={entry} owner={owners.get(entry.owner)} onDone={refresh} />)}
      </div>
    </div>
  );
}
