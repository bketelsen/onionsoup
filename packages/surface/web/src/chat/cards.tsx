import { useState } from 'react';
import { RiCheckLine, RiCloseLine, RiQuestionLine, RiTimeLine } from '@remixicon/react';
import { api } from '../api.ts';
import type { InboxEntry } from '../types.ts';
import { ToolIcon } from './tools.tsx';

// Permission and question cards as OpenChamber draws them (PermissionCard.tsx, QuestionCard.tsx; MIT, see
// ../../NOTICE), shown after the messages of the chat they belong to.

function Spinner() {
  return <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />;
}

const ACTION = 'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed';

export function PermissionCard({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState('');
  const permission = entry.permission!;
  const reply = async (answer: 'once' | 'always' | 'reject') => {
    setResponding(true);
    try {
      await api(`/api/owners/${entry.owner}/permissions/${entry.id}`, { method: 'POST', body: { reply: answer } });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setResponding(false);
    }
  };
  const metadata = permission.metadata ?? {};
  const command = typeof metadata.command === 'string' ? metadata.command : undefined;
  const action = command ?? (Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : '');
  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-2 py-1.5 border-b border-border/20 bg-muted/5">
            <div className="flex items-center justify-between">
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
            <button className={ACTION} style={{ color: 'var(--status-success)' }} disabled={responding} onClick={() => void reply('once')}>
              <RiCheckLine className="h-3 w-3 flex-shrink-0" />Allow Once
            </button>
            <button className={ACTION} style={{ color: 'var(--muted-foreground)' }} disabled={responding} onClick={() => void reply('always')}>
              <RiTimeLine className="h-3 w-3 flex-shrink-0" />{permission.always.length ? <span className="truncate max-w-[180px]">Always: {permission.always.join(', ')}</span> : 'Always Allow'}
            </button>
            <button className={ACTION} style={{ color: 'var(--status-error)' }} disabled={responding} onClick={() => void reply('reject')}>
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

export { QuestionCard } from './QuestionCard.tsx';
