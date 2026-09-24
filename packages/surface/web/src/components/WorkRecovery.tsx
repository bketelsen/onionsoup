import { useState } from 'react';
import { api } from '../api.ts';
import type { WorkItem } from '../types.ts';
import { Button } from './ui.tsx';

const CANCELLABLE = new Set([
  'proposed', 'planning', 'awaiting-plan-approval', 'implementing', 'reviewing', 'landing',
  'awaiting-push-approval', 'failed', 'interrupted', 'landed',
]);
const RECOVERY: Record<string, { action: string; label: string }> = {
  interrupted: { action: 'resume-item', label: 'Resume work' },
  failed: { action: 'retry-item', label: 'Retry failed stage' },
};

export function WorkRecovery({ item, onDone }: { item: WorkItem; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (item.activeRunner || (item.status === 'landed' && item.publication) || !CANCELLABLE.has(item.status)) return null;
  const recover = RECOVERY[item.status];
  const decide = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/api/decide', { method: 'POST', body: { action, id: item.id, reason } });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
    <div className="flex items-center gap-2">
      {recover && <Button disabled={busy} onClick={() => void decide(recover.action)}>{recover.label}</Button>}
      <Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => void decide('cancel-item')}>Cancel work</Button>
    </div>
    <input value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason for cancellation"
      className="rounded-md border border-border bg-background px-2 py-1 typography-meta" />
    {error && <div className="typography-meta text-status-error">{error}</div>}
  </div>;
}
