import { useState } from 'react';
import { RiArrowGoBackLine, RiCheckLine, RiCloseLine, RiFileList3Line, RiQuestionLine, RiTimeLine } from '@remixicon/react';
import { api } from '../api.ts';
import type { InboxEntry } from '../types.ts';
import { Markdown } from './Markdown.tsx';
import { CARD_ACTION } from './cardStyles.ts';
import { QuestionCard } from './QuestionCard.tsx';
import { ToolIcon } from './tools.tsx';

// Permission and question cards as OpenChamber draws them (PermissionCard.tsx, QuestionCard.tsx; MIT, see
// ../../NOTICE), shown after the messages of the chat they belong to.

function Spinner() {
  return <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />;
}


export function PermissionCard({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const { responding, error, reply } = usePermissionReply(entry, onDone);
  const permission = entry.permission!;
  const metadata = permission.metadata ?? {};
  const command = typeof metadata.command === 'string' ? metadata.command : undefined;
  const action = command ?? (Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : '');
  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-2 py-1.5 border-b border-border/20 bg-muted/5">
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <div className="flex items-center gap-2">
                <RiQuestionLine className="h-3.5 w-3.5 text-[var(--status-warning)]" />
                <span className="typography-meta font-medium text-muted-foreground">Permission Required</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <ToolIcon tool={permission.permission} /><span className="typography-meta font-medium">{permission.permission}</span>
              </div>
            </div>
          </div>
          <div className="px-2 py-2">
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">Patterns</div>
              <code className="typography-meta px-2 py-1 bg-muted/30 rounded block break-all">{permission.patterns.join(', ')}</code>
            </div>
            {action && (
              <div>
                <div className="typography-meta text-muted-foreground mb-1">{command ? 'Command' : 'Action'}</div>
                <pre className="typography-meta font-mono px-2 py-1 bg-muted/30 rounded whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{action}</pre>
              </div>
            )}
          </div>
          <div className="px-2 pb-1.5 pt-1 flex flex-wrap items-center gap-1.5 border-t border-border/20">
            <button className={CARD_ACTION} style={{ color: 'var(--status-success)' }} disabled={responding} onClick={() => void reply('once')}>
              <RiCheckLine className="h-3 w-3 flex-shrink-0" />Allow Once
            </button>
            <button className={CARD_ACTION} style={{ color: 'var(--muted-foreground)' }} disabled={responding} onClick={() => void reply('always')}>
              <RiTimeLine className="h-3 w-3 flex-shrink-0" />{permission.always.length ? <span className="truncate max-w-[180px]">Always: {permission.always.join(', ')}</span> : 'Always Allow'}
            </button>
            <button className={CARD_ACTION} style={{ color: 'var(--status-error)' }} disabled={responding} onClick={() => void reply('reject')}>
              <RiCloseLine className="h-3 w-3 flex-shrink-0" />Deny
            </button>
            {responding && <div className="ml-auto"><Spinner /></div>}
            {error && <span className="typography-meta text-[var(--status-error)]">{error}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}


/** Answer a pending permission; a note travels with a rejection so the owner hears why. */
function usePermissionReply(entry: InboxEntry, onDone: () => void) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState('');
  const reply = async (answer: 'once' | 'always' | 'reject', message?: string) => {
    setResponding(true);
    try {
      await api(`/api/owners/${entry.owner}/permissions/${entry.id}`, { method: 'POST', body: { reply: answer, message } });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setResponding(false);
    }
  };
  return { responding, error, reply };
}

/** Approve the plan, or send it back with a note saying what should change. Each plan is approved on its own. */
export function PlanApprovalActions({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const { responding, error, reply } = usePermissionReply(entry, onDone);
  const [note, setNote] = useState('');
  return (
    <div className="px-3 pb-2 pt-2 flex flex-col gap-2 border-t border-border/20">
      <textarea value={note} onChange={event => setNote(event.target.value)} rows={2}
        placeholder="What should change? (sent with Send back)"
        className="w-full rounded-md border border-border bg-background px-2 py-1 typography-meta" />
      <div className="flex flex-wrap items-center gap-1.5">
        <button className={CARD_ACTION} style={{ color: 'var(--status-success)' }} disabled={responding} onClick={() => void reply('once')}>
          <RiCheckLine className="h-3 w-3 flex-shrink-0" />Approve plan
        </button>
        <button className={CARD_ACTION} style={{ color: 'var(--status-error)' }} disabled={responding || !note.trim()} onClick={() => void reply('reject', note.trim())}>
          <RiArrowGoBackLine className="h-3 w-3 flex-shrink-0" />Send back
        </button>
        {responding && <div className="ml-auto"><Spinner /></div>}
        {error && <span className="typography-meta text-[var(--status-error)]">{error}</span>}
      </div>
    </div>
  );
}

/** An owner's plan waiting for the person's approval: the plan itself, then the approve / send-back actions. */
export function PlanApprovalCard({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const request = entry.planApproval!;
  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-3 py-2 border-b border-border/20 bg-muted/5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex items-center gap-2 min-w-[12rem] flex-1">
              <RiFileList3Line className="h-4 w-4 shrink-0 text-[var(--status-warning)]" />
              <span className="typography-ui-label font-medium text-foreground min-w-0 [overflow-wrap:anywhere]">Approve plan: {request.title}</span>
            </span>
            <span className="ml-auto font-mono text-[0.7rem] text-muted-foreground break-all">{request.item}</span>
          </div>
          <div className="px-3 py-2 max-h-[60vh] overflow-y-auto overscroll-contain"><Markdown text={request.plan} /></div>
          <PlanApprovalActions entry={entry} onDone={onDone} />
        </div>
      </div>
    </div>
  );
}

type PendingCardComponent = (props: { entry: InboxEntry; onDone: () => void }) => React.JSX.Element;
const PENDING_CARDS: Record<'plan' | 'permission' | 'question', PendingCardComponent> = {
  plan: PlanApprovalCard, permission: PermissionCard, question: QuestionCard,
};

export function pendingCardKind(entry: InboxEntry) {
  if (entry.planApproval) return 'plan';
  return entry.kind === 'question' ? 'question' : 'permission';
}

/** The card for something a chat is waiting on: a plan to approve, a permission, or a question. */
export function PendingCard({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const Card = PENDING_CARDS[pendingCardKind(entry)];
  return <Card entry={entry} onDone={onDone} />;
}

export { QuestionCard };
