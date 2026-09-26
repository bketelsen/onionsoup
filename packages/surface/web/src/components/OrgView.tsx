import { useEffect, useState } from 'react';
import { api, navigate, useEvents } from '../api.ts';
import type { InitiativeSummary, OrgEntry } from '../types.ts';
import { Badge, Empty, OwnerIcon, Section, statusTone, timeAgo } from './ui.tsx';

function OrgNode({ entry, entries }: { entry: OrgEntry; entries: OrgEntry[] }) {
  const reports = entries.filter(candidate => candidate.manager === entry.id);
  return (
    <li className="flex flex-col gap-1">
      <button className="self-start max-w-full inline-flex flex-wrap items-center gap-x-2 rounded-md px-2 py-1 pointer-coarse:min-h-11 text-left hover:bg-interactive-hover" onClick={() => navigate('owner', entry.id)} title={entry.domain}>
        <OwnerIcon icon={entry.icon} />
        <span className="typography-ui-label">{entry.name}</span>
        {entry.title && <span className="typography-meta text-muted-foreground">{entry.title}</span>}
      </button>
      {reports.length > 0 && (
        <ul className="ml-4 pl-3 border-l border-border flex flex-col gap-1">
          {reports.map(report => <OrgNode key={report.id} entry={report} entries={entries} />)}
        </ul>
      )}
    </li>
  );
}

/** The reporting lines declared with reportsTo, drawn as a tree from the owners nobody manages. */
export function OrgTree({ entries }: { entries: OrgEntry[] }) {
  const roots = entries.filter(entry => !entry.manager);
  return <ul className="flex flex-col gap-1">{roots.map(entry => <OrgNode key={entry.id} entry={entry} entries={entries} />)}</ul>;
}

function InitiativeRow({ initiative }: { initiative: InitiativeSummary }) {
  return (
    <button className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-interactive-hover" onClick={() => navigate('initiative', initiative.id)}>
      <Badge tone={statusTone(initiative.status)}>{initiative.status}</Badge>
      <span className="typography-ui-label flex-1 truncate max-lg:basis-full max-lg:order-first max-lg:whitespace-normal">{initiative.title}</span>
      <span className="typography-meta text-muted-foreground">{initiative.owner} · {initiative.merged}/{initiative.total} merged</span>
      {initiative.openEscalations > 0 && <Badge tone="warning">{initiative.openEscalations} escalated</Badge>}
      <span className="typography-meta text-muted-foreground">{timeAgo(initiative.updatedAt)}</span>
    </button>
  );
}

/** Who reports to whom, and the initiatives managers run through their reports. */
export function OrgView() {
  const [org, setOrg] = useState<OrgEntry[]>();
  const [initiatives, setInitiatives] = useState<InitiativeSummary[]>([]);
  const [error, setError] = useState('');
  const load = () => Promise.all([api<OrgEntry[]>('/api/org'), api<InitiativeSummary[]>('/api/initiatives')]).then(([entries, list]) => {
    setOrg(entries);
    setInitiatives(list);
    setError('');
  }, failure => setError(String(failure.message ?? failure)));
  useEffect(() => { void load(); }, []);
  useEvents(event => { if (event.type === 'onionsoup') void load(); }, []);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 lg:p-6 flex flex-col gap-5">
        <h1 className="typography-h text-xl font-semibold">Org</h1>
        {error && <div className="typography-meta text-status-error">{error}</div>}
        <Section title="Reporting lines">{org ? <OrgTree entries={org} /> : <Empty>Loading…</Empty>}</Section>
        <Section title="Initiatives">
          {initiatives.length ? [...initiatives].reverse().map(initiative => <InitiativeRow key={initiative.id} initiative={initiative} />)
            : <Empty>No initiatives yet. A manager drafts one in chat and submits it for your approval.</Empty>}
        </Section>
      </div>
    </div>
  );
}
