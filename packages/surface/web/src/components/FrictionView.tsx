import { useEffect, useState } from 'react';
import { api, navigate, useEvents } from '../api.ts';
import type { FrictionRecord } from '../types.ts';
import { Button, Empty, Section } from './ui.tsx';

/** React text nodes render persisted, untrusted prose inertly. */
export function FrictionDetail({ record, refresh }: { record: FrictionRecord; refresh?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestFix = async (action = 'promote-friction') => {
    setBusy(true);
    setError('');
    try {
      await api('/api/decide', { method: 'POST', body: { action, id: record.id, proposalDigest: action === 'retry-friction-promotion' ? record.promotion?.digest : record.proposalDigest } });
      refresh?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to request fix');
    } finally { setBusy(false); }
  };
  return <article className="space-y-3 whitespace-pre-wrap break-words">
    <h2 className="text-lg font-semibold">{record.summary}</h2>
    <p>Expected: {record.expected}</p>
    <p>Actual: {record.actual}</p>
    {record.evidence && <p>Evidence: {record.evidence}</p>}
    <p>Failure context: {record.failureContext}{record.provisional ? ' (provisional match)' : ''}</p>
    {record.failures.map((failure, index) => <p key={index}>{failure.tool}: {failure.error} ({failure.input})</p>)}
    <p>{record.owner} · {record.count} reports · first {record.firstSeen} · latest {record.lastSeen}</p>
    <p>Engine: {record.commit} · Model: {record.model}</p>
    {record.triageError && <p role="alert">Investigation status unavailable: {record.triageError}</p>}
    {record.triage && <section className="space-y-2">
      <h3 className="font-semibold">Investigation: {record.triage.state}</h3>
      <p>Updated {record.triage.updatedAt}{record.triage.reason ? ` · ${record.triage.reason}` : ''}</p>
      {record.triage.investigation && <>
        <p>Disposition: {record.triage.investigation.disposition}</p>
        {(['observed', 'inferred', 'unknown'] as const).map(kind => <div key={kind}>
          <h4>{kind}</h4><ul>{record.triage!.investigation![kind].map((entry, index) => <li key={index}>{entry}</li>)}</ul>
        </div>)}
        {record.triage.investigation.proposedWork && <>
          <h4>Proposed fix: {record.triage.investigation.proposedWork.title}</h4>
          <p>{record.triage.investigation.proposedWork.goal}</p>
          <p>{record.triage.investigation.proposedWork.repository} · {record.triage.investigation.proposedWork.rationale}</p>
          <ul>{record.triage.investigation.proposedWork.acceptance.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
          {!record.promotion && <>
            <p>Proposal only; no work has been dispatched. Requesting this fix asks the owner to accept and plan it under existing approval rules.</p>
            {record.proposalDigest && <Button variant="primary" disabled={busy} onClick={() => void requestFix()}>Request this fix</Button>}
          </>}
        </>}
      </>}
    </section>}
    {error && <p role="alert">{error}</p>}
    {record.promotion && <section className="space-y-2">
      <h3>Requested by {record.promotion.by} · {record.promotion.at}</h3>
      <p>{record.promotion.owner}: {record.promotion.status === 'pending-owner' ? 'awaiting owner acceptance' : record.promotion.status}</p>
      <p className="font-mono break-all">{record.promotion.requestID}</p>
      {record.promotion.reason && <p>{record.promotion.reason}</p>}
      {record.promotion.status === 'blocked' && <Button disabled={busy}
        onClick={() => void requestFix('retry-friction-promotion')}>Retry request routing</Button>}
      {record.promotion.workItem && <Button onClick={() => navigate('item', record.promotion!.workItem!)}>View linked work</Button>}
      <Button onClick={() => navigate('owner', record.promotion!.owner)}>View responsible owner</Button>
      <p>Request status does not prove the original friction is fixed.</p>
    </section>}
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
  useEvents(event => {
    if (event.type !== 'onionsoup') return;
    void load();
    if (recordId) void api<FrictionRecord>(`/api/friction/${encodeURIComponent(recordId)}`)
      .then(setDetail, failure => setDetailError(String(failure.message ?? failure)));
  }, [recordId]);
  const sorted = [...records].sort((left, right) => sort === 'newest'
    ? right.lastSeen.localeCompare(left.lastSeen)
    : right.count - left.count || right.lastSeen.localeCompare(left.lastSeen));
  return <main className="flex-1 min-w-0 overflow-y-auto p-4 lg:p-6 space-y-4">
    <h1 className="text-xl font-semibold">Friction</h1>
    {error && <p className="text-status-error">{error}</p>}
    <Section title="Reports" action={<label>Sort <select className="rounded border border-border bg-secondary pointer-coarse:min-h-11" value={sort}
      onChange={event => setSort(event.target.value as typeof sort)}>
      <option value="newest">Newest</option><option value="most-reported">Most reported</option>
    </select></label>}>
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="w-full lg:w-72 shrink-0 space-y-2">{sorted.length ? sorted.map(record => <Button key={record.id}
        className="w-full text-left break-words" onClick={() => navigate('friction', record.id)}>
        {record.summary} · {record.count} · {record.triageError ? 'status unavailable' : record.triage?.state ?? 'not investigated'}</Button>) : <Empty>No friction reports yet.</Empty>}</div>
      {detailError && <p className="text-status-error">{detailError}</p>}
      {detail && <div className="min-w-0 max-lg:order-first"><FrictionDetail key={detail.id} record={detail} refresh={() => {
        void load();
        void api<FrictionRecord>(`/api/friction/${encodeURIComponent(detail.id)}`)
          .then(setDetail, failure => setDetailError(String(failure.message ?? failure)));
      }} /></div>}
    </div>
    </Section>
  </main>;
}
