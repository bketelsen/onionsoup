import { useEffect, useState } from 'react';
import { RiArrowLeftLine, RiExternalLinkLine } from '@remixicon/react';
import { api, navigate, useEvents } from '../api.ts';
import type { PublicAssignment, PublicInitiative } from '../types.ts';
import { Decision } from './Decision.tsx';
import { Badge, Empty, Section, statusTone, timeAgo } from './ui.tsx';

type Tone = Parameters<typeof Badge>[0]['tone'];

const STATE_CHIPS: Record<PublicAssignment['state'], { label: string; tone: Tone }> = {
  cancelled: { label: 'cancelled', tone: 'muted' },
  'not-dispatched': { label: 'not dispatched', tone: 'muted' },
  requested: { label: 'requested', tone: 'info' },
  working: { label: 'working', tone: 'info' },
  'plan-waiting': { label: 'plan waiting', tone: 'warning' },
  'awaiting-merge': { label: 'waiting on you to merge', tone: 'warning' },
  'awaiting-person': { label: 'waiting on you', tone: 'warning' },
  blocked: { label: 'interrupted', tone: 'error' },
  completed: { label: 'merged', tone: 'success' },
  failed: { label: 'failed', tone: 'error' },
};

function AssignmentRow({ assignment }: { assignment: PublicAssignment }) {
  const chip = STATE_CHIPS[assignment.state];
  const { item } = assignment;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
        <span className="font-mono">{assignment.id}</span>
        <span>→ {assignment.to}</span>
        <Badge tone={chip.tone}>{chip.label}</Badge>
        {assignment.after.length > 0 && <span>after {assignment.after.join(', ')}</span>}
      </div>
      <div className="typography-ui-label">{assignment.title}</div>
      {item && (
        <div className="flex flex-wrap items-center gap-x-3 typography-meta">
          <button className="text-primary hover:underline font-mono pointer-coarse:min-h-11 break-all text-left" onClick={() => navigate('item', item.id)}>{item.id}</button>
          <span className="text-muted-foreground">{item.status}</span>
          {item.url && (
            <a className="inline-flex items-center gap-1 pointer-coarse:min-h-11 text-primary hover:underline" href={item.url} target="_blank" rel="noreferrer">
              <RiExternalLinkLine className="size-3.5" />PR ({item.prState})
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Assignments in dependency order: each step needs the ones above it merged first. */
function Steps({ assignments }: { assignments: PublicAssignment[] }) {
  const depths = [...new Set(assignments.map(assignment => assignment.depth))].sort((left, right) => left - right);
  return <>{depths.map(depth => (
    <div key={depth} className="flex flex-col gap-1.5">
      <div className="typography-micro text-muted-foreground">Step {depth + 1}</div>
      {assignments.filter(assignment => assignment.depth === depth).map(assignment => <AssignmentRow key={assignment.id} assignment={assignment} />)}
    </div>
  ))}</>;
}

/** One initiative: the breakdown, where each assignment stands, and what managers and reports said about it. */
export function InitiativeView({ initiative, onDone }: { initiative: PublicInitiative; onDone?: () => void }) {
  const { assignments, escalations, planReviews, feedback } = initiative;
  const decision = { kind: 'initiative' as const, id: initiative.id, owner: initiative.owner, title: `Approve the breakdown (revision ${initiative.revision})`, detail: '' };
  return (
    <div className="max-w-3xl mx-auto p-4 lg:p-6 flex flex-col gap-5">
      <button className="self-start inline-flex items-center gap-1 pointer-coarse:min-h-11 typography-meta text-muted-foreground hover:text-foreground" onClick={() => navigate('org')}>
        <RiArrowLeftLine className="size-3.5" />Org
      </button>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
          <Badge tone={statusTone(initiative.status)}>{initiative.status}</Badge>
          <span className="font-mono">{initiative.id}</span>
          <span>revision {initiative.revision}</span>
          <button className="hover:text-foreground pointer-coarse:min-h-11" onClick={() => navigate('owner', initiative.owner)}>{initiative.owner}</button>
          <span>updated {timeAgo(initiative.updatedAt)}</span>
        </div>
        <h1 className="typography-h text-xl font-semibold [overflow-wrap:anywhere]">{initiative.title}</h1>
        {initiative.outcome && <div className="typography-meta text-muted-foreground">{initiative.outcome}</div>}
      </div>
      {initiative.status === 'awaiting-approval' && <Decision entry={decision} compact onDone={() => onDone?.()} />}
      <Section title="Why">
        <div className="typography-markdown flex flex-col gap-1">
          <p><strong>Goal.</strong> {initiative.goal}</p>
          <p><strong>Why.</strong> {initiative.rationale}</p>
          {initiative.approval && <p className="text-muted-foreground">Approved by {initiative.approval.by} for revision {initiative.approval.revision}.</p>}
        </div>
      </Section>
      <Section title="Assignments">{assignments.length ? <Steps assignments={assignments} /> : <Empty>No assignments yet.</Empty>}</Section>
      {escalations.length > 0 && (
        <Section title="Escalations">
          {escalations.map(escalation => (
            <div key={escalation.id} className="typography-meta flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-x-2">
                <Badge tone={escalation.resolution ? 'muted' : 'warning'}>{escalation.kind}</Badge>
                <span>{escalation.from} on {escalation.assignment}</span>
                <span className="text-muted-foreground">{timeAgo(escalation.at)}</span>
              </div>
              <div>{escalation.note}</div>
              {escalation.resolution && <div className="text-muted-foreground">Resolved by {escalation.resolution.by}: {escalation.resolution.note}</div>}
            </div>
          ))}
        </Section>
      )}
      {planReviews.length > 0 && (
        <Section title="Plan reviews">
          {planReviews.map(review => (
            <div key={`${review.item}-${review.digest}-${review.at}`} className="typography-meta flex flex-wrap items-center gap-x-2">
              <Badge tone={review.verdict === 'approve' ? 'success' : 'warning'}>{review.verdict}</Badge>
              <button className="text-primary hover:underline font-mono pointer-coarse:min-h-11" onClick={() => navigate('item', review.item)}>{review.item}</button>
              <span>{review.by}{review.note ? `: ${review.note}` : ''}</span>
            </div>
          ))}
        </Section>
      )}
      {feedback.length > 0 && (
        <Section title="Sent back">
          {feedback.map(entry => <div key={entry.at} className="typography-meta">{entry.by} (revision {entry.revision}): {entry.note}</div>)}
        </Section>
      )}
    </div>
  );
}

export function InitiativePage({ initiativeId }: { initiativeId: string }) {
  const [initiative, setInitiative] = useState<PublicInitiative>();
  const [error, setError] = useState('');
  const load = () => api<PublicInitiative>(`/api/initiatives/${encodeURIComponent(initiativeId)}`).then(setInitiative, failure => setError(String(failure.message ?? failure)));
  useEffect(() => { void load(); }, [initiativeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvents(event => { if (event.type === 'onionsoup') void load(); }, [initiativeId]);
  if (error) return <div className="p-4 lg:p-6 text-status-error">{error}</div>;
  if (!initiative) return <div className="p-4 lg:p-6"><Empty>Loading…</Empty></div>;
  return <div className="flex-1 overflow-y-auto"><InitiativeView initiative={initiative} onDone={() => void load()} /></div>;
}
