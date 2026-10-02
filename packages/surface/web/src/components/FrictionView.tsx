import { useEffect, useState } from 'react';
import { api, navigate, useEvents } from '../api.ts';
import type { FrictionRecord } from '../types.ts';
import { Button, Empty, Section } from './ui.tsx';

type Investigation = NonNullable<NonNullable<FrictionRecord['triage']>['investigation']>;

const STALE_REASONS: Record<NonNullable<NonNullable<FrictionRecord['freshness']>['reason']>, string> = {
  source_stale: 'Source stale: the local checkout differs from the investigated commit; this does not mean it is fixed.',
  source_unavailable: 'Source unavailable: local checkout freshness could not be established.',
};

function InvestigationDetails({ investigation }: { investigation: Investigation }) {
  return <>
    <p>Disposition: {investigation.disposition}</p>
    {investigation.fixedBy && <p>Fixing source {investigation.fixedBy}; host condition evidence: {investigation.conditionEvidence?.join(', ') ?? 'unverified'}</p>}
    {(['observed', 'inferred', 'unknown'] as const).map(kind => <div key={kind}>
      <h4>{kind}</h4><ul>{investigation[kind].map((entry, index) => <li key={index}>{entry}</li>)}</ul>
    </div>)}
    {investigation.proposedWork && <>
      <h4>Proposed fix: {investigation.proposedWork.title}</h4>
      <p>{investigation.proposedWork.goal}</p>
      <p>{investigation.proposedWork.repository} · {investigation.proposedWork.rationale}</p>
      <ul>{investigation.proposedWork.acceptance.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
    </>}
  </>;
}

function FreshnessDetails({ record }: { record: FrictionRecord }) {
  const freshness = record.freshness;
  if (!freshness) return null;
  return <section className="space-y-2">
    <p>Investigated at {freshness.investigatedCommit?.slice(0, 8) ?? 'unavailable'} · local checkout {freshness.referenceCommit?.slice(0, 8) ?? 'unavailable'} (not fetched)</p>
    {freshness.reason && <p role="alert">{STALE_REASONS[freshness.reason]}</p>}
    {freshness.stale && freshness.reason === 'source_stale' && freshness.referenceCommit
      && !record.revisions?.some(revision => revision.sourceCommit === freshness.referenceCommit) &&
      <p>Needs revalidation: owners friction-revalidate {record.id}</p>}
  </section>;
}

function RevisionHistory({ record }: { record: FrictionRecord }) {
  if (!record.revisions?.length) return null;
  return <section className="space-y-2">
    <h3 className="font-semibold">Revisions</h3>
    <ol>{record.revisions.map(revision => <li key={revision.revision}>
      Revision {revision.revision} · {revision.sourceCommit.slice(0, 8)} · {revision.state} · {revision.investigation?.disposition ?? 'source-linked duplicate'}
      {revision.blockedReason && <> · {revision.blockedReason}</>}
    </li>)}</ol>
  </section>;
}

function PromotionDetails({ record, busy, retry }: { record: FrictionRecord; busy: boolean; retry: () => void }) {
  const promotion = record.promotion;
  if (!promotion) return null;
  return <section className="space-y-2">
    <h3>Requested by {promotion.by} · {promotion.at}</h3>
    <p>{promotion.owner}: {promotion.status === 'pending-owner' ? 'awaiting owner acceptance' : promotion.status}</p>
    <p className="font-mono break-all">{promotion.requestID}</p>
    {promotion.reason && <p>{promotion.reason}</p>}
    {promotion.status === 'blocked' && (!record.effectiveRevision || !record.proposalDigest
      || promotion.digest === record.proposalDigest) &&
      <Button disabled={busy} onClick={retry}>Retry request routing</Button>}
    {promotion.workItem && <Button onClick={() => navigate('item', promotion.workItem!)}>View linked work</Button>}
    <Button onClick={() => navigate('owner', promotion.owner)}>View responsible owner</Button>
    <p>Request status does not prove the original friction is fixed.</p>
  </section>;
}

export function requestFrictionFix(record: FrictionRecord, action: 'promote-friction' | 'retry-friction-promotion' = 'promote-friction') {
  return api('/api/decide', { method: 'POST', body: { action, id: record.id,
    proposalDigest: action === 'retry-friction-promotion' ? record.promotion?.digest : record.proposalDigest } });
}

/** React text nodes render persisted, untrusted prose inertly. */
export function FrictionDetail({ record, refresh }: { record: FrictionRecord; refresh?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestFix = async (action: 'promote-friction' | 'retry-friction-promotion' = 'promote-friction') => {
    setBusy(true);
    setError('');
    try {
      await requestFrictionFix(record, action);
      refresh?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to request fix');
    } finally { setBusy(false); }
  };
  const canRequestFix = Boolean(record.proposalDigest && (!record.promotion
    || (record.effectiveRevision && record.promotion.status === 'blocked'
      && record.promotion.digest !== record.proposalDigest)));
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
    <FreshnessDetails record={record} />
    <RevisionHistory record={record} />
    {record.triage && <section className="space-y-2">
      <h3 className="font-semibold">Investigation: {record.triage.state}</h3>
      <p>Updated {record.triage.updatedAt}{record.triage.reason ? ` · ${record.triage.reason}` : ''}</p>
      {record.triage.duplicateOf && <Button onClick={() => navigate('friction', record.triage!.duplicateOf!)}>View source-linked incident {record.triage.duplicateOf}</Button>}
      {record.triage.bundle && <details>
        <summary>Host incident evidence · {record.triage.bundle.collectedAt}{record.triage.bundle.abbreviated ? ' · abbreviated' : ''}</summary>
        <p>Local and recorded facts, not live-service attestation. Missing observations remain owner follow-up.</p>
        {record.triage.bundle.facts.map(fact => <p key={fact.key}>{fact.key}: {fact.status}
          {fact.reason ? ` (${fact.reason})` : ''} · {JSON.stringify(fact.values)}</p>)}
      </details>}
      {record.triage.investigation && <>
        <InvestigationDetails investigation={record.triage.investigation} />
        {record.triage.investigation.proposedWork && <>
          {canRequestFix && <>
            <p>{record.promotion ? 'A previous request is blocked; this revised proposal has not been requested.'
              : 'Proposal only; no work has been dispatched.'} Requesting this fix asks the owner to accept and plan it under existing approval rules.</p>
            <Button variant="primary" disabled={busy} onClick={() => void requestFix()}>Request this fix</Button>
          </>}
        </>}
      </>}
    </section>}
    {record.originalInvestigation && <section className="space-y-2">
      <h3 className="font-semibold">Original investigation</h3>
      <InvestigationDetails investigation={record.originalInvestigation} />
    </section>}
    {record.unreadable?.map(code => <p key={code} role="alert">Unable to read friction history: {code}</p>)}
    {error && <p role="alert">{error}</p>}
    <PromotionDetails record={record} busy={busy} retry={() => void requestFix('retry-friction-promotion')} />
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
