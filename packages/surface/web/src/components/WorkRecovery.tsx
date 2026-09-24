import { useState } from 'react';
import { api } from '../api.ts';
import type { WorkItem } from '../types.ts';
import { Button } from './ui.tsx';

const CANCELLABLE = new Set([
  'proposed', 'planning', 'awaiting-plan-approval', 'implementing', 'reviewing', 'landing',
  'awaiting-push-approval', 'failed', 'interrupted', 'landed',
]);

/** A recovery decision: what it sends, and what the text box means for it. */
interface RecoveryAction { action: string; label: string; noteUse: string; isNoteRequired?: boolean }

const RECOVERY: Record<string, RecoveryAction[]> = {
  interrupted: [{ action: 'resume-item', label: 'Resume work', noteUse: 'note for the resume' }],
  failed: [{ action: 'retry-item', label: 'Retry failed stage', noteUse: 'note for the retry' }],
};

/** Decisions only some failures offer, by `<status>:<reason>`. */
const REASON_RECOVERY: Record<string, RecoveryAction[]> = {
  'failed:revision_limit_reached': [{
    action: 'land-over-findings', label: 'Land over findings', noteUse: 'why to land over the findings', isNoteRequired: true,
  }],
};

function recoveryActions(item: WorkItem) {
  return [...RECOVERY[item.status] ?? [], ...REASON_RECOVERY[`${item.status}:${item.reason}`] ?? []];
}

function placeholder(actions: readonly RecoveryAction[]) {
  const uses = [...actions.map(action => action.noteUse), 'reason to cancel'].join(', ');
  return uses.charAt(0).toUpperCase() + uses.slice(1);
}

export function WorkRecovery({ item, onDone }: { item: WorkItem; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (item.activeRunner || (item.status === 'landed' && (item.publication || item.rebaseOf)) || !CANCELLABLE.has(item.status)) return null;
  const actions = recoveryActions(item);
  const hasNote = Boolean(reason.trim());
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
      {actions.map(recovery => <Button key={recovery.action} disabled={busy || (recovery.isNoteRequired && !hasNote)}
        onClick={() => void decide(recovery.action)}>{recovery.label}</Button>)}
      <Button variant="destructive" disabled={busy || !hasNote} onClick={() => void decide('cancel-item')}>Cancel work</Button>
    </div>
    <input value={reason} onChange={event => setReason(event.target.value)} placeholder={placeholder(actions)}
      className="rounded-md border border-border bg-background px-2 py-1 typography-meta" />
    {error && <div className="typography-meta text-status-error">{error}</div>}
  </div>;
}
