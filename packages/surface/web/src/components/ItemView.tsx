import { useEffect, useState } from 'react';
import { RiArrowLeftLine, RiExternalLinkLine } from '@remixicon/react';
import { api, navigate, useEvents } from '../api.ts';
import type { InboxEntry, WorkItem } from '../types.ts';
import { Decision } from './Decision.tsx';
import { WorkRecovery } from './WorkRecovery.tsx';
import { ItemActivity } from './ItemActivity.tsx';
import { ITEM_SECTIONS } from './ItemSections.tsx';
import { Badge, Empty, statusTone, timeAgo } from './ui.tsx';

/** One work item in full: what was asked, the plan and where it runs, and how host code verified, reviewed and published it. */
export function ItemView({ itemId }: { itemId: string }) {
  const [item, setItem] = useState<WorkItem>();
  const [waiting, setWaiting] = useState<InboxEntry>();
  const [error, setError] = useState('');
  const load = () => api<{ item: WorkItem; waiting?: InboxEntry }>(`/api/items/${itemId}`).then(result => {
    setItem(result.item);
    setWaiting(result.waiting);
  }, failure => setError(String(failure.message ?? failure)));
  useEffect(() => { void load(); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvents(event => { if (event.type === 'onionsoup') void load(); }, [itemId]);
  if (error) return <div className="p-6 text-status-error">{error}</div>;
  if (!item) return <div className="p-6"><Empty>Loading…</Empty></div>;
  const cost = item.hires.reduce((total, hire) => total + hire.cost, 0);
  return (
    <div className="flex-1 flex min-h-0 min-w-0">
    <div className="flex-1 overflow-y-auto min-w-0">
      <div className="max-w-3xl mx-auto p-6 flex flex-col gap-5">
        <button className="self-start inline-flex items-center gap-1 typography-meta text-muted-foreground hover:text-foreground" onClick={() => navigate('owner', item.owner)}>
          <RiArrowLeftLine className="size-3.5" />{item.owner}
        </button>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 typography-meta text-muted-foreground">
            <Badge tone={statusTone(item.status)}>{item.status}</Badge>
            <span className="font-mono">{item.id}</span>
            {item.proposal.repository && <span>{item.proposal.repository}</span>}
            <span>updated {timeAgo(item.updatedAt)}</span>
            {cost > 0 && <span>${cost.toFixed(3)}</span>}
          </div>
          <h1 className="typography-h text-xl font-semibold">{item.proposal.title}</h1>
          {item.reason && <div className="typography-meta text-status-error">{item.reason}</div>}
          {item.publication && (
            <a className="inline-flex items-center gap-1 typography-meta text-primary hover:underline" href={item.publication.url} target="_blank" rel="noreferrer">
              <RiExternalLinkLine className="size-3.5" />{item.publication.url} ({item.publication.state})
            </a>
          )}
        </div>
        {waiting && (
          <div className="flex flex-col gap-1">
            <Decision entry={waiting} compact onDone={() => void load()} />
            {waiting.kind === 'plan' && <span className="typography-micro text-muted-foreground">The plan is below; your note goes with an approval, and is required to send it back.</span>}
          </div>
        )}
        <WorkRecovery item={item} onDone={() => void load()} />
        {ITEM_SECTIONS.map((ItemSection, index) => <ItemSection key={index} item={item} />)}
      </div>
    </div>
    <ItemActivity item={item} />
    </div>
  );
}
