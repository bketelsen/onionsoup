import { useState } from 'react';
import { RiChat3Line } from '@remixicon/react';
import { QuestionCard } from '../chat/QuestionCard.tsx';
import { DecisionActions } from './DecisionActions.tsx';
import { api, navigate } from '../api.ts';
import type { InboxEntry, OwnerSummary } from '../types.ts';
import { Badge, Button, cx, OwnerIcon, timeAgo } from './ui.tsx';

const KIND_LABELS: Record<InboxEntry['kind'], string> = {
  plan: 'Plan to approve', push: 'Force-push to approve', publish: 'Ready to publish', create: 'Create request', delete: 'Delete request',
  attention: 'Attention', 'request-recovery': 'Request interrupted',
  permission: 'Permission', question: 'Question',
};

const NOTE_PLACEHOLDERS: Partial<Record<InboxEntry['kind'], string>> = {
  plan: 'Note (sent with approval, required to send back or reject)',
  create: 'Reason (for deny)',
  push: 'Reason (required to decline force-push)',
  attention: 'Reason or observed outcome',
  'request-recovery': 'Reason or observed outcome',
};

/** One thing waiting on the person, with the decision next to its context. */
export function Decision({ entry, owner, onDone, compact }: { entry: InboxEntry; owner?: OwnerSummary; onDone: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [withDelete, setWithDelete] = useState(true);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const decide = (action: string, extra: Record<string, unknown> = {}) => act(() => api('/api/decide', { method: 'POST', body: { action, id: entry.id, ...extra } }));
  const permission = (reply: 'once' | 'always' | 'reject') => act(() => api(`/api/owners/${entry.owner}/permissions/${entry.id}`, { method: 'POST', body: { reply } }));

  const openChat = () => entry.sessionID && navigate('owner', entry.owner, 'chat', entry.sessionID);

  return (
    <div className={cx('rounded-lg border border-border bg-card flex flex-col gap-2', compact ? 'p-2.5' : 'p-3.5')}>
      <div className="flex items-center gap-2 typography-meta text-muted-foreground">
        {!compact && owner && (
          <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => navigate('owner', owner.id)}>
            <OwnerIcon icon={owner.icon} className="size-3.5" />{owner.name}
          </button>
        )}
        <Badge tone={entry.kind === 'permission' || entry.kind === 'question' ? 'info' : 'warning'}>{KIND_LABELS[entry.kind]}</Badge>
        {entry.at && <span>{timeAgo(entry.at)}</span>}
        <span className="ml-auto font-mono text-[0.7rem]">{entry.id}</span>
      </div>
      <div className="typography-ui-label font-medium text-foreground">{entry.title}</div>
      {entry.detail && <div className="typography-meta text-muted-foreground whitespace-pre-wrap line-clamp-6">{entry.detail}</div>}
      {entry.kind === 'permission' && entry.permission && Object.keys(entry.permission.metadata ?? {}).length > 0 && (
        <pre className="typography-code bg-muted rounded-md p-2 overflow-x-auto max-h-40">{JSON.stringify(entry.permission.metadata, null, 2)}</pre>
      )}
      {entry.kind === 'question' && entry.question && <QuestionCard key={entry.id} entry={entry} onDone={onDone} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <DecisionActions entry={entry} busy={busy} text={text} withDelete={withDelete}
          setWithDelete={setWithDelete} decide={decide} permission={permission} />
        {entry.sessionID && <Button variant="ghost" onClick={openChat}><RiChat3Line className="size-3.5" />Open chat</Button>}
      </div>
      {NOTE_PLACEHOLDERS[entry.kind] && (
        <input value={text} onChange={event => setText(event.target.value)} disabled={busy} aria-label={NOTE_PLACEHOLDERS[entry.kind]} placeholder={NOTE_PLACEHOLDERS[entry.kind]}
          className="rounded-md border border-border bg-background px-2 py-1 typography-meta outline-none focus:border-interactive-border-focus" />
      )}
      {error && <div className="typography-meta text-status-error">{error}</div>}
    </div>
  );
}
