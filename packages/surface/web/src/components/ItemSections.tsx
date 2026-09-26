import type { ReactNode } from 'react';
import { RiChat3Line } from '@remixicon/react';
import { navigate } from '../api.ts';
import { Markdown } from '../chat/Markdown.tsx';
import type { WorkItem } from '../types.ts';
import { ReviewFindings } from './ReviewFindings.tsx';
import { Badge, Button, Section, timeAgo } from './ui.tsx';

/** One part of a work item's page. Every section takes the whole item and shows nothing when it does not apply. */
type ItemSection = (props: { item: WorkItem }) => ReactNode;

const PUBLICATION_STAGES: Record<string, string> = {
  commit: 'committing', push: 'pushing', open: 'opening the PR', merge: 'merging under grant', finish: 'finishing', complete: 'published',
};

function WorkSession({ item }: { item: WorkItem }) {
  if (!item.session) return null;
  const open = () => navigate('owner', item.owner, 'chat', item.session!.sessionID);
  return (
    <div className="flex flex-wrap items-center gap-x-2 typography-meta text-muted-foreground">
      <Button variant="ghost" onClick={open}><RiChat3Line className="size-3.5" />Open the work session</Button>
      <span>The owner carries out the plan there; its subagents are in the activity rail.</span>
    </div>
  );
}

function Proposal({ item }: { item: WorkItem }) {
  return (
    <Section title="Proposal">
      <div className="typography-markdown flex flex-col gap-1">
        <p><strong>Goal.</strong> {item.proposal.goal}</p>
        <p><strong>Why.</strong> {item.proposal.rationale}</p>
        <ul className="list-disc pl-5">{item.proposal.acceptance.map(entry => <li key={entry}>{entry}</li>)}</ul>
      </div>
    </Section>
  );
}

function Plan({ item }: { item: WorkItem }) {
  if (!item.planDocument) return null;
  const approval = item.planApproval ? ` (approved by ${item.planApproval.by} ${timeAgo(item.planApproval.at)})` : '';
  return (
    <Section title={`Plan${approval}`}>
      <Markdown text={item.planDocument.markdown} />
    </Section>
  );
}

function Notes({ item }: { item: WorkItem }) {
  if (!item.humanNotes.length) return null;
  return (
    <Section title="Notes from people">
      {item.humanNotes.map((note, index) => <div key={index} className="typography-meta"><Badge>{note.kind}</Badge> {note.by}: {note.note}</div>)}
    </Section>
  );
}

function Publication({ item }: { item: WorkItem }) {
  const publication = item.deskPublication;
  if (!publication) return null;
  return (
    <Section title="Publication">
      <div className="typography-meta flex flex-wrap items-center gap-2">
        <Badge tone={publication.stage === 'complete' ? 'success' : 'info'}>{PUBLICATION_STAGES[publication.stage] ?? publication.stage}</Badge>
        <span>reviewed by <span className="font-mono">{publication.reviewer}</span></span>
        {item.landedCommit && <span className="font-mono">{item.landedCommit.slice(0, 12)}</span>}
        {item.repairOf && <span>repairs {item.repairOf.prUrl}</span>}
      </div>
    </Section>
  );
}

function Verification({ item }: { item: WorkItem }) {
  const latest = item.implementations.at(-1);
  if (!latest?.verification.length) return null;
  return (
    <Section title="Host verification">
      {latest.verification.map((result, position) => (
        <details key={position} className="rounded-md border border-border">
          <summary className="px-2 py-1 pointer-coarse:min-h-11 typography-meta flex items-center gap-2 min-w-0">
            <Badge tone={result.exitCode === 0 ? 'success' : 'error'}>exit {result.exitCode}</Badge>
            <span className="font-mono truncate">{result.command}</span>
          </summary>
          <pre className="typography-code bg-muted p-2 overflow-x-auto max-h-80">{result.output || '(no output)'}</pre>
        </details>
      ))}
    </Section>
  );
}

function Reviews({ item }: { item: WorkItem }) {
  return <>{item.verdicts.map((verdict, index) => (
    <Section key={index} title={`Review ${index + 1}`}>
      <div className="typography-markdown"><Badge tone={verdict.decision === 'approve' ? 'success' : 'warning'}>{verdict.decision}</Badge> {verdict.summary}</div>
      <ReviewFindings verdict={verdict} />
    </Section>
  ))}</>;
}

function Hires({ item }: { item: WorkItem }) {
  if (!item.hires.length) return null;
  return (
    <Section title="Hires">
      <div className="overflow-x-auto overscroll-x-contain">
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
      </div>
    </Section>
  );
}

/** A work item's page, in order: where the work runs, what was asked, the plan, then how it was published. */
export const ITEM_SECTIONS: ItemSection[] = [WorkSession, Proposal, Plan, Notes, Publication, Verification, Reviews, Hires];
