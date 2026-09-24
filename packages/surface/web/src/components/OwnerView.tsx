import { useCallback, useEffect, useMemo, useState } from 'react';
import { RiAddLine, RiBookOpenLine, RiCloseLine, RiExternalLinkLine } from '@remixicon/react';
import { api, navigate, opencodePayload, useEvents } from '../api.ts';
import type { DeskState, InboxEntry, OwnerSummary, Session } from '../types.ts';
import { ChatPane } from './ChatPane.tsx';
import { Decision } from './Decision.tsx';
import { MemoryMaintenance } from './MemoryMaintenance.tsx';
import { Badge, BusyDots, Button, cx, Empty, OwnerIcon, Section, statusTone, timeAgo } from './ui.tsx';

/** Sessions onionsoup itself ran in this directory (hires, reviews) are not the person's chats. */
const ENGINE_TITLE = /^([a-z0-9-]+|w-\d{8}-[0-9a-f]+): /;

const NOTE_LABELS: Record<string, string> = {
  'delete-approved': 'Delete approved', 'request-denied': 'Request denied',
  'create-failed': 'Create failed', 'delete-failed': 'Delete failed',
  'attention-decision': 'Attention decision', 'request-recovery': 'Request recovery',
  'request-recovered': 'Request recovered', 'request-completed': 'Request completed',
  'create-approved': 'Create approved', 'request-opened': 'Request opened',
  'chat-decision': 'Noted', 'chat-action': 'Did', 'work-opened': 'Opened work', 'plan-approved': 'Plan approved', 'plan-rejected': 'Plan rejected',
  published: 'Published', 'publish-failed': 'Publish failed', asked: 'Asked', answered: 'Answered', attention: 'Needs you', 'ci-triage': 'CI triage',
  'work-status': 'Work update', 'owner-created': 'Created owner', 'owner-updated': 'Updated owner', 'owner-retired': 'Retired owner', 'ship-started': 'Shipping', shipped: 'Shipped',
};

