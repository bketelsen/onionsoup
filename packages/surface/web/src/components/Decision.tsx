import { useState } from 'react';
import { RiChat3Line, RiExternalLinkLine } from '@remixicon/react';
import { api, navigate } from '../api.ts';
import type { InboxEntry, OwnerSummary } from '../types.ts';
import { Badge, Button, cx, OwnerIcon, timeAgo } from './ui.tsx';

const KIND_LABELS: Record<InboxEntry['kind'], string> = {
  plan: 'Plan to approve', push: 'Force-push to approve', publish: 'Ready to publish', create: 'Create request', delete: 'Delete request',
  attention: 'Attention', 'request-recovery': 'Request interrupted',
  permission: 'Permission', question: 'Question',
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
  const answer = (answers: string[][]) => act(() => api(`/api/owners/${entry.owner}/questions/${entry.id}`, { method: 'POST', body: { answers } }));
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
      {entry.kind === 'question' && entry.question && entry.question.questions.map(question => (
        <div key={question.question} className="flex flex-wrap gap-1.5">
          {question.options.map(option => (
            <Button key={option.label} disabled={busy} title={option.description} onClick={() => void answer([[option.label]])}>{option.label}</Button>
          ))}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.kind === 'attention' && <>
          {entry.attentionStatus !== 'acknowledged' && <Button disabled={busy || !text.trim()} onClick={() => void decide('acknowledge-attention', { reason: text })}>Acknowledge</Button>}
          <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void decide('resolve-attention', { reason: text })}>Resolve</Button>
        </>}
        {entry.kind === 'request-recovery' && <>
          <Button disabled={busy} onClick={() => void decide('reconcile-request')}>Check outcome</Button>
          <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void decide('retry-request', { reason: text })}>Retry after inspection</Button>
          <Button variant="destructive" disabled={busy || !text.trim()} onClick={() => void decide('cancel-request', { reason: text })}>Stop request</Button>
        </>}
        {entry.kind === 'plan' && <>
          <Button variant="primary" disabled={busy} onClick={() => void decide('approve-plan', { note: text || undefined })}>Approve plan</Button>
          <Button disabled={busy || !text.trim()} title="Send the plan back with your note" onClick={() => void decide('revise-plan', { note: text })}>Send back</Button>
          <Button variant="destructive" disabled={busy || !text.trim()} title="Reject with your note as the reason" onClick={() => void decide('reject-plan', { reason: text })}>Reject</Button>
          {!onItemPage() && <Button variant="ghost" onClick={() => navigate('item', entry.id)}><RiExternalLinkLine className="size-3.5" />Full plan</Button>}
        </>}
        {entry.kind === 'push' && <Button variant="primary" disabled={busy} onClick={() => void decide('approve-push')}>Approve force-push</Button>}
        {entry.kind === 'publish' && <>
          <Button variant="primary" disabled={busy} onClick={() => void decide('publish')}>Publish draft PR</Button>
          {!onItemPage() && <Button variant="ghost" onClick={() => navigate('item', entry.id)}><RiExternalLinkLine className="size-3.5" />Details</Button>}
        </>}
        {entry.kind === 'create' && <>
          <label className="inline-flex items-center gap-1 typography-meta text-muted-foreground">
            <input type="checkbox" checked={withDelete} onChange={event => setWithDelete(event.target.checked)} /> also delete when done
          </label>
          <Button variant="primary" disabled={busy} onClick={() => void decide('approve-create', { withDelete })}>Approve create</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void decide('deny-request', { reason: text || undefined })}>Deny</Button>
        </>}
        {entry.kind === 'delete' && <>
          <Button variant="primary" disabled={busy} onClick={() => void decide('approve-delete')}>Approve delete</Button>
          <Button disabled={busy} onClick={() => void decide('deny-request', { reason: text || 'keep it' })}>Keep it</Button>
        </>}
        {entry.kind === 'permission' && <>
          <Button variant="primary" disabled={busy} onClick={() => void permission('once')}>Allow once</Button>
          <Button disabled={busy} onClick={() => void permission('always')}>Always</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void permission('reject')}>Reject</Button>
        </>}
        {entry.sessionID && <Button variant="ghost" onClick={openChat}><RiChat3Line className="size-3.5" />Open chat</Button>}
      </div>
      {(['plan', 'create', 'attention', 'request-recovery'].includes(entry.kind)) && (
        <input value={text} onChange={event => setText(event.target.value)} placeholder={entry.kind === 'plan' ? 'Note (sent with approval, required to send back or reject)' : 'Reason or observed outcome'}
          className="rounded-md border border-border bg-background px-2 py-1 typography-meta outline-none focus:border-interactive-border-focus" />
      )}
      {error && <div className="typography-meta text-status-error">{error}</div>}
    </div>
  );
}

function onItemPage() {
  return location.hash.startsWith('#/item/');
}
