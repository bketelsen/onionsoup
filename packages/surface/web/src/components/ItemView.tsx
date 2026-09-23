import { useEffect, useState } from 'react';
import { RiArrowLeftLine, RiExternalLinkLine } from '@remixicon/react';
import { api, navigate, useEvents } from '../api.ts';
import type { InboxEntry, WorkItem } from '../types.ts';
import { Decision } from './Decision.tsx';
import { ItemActivity } from './ItemActivity.tsx';
import { Badge, Empty, Section, statusTone, timeAgo } from './ui.tsx';

/** One work item in full: what was proposed, the plan, who was hired, what verification and review said. */
export function ItemView({ itemId }: { itemId: string }) {
  const [item, setItem] = useState<WorkItem>();
  const [error, setError] = useState('');
  const load = () => api<{ item: WorkItem }>(`/api/items/${itemId}`).then(result => setItem(result.item), failure => setError(String(failure.message ?? failure)));
  useEffect(() => { void load(); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvents(event => { if (event.type === 'onionsoup') void load(); }, [itemId]);
  if (error) return <div className="p-6 text-status-error">{error}</div>;
  if (!item) return <div className="p-6"><Empty>Loading…</Empty></div>;
  const cost = item.hires.reduce((total, hire) => total + hire.cost, 0);
  const waiting = waitingOn(item);
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
            <span>${cost.toFixed(3)}</span>
          </div>
          <h1 className="typography-h text-xl font-semibold">{item.proposal.title}</h1>
          {item.reason && <div className="typography-meta text-status-error">{item.reason}</div>}
          {item.publication && (
            <a className="inline-flex items-center gap-1 typography-meta text-primary hover:underline" href={item.publication.url} target="_blank" rel="noreferrer">
              <RiExternalLinkLine className="size-3.5" />{item.publication.url} ({item.publication.state})
            </a>
          )}
          {!item.publication && item.status === 'landed' && item.branch && <div className="typography-meta text-muted-foreground">Landed on {item.branch}, not yet a PR.</div>}
        </div>
        {waiting && (
          <div className="flex flex-col gap-1">
            <Decision entry={waiting} compact onDone={() => void load()} />
            {waiting.kind === 'plan' && <span className="typography-micro text-muted-foreground">The plan is below; your note goes with an approval, and is required to send it back or reject it.</span>}
          </div>
        )}
        <Section title="Proposal">
          <div className="typography-markdown flex flex-col gap-1">
            <p><strong>Goal.</strong> {item.proposal.goal}</p>
            <p><strong>Why.</strong> {item.proposal.rationale}</p>
            <ul className="list-disc pl-5">{item.proposal.acceptance.map(entry => <li key={entry}>{entry}</li>)}</ul>
          </div>
        </Section>
        {item.plan && (
          <Section title={item.planApproval ? `Plan (approved by ${item.planApproval.by} ${timeAgo(item.planApproval.at)})` : 'Plan'}>
            <div className="typography-markdown flex flex-col gap-2">
              <p>{item.plan.summary}</p>
              <ol className="list-decimal pl-5 flex flex-col gap-1">
                {item.plan.steps.map((step, index) => (
                  <li key={index}>{step.description} {step.files.length > 0 && <span className="typography-code text-muted-foreground">[{step.files.join(', ')}]</span>}</li>
                ))}
              </ol>
              {item.plan.tests.length > 0 && <><p><strong>Tests</strong></p><ul className="list-disc pl-5">{item.plan.tests.map(entry => <li key={entry}>{entry}</li>)}</ul></>}
              {item.plan.risks.length > 0 && <><p><strong>Risks</strong></p><ul className="list-disc pl-5">{item.plan.risks.map(entry => <li key={entry}>{entry}</li>)}</ul></>}
            </div>
          </Section>
        )}
        {item.humanNotes.length > 0 && (
          <Section title="Notes from people">
            {item.humanNotes.map((note, index) => <div key={index} className="typography-meta"><Badge>{note.kind}</Badge> {note.by}: {note.note}</div>)}
          </Section>
        )}
        {item.implementations.map((implementation, index) => (
          <Section key={index} title={`Implementation ${index + 1}`}>
            <p className="typography-markdown">{implementation.report.summary}</p>
            <pre className="typography-code bg-muted rounded-md p-2 overflow-x-auto">{implementation.diffStat || '(no changes)'}</pre>
            {implementation.verification.map((result, position) => (
              <details key={position} className="rounded-md border border-border">
                <summary className="px-2 py-1 typography-meta flex items-center gap-2">
                  <Badge tone={result.exitCode === 0 ? 'success' : 'error'}>exit {result.exitCode}</Badge>
                  <span className="font-mono truncate">{result.command}</span>
                </summary>
                <pre className="typography-code bg-muted p-2 overflow-x-auto max-h-80">{result.output || '(no output)'}</pre>
              </details>
            ))}
          </Section>
        ))}
        {item.verdicts.map((verdict, index) => (
          <Section key={index} title={`Review ${index + 1}`}>
            <div className="typography-markdown"><Badge tone={verdict.decision === 'approve' ? 'success' : 'warning'}>{verdict.decision}</Badge> {verdict.summary}</div>
            {verdict.findings.length > 0 && <ul className="list-disc pl-5 typography-meta">{verdict.findings.map((finding, position) => <li key={position}>{finding.severity ? `[${finding.severity}] ` : ''}{finding.file ? `${finding.file}: ` : ''}{finding.description}</li>)}</ul>}
          </Section>
        ))}
        <Section title="Hires">
          {!item.hires.length && <Empty>None yet.</Empty>}
          <table className="typography-meta w-full">
            <tbody>
              {item.hires.map((hire, index) => (
                <tr key={index} className="border-t border-border">
                  <td className="py-1 pr-2">{hire.stage}</td>
                  <td className="py-1 pr-2 font-mono">{hire.model}</td>
                  <td className="py-1 pr-2"><Badge tone={hire.outcome === 'delivered' ? 'success' : 'error'}>{hire.outcome}</Badge></td>
                  <td className="py-1 pr-2">${hire.cost.toFixed(3)}</td>
                  <td className="py-1 text-status-error truncate max-w-64" title={hire.error}>{hire.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
    <ItemActivity item={item} />
    </div>
  );
}

/** The decision this item waits on, if any, in the inbox's terms so the same card can take it. */
function waitingOn(item: WorkItem): InboxEntry | undefined {
  const base = { id: item.id, owner: item.owner, title: item.proposal.title, at: item.updatedAt };
  if (item.status === 'awaiting-plan-approval') return { ...base, kind: 'plan', detail: '' };
  if (item.status === 'awaiting-push-approval') return { ...base, kind: 'push', detail: item.rebaseOf?.prUrl ?? '' };
  if (item.status === 'landed' && !item.publication && !item.rebaseOf) return { ...base, kind: 'publish', detail: `Landed on ${item.branch}; publishing opens a draft PR.` };
  return undefined;
}
