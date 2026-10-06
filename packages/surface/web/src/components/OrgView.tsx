import { useEffect, useState } from 'react';
import { api, navigate, useEvents } from '../api.ts';
import type { OrgEntry } from '../types.ts';
import { Empty, OwnerIcon, Section } from './ui.tsx';

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

/** Who reports to whom. */
export function OrgView() {
  const [org, setOrg] = useState<OrgEntry[]>();
  const [error, setError] = useState('');
  const load = () => api<OrgEntry[]>('/api/org').then(entries => {
    setOrg(entries);
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
      </div>
    </div>
  );
}
