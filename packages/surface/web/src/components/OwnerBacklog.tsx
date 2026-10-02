import type { Attention } from '@onionsoup/owners';
import { Badge, Section, timeAgo } from './ui.tsx';

function BacklogEntry({ entry }: { entry: Attention }) {
  return <li className="flex flex-col gap-1 rounded-md border border-border p-2">
    <div className="flex items-center gap-2 typography-micro text-muted-foreground">
      <Badge>{entry.status === 'open' ? 'Owner backlog' : entry.status}</Badge>
      <span>{timeAgo(entry.at)}</span>
    </div>
    <span className="typography-meta [overflow-wrap:anywhere] whitespace-pre-wrap">{entry.note}</span>
    {entry.decision && <span className="typography-micro text-muted-foreground">
      {entry.decision.by}: {entry.decision.reason}
    </span>}
    {entry.resolution && <span className="typography-micro text-muted-foreground">{entry.resolution.code}</span>}
  </li>;
}

/** Informational work and retained decisions are not warning cards or implicit assignment controls. */
export function OwnerBacklog({ entries }: { entries: Attention[] }) {
  const pending = entries.filter(entry => entry.status === 'open');
  const history = entries.filter(entry => entry.status !== 'open');
  if (!entries.length) return null;
  return <Section title={`Owner backlog (${pending.length})`}>
    <p className="typography-micro text-muted-foreground">Owner follow-up, not waiting on you. Work still uses its existing approval gates.</p>
    <ol className="flex flex-col gap-2">{pending.map(entry => <BacklogEntry key={entry.id} entry={entry} />)}</ol>
    {history.length > 0 && <details>
      <summary className="typography-meta text-muted-foreground cursor-pointer">History ({history.length})</summary>
      <ol className="mt-2 flex flex-col gap-2">{history.map(entry => <BacklogEntry key={entry.id} entry={entry} />)}</ol>
    </details>}
  </Section>;
}
