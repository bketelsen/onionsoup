import { useEffect, useState } from 'react';
import { api, useEvents } from '../api.ts';
import type { ChildRecoveryNotice } from '../types.ts';
import { Button } from './ui.tsx';

function messageText(value: unknown) {
  if (!value || typeof value !== 'object' || !('parts' in value) || !Array.isArray(value.parts)) return '';
  return value.parts.flatMap((part: unknown) => part && typeof part === 'object' && 'type' in part
    && part.type === 'text' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('\n');
}

/** Preserved evidence is inert text, never a new prompt, retry or source of approval. */
export function PreservedChildTranscript({ messages }: { messages: unknown[] }) {
  const texts = messages.map(messageText).filter(Boolean);
  return <div className="space-y-2">
    <p>Read-only text history. Tool records and other non-text parts are not displayed here.</p>
    {texts.length ? texts.map((text, index) => <pre key={index} className="whitespace-pre-wrap break-words font-sans">{text}</pre>)
      : <p>No text messages are present in the preserved transcript.</p>}
  </div>;
}

export function ChildRecoveryEvidence({ notice }: { notice: ChildRecoveryNotice }) {
  return <div className="space-y-1">
    <p>Abandoned child: <code>{notice.childID}</code></p>
    <p>{notice.reason}</p>
    <p>Approved by {notice.approvedBy} · {notice.approvedAt}</p>
    <p>This preserves prior history. It does not resume the child or establish that its work completed.</p>
  </div>;
}

function ChildRecoveryEntry({ notice, endpoint }: { notice: ChildRecoveryNotice; endpoint: string }) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<unknown[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setMessages(undefined);
    setError('');
    void api<unknown[]>(`${endpoint}/${encodeURIComponent(notice.childID)}/messages`).then(value => {
      if (!current) return;
      if (!Array.isArray(value)) { setError('Invalid transcript response'); return; }
      setMessages(value);
    }, failure => { if (current) setError(String(failure.message ?? failure)); });
    return () => { current = false; };
  }, [expanded, endpoint, notice.childID, notice.digest]);
  return <div className="space-y-2 border border-border rounded p-3">
    <ChildRecoveryEvidence notice={notice} />
    <Button onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide preserved transcript' : 'View preserved transcript'}</Button>
    {expanded && error && <p role="alert">Preserved transcript unavailable: {error}</p>}
    {expanded && !error && (messages ? <PreservedChildTranscript messages={messages} /> : <p>Loading preserved transcript…</p>)}
  </div>;
}

export function ChildRecoveryHistory({ ownerID, parentID }: { ownerID: string; parentID: string }) {
  const [notices, setNotices] = useState<ChildRecoveryNotice[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const endpoint = `/api/owners/${encodeURIComponent(ownerID)}/sessions/${encodeURIComponent(parentID)}/abandoned-children`;
  useEvents(event => { if (event.type === 'onionsoup') setRevision(value => value + 1); }, []);
  useEffect(() => {
    let current = true;
    setNotices([]);
    setError('');
    void api<ChildRecoveryNotice[]>(endpoint).then(value => {
      if (!current) return;
      if (!Array.isArray(value)) { setError('Invalid recovery history response'); return; }
      setNotices(value);
    }, failure => { if (current) setError(String(failure.message ?? failure)); });
    return () => { current = false; };
  }, [endpoint, revision]);
  if (error) return <p role="alert" className="chat-message-column pt-4">Child recovery history unavailable: {error}</p>;
  if (!notices.length) return null;
  return <section aria-label="Approved child recovery history" className="chat-message-column pt-4 space-y-3">
    <h3 className="font-semibold">Approved child recovery</h3>
    {notices.map(notice => <ChildRecoveryEntry key={notice.childID} notice={notice} endpoint={endpoint} />)}
  </section>;
}
