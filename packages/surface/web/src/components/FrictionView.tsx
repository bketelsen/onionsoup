import { useEffect, useState } from 'react';
import { api, navigate, useEvents } from '../api.ts';
import type { FrictionRecord } from '../types.ts';
import { Button, Empty, Section } from './ui.tsx';

/** React text nodes render persisted, untrusted prose inertly. */
export function FrictionDetail({ record }: { record: FrictionRecord }) {
  return <article className="space-y-3 whitespace-pre-wrap break-words">
    <h2 className="text-lg font-semibold">{record.summary}</h2>
    <p>Expected: {record.expected}</p>
    <p>Actual: {record.actual}</p>
    {record.evidence && <p>Evidence: {record.evidence}</p>}
    <p>Failure context: {record.failureContext}{record.provisional ? ' (provisional match)' : ''}</p>
    {record.failures.map((failure, index) => <p key={index}>{failure.tool}: {failure.error} ({failure.input})</p>)}
    <p>{record.owner} · {record.count} reports · first {record.firstSeen} · latest {record.lastSeen}</p>
    <p>Engine: {record.commit} · Model: {record.model}</p>
    <Button onClick={() => navigate('owner', record.owner, 'chat', record.sessionID)}>Open originating chat</Button>
  </article>;
}

export function FrictionView({ recordId }: { recordId?: string }) {
  const [records, setRecords] = useState<FrictionRecord[]>([]);
  const [sort, setSort] = useState<'newest' | 'most-reported'>('newest');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<FrictionRecord>();
  const [detailError, setDetailError] = useState('');
  const load = () => api<FrictionRecord[]>('/api/friction').then(entries => {
    setRecords(entries);
    setError('');
  }, failure => setError(String(failure.message ?? failure)));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDetail(undefined);
    setDetailError('');
    if (recordId) void api<FrictionRecord>(`/api/friction/${encodeURIComponent(recordId)}`)
      .then(setDetail, failure => setDetailError(String(failure.message ?? failure)));
  }, [recordId]);
  useEvents(event => { if (event.type === 'onionsoup') void load(); }, []);
  const sorted = [...records].sort((left, right) => sort === 'newest'
    ? right.lastSeen.localeCompare(left.lastSeen)
    : right.count - left.count || right.lastSeen.localeCompare(left.lastSeen));
  return <main className="flex-1 overflow-y-auto p-6 space-y-4">
    <h1 className="text-xl font-semibold">Friction</h1>
    {error && <p className="text-status-error">{error}</p>}
    <Section title="Reports" action={<label>Sort <select className="rounded border border-border bg-secondary" value={sort}
      onChange={event => setSort(event.target.value as typeof sort)}>
      <option value="newest">Newest</option><option value="most-reported">Most reported</option>
    </select></label>}>
    <div className="flex gap-6">
      <div className="w-72 shrink-0 space-y-2">{sorted.length ? sorted.map(record => <Button key={record.id}
        className="w-full text-left break-words" onClick={() => navigate('friction', record.id)}>
        {record.summary} · {record.count}</Button>) : <Empty>No friction reports yet.</Empty>}</div>
      {detailError && <p className="text-status-error">{detailError}</p>}
      {detail && <FrictionDetail record={detail} />}
    </div>
    </Section>
  </main>;
}
