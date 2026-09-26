import { useState } from 'react';
import { api, navigate } from '../api.ts';
import type { ReminderSummary } from '../types.ts';
import { Button } from './ui.tsx';

/** One reminder an owner set for itself: when it is due, what it will check, and a cancel with an optional note. */
export function ReminderCard({ reminder, onDone }: { reminder: ReminderSummary; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/decide', { method: 'POST', body: { action: 'cancel-reminder', id: reminder.id, reason: note } });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return <div className="rounded-md border border-border p-2 flex flex-col gap-1.5">
    <span className="typography-micro text-muted-foreground">
      Due {new Date(reminder.dueAt).toLocaleString()}
      {reminder.item && <> · <button className="text-primary hover:underline" onClick={() => navigate('item', reminder.item!)}>{reminder.item}</button></>}
    </span>
    <span className="typography-meta text-foreground line-clamp-4 [overflow-wrap:anywhere]">{reminder.prompt}</span>
    <div className="flex items-center gap-2">
      <input value={note} onChange={event => setNote(event.target.value)} placeholder="Note (optional)"
        className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1 pointer-coarse:min-h-11 typography-meta" />
      <Button variant="destructive" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
    </div>
    {error && <div className="typography-meta text-status-error">{error}</div>}
  </div>;
}
