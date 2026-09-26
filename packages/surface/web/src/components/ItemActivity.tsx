import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { BusyDots } from '../chat/parts.tsx';
import type { ItemSession, Message, WorkItem } from '../types.ts';
import { AssistantMessage } from './ChatPane.tsx';
import { Badge, cx, Empty } from './ui.tsx';

const RUNNING = new Set(['planning', 'working', 'implementing', 'reviewing', 'landing']);
export const ACTIVITY_LIMITS = { sessionsMs: 5_000, messagesMs: 2_000 };

/**
 * A work item's sessions as they happen: the owner session carrying out its plan with its subagents, and any hire
 * onionsoup ran for it (a review, a conflict resolution), with the selected one's messages drawn like a chat and
 * refreshed while it runs. It follows the newest session until the person picks one.
 */
export function ItemActivity({ item }: { item: WorkItem }) {
  const [sessions, setSessions] = useState<ItemSession[]>([]);
  const [picked, setPicked] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const running = RUNNING.has(item.status);
  const selected = sessions.find(session => session.id === picked) ?? sessions.at(-1);
  const hires = useMemo(() => new Map(item.hires.map(hire => [hire.sessionID, hire])), [item.hires]);
  // A session is live while the item runs and its hire has not been recorded as finished.
  const live = (session: ItemSession) => running && !hires.has(session.id) && (session.kind === 'owner' || session.id === sessions.at(-1)?.id);

  useEffect(() => {
    let stopped = false;
    const load = () => api<ItemSession[]>(`/api/items/${item.id}/sessions`).then(list => { if (!stopped) setSessions(list); }, () => undefined);
    void load();
    if (!running) return () => { stopped = true; };
    const timer = setInterval(load, ACTIVITY_LIMITS.sessionsMs);
    return () => { stopped = true; clearInterval(timer); };
  }, [item.id, running]);

  const selectedLive = selected ? live(selected) : false;
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    let stopped = false;
    const load = () => api<Message[]>(`/api/items/${item.id}/sessions/${selected.id}/messages`)
      .then(list => { if (!stopped) { setMessages(list); setError(''); } }, failure => { if (!stopped) setError(failure instanceof Error ? failure.message : String(failure)); });
    void load();
    if (!selectedLive) return () => { stopped = true; };
    const timer = setInterval(load, ACTIVITY_LIMITS.messagesMs);
    return () => { stopped = true; clearInterval(timer); };
  }, [item.id, selected?.id, selectedLive]); // eslint-disable-line react-hooks/exhaustive-deps

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  useEffect(() => { pinned.current = true; }, [selected?.id]);

  const brief = messages.find(message => message.info.role === 'user');
  const replies = messages.filter(message => message.info.role === 'assistant');
  return (
    <aside className="h-full flex flex-col min-h-0">
      <div className="shrink-0 border-b border-border px-3 py-2 flex flex-col gap-1.5">
        <div className="typography-ui-label font-semibold text-muted-foreground uppercase tracking-wide text-[0.7rem]">Activity</div>
        {!sessions.length && <Empty>{running ? 'Waiting for the first session…' : 'No sessions recorded for this item.'}</Empty>}
        <div className="flex flex-wrap gap-1">
          {sessions.map(session => {
            const hire = hires.get(session.id);
            const isLive = live(session);
            return (
              <button key={session.id} onClick={() => setPicked(session.id)} title={hire ? `${hire.model} · ${hire.outcome}${hire.error ? `: ${hire.error}` : ''}` : isLive ? 'running now' : ''}
                className={cx('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 pointer-coarse:min-h-11 typography-meta border',
                  session.id === selected?.id ? 'bg-interactive-active text-foreground border-border' : 'text-muted-foreground border-transparent hover:bg-interactive-hover hover:text-foreground')}>
                {session.label}
                {isLive && <span className="size-1.5 rounded-full bg-status-info animate-pulse" />}
                {hire?.outcome === 'failed' && <span className="size-1.5 rounded-full bg-status-error" />}
              </button>
            );
          })}
        </div>
        {selected && (() => {
          const hire = hires.get(selected.id);
          return (
            <div className="flex flex-wrap items-center gap-x-2 typography-micro text-muted-foreground">
              {hire ? <><span className="font-mono">{hire.model}</span><Badge tone={hire.outcome === 'delivered' ? 'success' : 'error'}>{hire.outcome}</Badge>{hire.cost > 0 && <span>${hire.cost.toFixed(3)}</span>}</>
                : selectedLive ? <span className="inline-flex items-center text-status-info">working<BusyDots /></span> : <span>{selected.kind === 'owner' ? 'owner session' : 'not recorded as a hire'}</span>}
              <span className="ml-auto">{replies.reduce((count, message) => count + message.parts.filter(part => part.type === 'tool').length, 0)} tool calls</span>
            </div>
          );
        })()}
      </div>
      <div ref={scroller} onScroll={() => { const element = scroller.current; if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2 chat-scroll">
        {error && <div className="typography-meta text-[var(--status-error)]">{error}</div>}
        {brief && (
          <details className="mb-2 rounded-lg border border-border/60 bg-muted/10">
            <summary className="cursor-pointer px-2 py-1 pointer-coarse:py-3 typography-meta text-muted-foreground">The first message it was given</summary>
            <div className="px-3 pb-2 max-h-80 overflow-y-auto">
              <Markdown text={brief.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n\n')} variant="tool" />
            </div>
          </details>
        )}
        {replies.map(message => (
          <div key={message.info.id} className="pb-1">
            <AssistantMessage message={message} directory={selected?.directory ?? ''} streaming={selectedLive && message === replies.at(-1)} />
          </div>
        ))}
        {selectedLive && <div className="py-1 typography-meta text-muted-foreground">working<BusyDots /></div>}
      </div>
    </aside>
  );
}
