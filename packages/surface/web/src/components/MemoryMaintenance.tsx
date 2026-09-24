import { useCallback, useEffect, useState } from 'react';
import type { MemoryStatus } from '@onionsoup/owners';
import { api, useEvents } from '../api.ts';
import { Button, timeAgo } from './ui.tsx';

export function MemoryMaintenance({ ownerId }: { ownerId: string }) {
  const [status, setStatus] = useState<MemoryStatus>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setStatus(await api<MemoryStatus>(`/api/owners/${ownerId}/memory`));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);
  useEvents(event => {
    if (event.type === 'onionsoup' || event.type === 'reconnected') void load();
  }, [load]);
  const queue = async () => {
    try {
      setStatus(await api<MemoryStatus>(`/api/owners/${ownerId}/memory`, { method: 'POST', body: {} }));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <div className="border-b border-border px-4 py-2 typography-meta flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button disabled={!status || status.status === 'running' || (status.queued && status.status !== 'failed')}
          onClick={() => void queue()}>
          {status?.status === 'failed' ? 'Retry notebook update'
            : status?.status === 'running' ? 'Updating notebook…' : status?.queued ? 'Notebook update queued' : 'Update notebook'}
        </Button>
        <span className="text-muted-foreground">
          {status?.lastCompleted ? `Updated ${timeAgo(status.lastCompleted)}` : 'Fold recorded decisions into memory'}
          {status && !status.automatic ? ' · automatic updates off' : ''}
        </span>
      </div>
      {(error || status?.error) && <div className="text-status-error">{error || status?.error}</div>}
    </div>
  );
}