/** An owner's page: its chat in the middle, and beside it what waits, its threads, its work and what it has been doing. */
export function OwnerView({ owner, inbox, sessionId, refresh }: { owner: OwnerSummary; inbox: InboxEntry[]; sessionId?: string; refresh: () => void }) {
  const [desk, setDesk] = useState<DeskState>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({});
  const [directory, setDirectory] = useState('');
  const [sessionsError, setSessionsError] = useState('');
  const [autoAccept, setAutoAccept] = useState<Record<string, boolean>>({});
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [showEngine, setShowEngine] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [title, setTitle] = useState('');
  const [seen, setSeen] = useState<Record<string, number>>(() => readSeen());

  const loadDesk = useCallback(() => api<DeskState>(`/api/owners/${owner.id}`).then(setDesk, () => undefined), [owner.id]);
  const loadSessions = useCallback(() => {
    if (!owner.chat) return Promise.resolve();
    return api<{ directory: string; sessions: Session[]; status: Record<string, { type: string }>; autoAccept: Record<string, boolean> }>(`/api/owners/${owner.id}/sessions`).then(result => {
      setDirectory(result.directory);
      setAutoAccept(result.autoAccept ?? {});
      setSessions(result.sessions.filter(session => !session.parentID).sort((left, right) => right.time.updated - left.time.updated));
      setBusySessions(Object.fromEntries(Object.entries(result.status).map(([id, status]) => [id, status.type === 'busy' || status.type === 'retry'])));
      setSessionsError('');
    }, failure => setSessionsError(failure instanceof Error ? failure.message : String(failure)));
  }, [owner.id, owner.chat]);

  useEffect(() => { setDesk(undefined); setSessions([]); void loadDesk(); void loadSessions(); }, [loadDesk, loadSessions]);
  useEvents(event => {
    if (event.type === 'onionsoup' || event.type === 'reconnected') { void loadDesk(); void loadSessions(); return; }
    const payload = opencodePayload(event.data);
    if (payload.directory && directory && payload.directory !== directory) return;
    if (payload.type === 'session.created' || payload.type === 'session.updated' || payload.type === 'session.deleted') void loadSessions();
    if (payload.type === 'session.status') {
      const { sessionID, status } = payload.properties as { sessionID: string; status: { type: string } };
      setBusySessions(current => ({ ...current, [sessionID]: status.type === 'busy' || status.type === 'retry' }));
    }
  }, [directory, loadDesk, loadSessions]);

  const chats = useMemo(() => sessions.filter(session => !ENGINE_TITLE.test(session.title)), [sessions]);
  const engine = useMemo(() => sessions.filter(session => ENGINE_TITLE.test(session.title)), [sessions]);
  const current = sessionId ?? chats[0]?.id;
  // A chat is unread when it changed since the person last had it open (kept per browser: a convenience).
  const currentUpdated = sessions.find(session => session.id === current)?.time.updated;
  useEffect(() => {
    if (!current || currentUpdated === undefined) return;
    setSeen(previous => {
      const next = { ...previous, [current]: Math.max(currentUpdated, Date.now()) };
      writeSeen(next);
      return next;
    });
  }, [current, currentUpdated]);

  const rename = async (id: string) => {
    const next = title.trim();
    setRenaming(undefined);
    if (!next) return;
    await api(`/api/owners/${owner.id}/sessions/${id}`, { method: 'PATCH', body: { title: next } }).catch(() => undefined);
    void loadSessions();
  };

  const newChat = async () => {
    const session = await api<Session>(`/api/owners/${owner.id}/sessions`, { method: 'POST', body: {} });
    await loadSessions();
    navigate('owner', owner.id, 'chat', session.id);
  };

  const waiting = inbox.filter(entry => entry.owner === owner.id);
  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <header className="h-12 shrink-0 border-b border-border px-4 flex items-center gap-2 min-w-0">
        <OwnerIcon icon={owner.icon} className="size-5 text-primary" />
        <span className="typography-ui-header font-semibold">{owner.name}</span>
        <span className="typography-meta text-muted-foreground truncate">{[owner.title, owner.source].filter(Boolean).join(' · ')}</span>
        <span className="ml-auto typography-micro text-muted-foreground truncate hidden lg:inline">{owner.domain} · {owner.model}</span>
      </header>
      <div className="flex-1 flex min-h-0">
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {!owner.chat && <div className="p-6"><Empty>{owner.name} has no persona, so there is no one to chat with. Its work and notebook are on the right.</Empty></div>}
          {owner.chat && current && directory && <ChatPane key={current} owner={owner} sessionId={current} directory={directory} pending={waiting.filter(entry => entry.sessionID === current && (entry.kind === 'permission' || entry.kind === 'question'))} onPendingDone={refresh}
            autoAccept={Boolean(autoAccept[current])}
            onToggleAutoAccept={() => {
              const enabled = !autoAccept[current];
              setAutoAccept(previous => ({ ...previous, [current]: enabled }));
              void api(`/api/owners/${owner.id}/sessions/${current}/auto-accept`, { method: 'PUT', body: { enabled } }).then(refresh, () => void loadSessions());
            }} />}
          {owner.chat && !current && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <OwnerIcon icon={owner.icon} className="size-8" />
              <div className="typography-ui-label">No chats with {owner.name} yet.</div>
              <Button variant="primary" onClick={() => void newChat()}><RiAddLine className="size-4" />Start a chat</Button>
            </div>
          )}
        </main>
        <aside className="w-80 shrink-0 border-l border-border overflow-y-auto p-4 flex flex-col gap-5">
          {waiting.length > 0 && (
            <Section title={`Waiting on you (${waiting.length})`}>
              {waiting.map(entry => <Decision key={`${entry.kind}:${entry.id}`} entry={entry} compact onDone={refresh} />)}
            </Section>
          )}
          {owner.chat && (
            <Section title="Chats" action={<Button variant="ghost" onClick={() => void newChat()} title="New chat"><RiAddLine className="size-4" /></Button>}>
              {sessionsError && <div className="typography-meta text-[var(--status-error)] [overflow-wrap:anywhere]">Could not load chats: {sessionsError}</div>}
              {!chats.length && !sessionsError && <Empty>None yet.</Empty>}
              <div className="flex flex-col gap-0.5">
                {chats.map(session => renaming === session.id ? (
                  <input key={session.id} autoFocus value={title} onChange={event => setTitle(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') void rename(session.id); if (event.key === 'Escape') setRenaming(undefined); }}
                    onBlur={() => void rename(session.id)}
                    className="rounded-md border border-interactive-border-focus bg-background px-2 py-1 typography-meta outline-none" />
                ) : (
                  <button key={session.id} onClick={() => navigate('owner', owner.id, 'chat', session.id)} onDoubleClick={() => { setRenaming(session.id); setTitle(session.title); }}
                    title="Double-click to rename"
                    className={cx('flex items-center gap-2 rounded-md px-2 py-1 text-left typography-meta', session.id === current ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
                    {session.id !== current && session.time.updated > (seen[session.id] ?? BASELINE) && <span className="size-1.5 shrink-0 rounded-full bg-primary" title="New since you last looked" />}
                    <span className={cx('truncate flex-1', session.id !== current && session.time.updated > (seen[session.id] ?? BASELINE) && 'text-foreground font-medium')}>{session.title || 'Untitled'}</span>
                    {busySessions[session.id] ? <BusyDots className="text-status-info" /> : <span className="shrink-0 text-[0.7rem]">{timeAgo(session.time.updated)}</span>}
                  </button>
                ))}
              </div>
              {engine.length > 0 && (
                <button className="self-start typography-micro text-muted-foreground hover:text-foreground" onClick={() => setShowEngine(value => !value)}>
                  {showEngine ? 'Hide' : 'Show'} {engine.length} engine sessions (hires, reviews)
                </button>
              )}
              {showEngine && engine.map(session => (
                <button key={session.id} onClick={() => navigate('owner', owner.id, 'chat', session.id)}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-left typography-micro text-muted-foreground hover:bg-interactive-hover">
                  <span className="truncate flex-1">{session.title}</span><span className="shrink-0">{timeAgo(session.time.updated)}</span>
                </button>
              ))}
            </Section>
          )}
          <Section title="Work">
            {desk && !desk.work.length && !desk.recent.length && <Empty>No work yet.</Empty>}
            {desk?.work.map(item => (
              <button key={item.id} onClick={() => navigate('item', item.id)} className="flex flex-col items-start gap-0.5 rounded-md border border-border p-2 text-left hover:bg-interactive-hover">
                <span className="typography-meta text-foreground">{item.title}</span>
                <Badge tone={statusTone(item.status)}>{item.status}</Badge>
              </button>
            ))}
            {desk?.recent.map(item => (
              <button key={item.id} onClick={() => navigate('item', item.id)} className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-interactive-hover">
                <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                <span className="typography-micro text-muted-foreground truncate flex-1">{item.title}</span>
                {item.url && <a href={item.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}><RiExternalLinkLine className="size-3.5 text-muted-foreground" /></a>}
              </button>
            ))}
          </Section>
          <Section title="Activity" action={<Button variant="ghost" onClick={() => setNotebookOpen(true)}><RiBookOpenLine className="size-3.5" />Notebook</Button>}>
            {desk && !desk.notes.length && <Empty>Nothing yet.</Empty>}
            <ol className="flex flex-col gap-2">
              {desk?.notes.slice(0, 25).map((note, index) => (
                <li key={index} className={cx('flex flex-col gap-0.5 border-l-2 pl-2', note.kind === 'attention' ? 'border-status-warning' : 'border-border', note.retracted && 'opacity-50 line-through')}>
                  <span className="typography-micro text-muted-foreground">
                    {NOTE_LABELS[note.kind] ?? note.kind} · {timeAgo(note.at)}
                    {note.workItem && <> · <button className="text-primary hover:underline" onClick={() => navigate('item', note.workItem!)}>{note.workItem}</button></>}
                  </span>
                  <span className="typography-meta text-foreground line-clamp-3 [overflow-wrap:anywhere]">{note.note}</span>
                  {note.quote && <span className="typography-micro text-muted-foreground italic line-clamp-2">“{note.quote}”</span>}
                  {note.outcome && note.kind !== 'chat-decision' && (
                    ['asked', 'answered', 'ci-triage', 'attention', 'shipped', 'ship-started', 'work-status'].includes(note.kind)
                      ? <details className="typography-micro text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{note.kind === 'asked' ? 'The answer' : 'Outcome'}</summary><div className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/80">{note.outcome}</div></details>
                      : <span className="typography-micro text-muted-foreground/80 line-clamp-1">{note.outcome}</span>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        </aside>
      </div>
      {notebookOpen && desk && <Notebook desk={desk} onClose={() => setNotebookOpen(false)} />}
    </div>
  );
}

function Notebook({ desk, onClose }: { desk: DeskState; onClose: () => void }) {
  const registers = Object.entries(desk.registers).filter(([, text]) => text.trim());
  const [tab, setTab] = useState(registers[0]?.[0] ?? '');
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-background border border-border rounded-xl w-full max-w-3xl max-h-full flex flex-col" onClick={event => event.stopPropagation()}>
        <div className="flex items-center gap-1 border-b border-border px-3 h-11">
          <span className="typography-ui-label font-semibold mr-2">{desk.owner.name}'s notebook</span>
          {registers.map(([name]) => (
            <button key={name} onClick={() => setTab(name)} className={cx('px-2 py-1 rounded-md typography-meta', tab === name ? 'bg-interactive-active' : 'text-muted-foreground hover:bg-interactive-hover')}>{name}</button>
          ))}
          <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={onClose}><RiCloseLine className="size-5" /></button>
        </div>
        <MemoryMaintenance ownerId={desk.owner.id} />
        <pre className="overflow-y-auto p-4 typography-meta whitespace-pre-wrap font-sans">{desk.registers[tab] ?? ''}</pre>
      </div>
    </div>
  );
}

const SEEN_KEY = 'onionsoup.seen';
const BASELINE_KEY = 'onionsoup.seen-baseline';

/** Chats that changed before this browser first opened the surface count as read. */
const BASELINE = (() => {
  try {
    const known = Number(localStorage.getItem(BASELINE_KEY));
    if (known) return known;
    localStorage.setItem(BASELINE_KEY, String(Date.now()));
  } catch {
    // Without storage, everything before now is read.
  }
  return Date.now();
})();

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, number>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private windows may refuse storage; unread markers are only a convenience.
  }
}
