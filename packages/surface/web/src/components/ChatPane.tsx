import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InboxEntry, Message, OwnerSummary } from '../types.ts';
import { PendingCard } from '../chat/cards.tsx';
import { Composer } from '../chat/Composer.tsx';
import { AssistantText, BusyDots, MessageError, ReasoningPart, SessionErrorNotice, ToolPart, TurnFooter, UserBubble } from '../chat/parts.tsx';
import { useChat } from '../chat/useChat.ts';
import { Empty } from './ui.tsx';

interface Turn { user?: Message; assistant: Message[] }

/** Long chats open on their latest turns; earlier ones load on request, keeping the page light. */
const TURN_PAGE = 30;

/** A user message and the assistant messages that answer it. */
function turnsOf(messages: Message[]) {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.info.role === 'user') turns.push({ user: message, assistant: [] });
    else if (turns.length) turns.at(-1)!.assistant.push(message);
    else turns.push({ assistant: [message] });
  }
  return turns;
}

export function AssistantMessage({ message, directory, streaming }: { message: Message; directory: string; streaming: boolean }) {
  const parts = message.parts.filter(part => part.type === 'text' || part.type === 'reasoning' || part.type === 'tool');
  const lastTool = parts.map(part => part.type).lastIndexOf('tool');
  return (
    <div className="relative w-full group/message">
      <div className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0">
        {parts.map((part, index) => {
          const divider = part.type === 'text' && lastTool >= 0 && index > lastTool && index === lastTool + 1 && Boolean(part.text?.trim());
          return (
            <div key={part.id}>
              {divider && <div aria-hidden className="mt-1.5 mb-3 h-px w-full bg-muted-foreground/20" />}
              {part.type === 'text' && !part.synthetic && <AssistantText part={part} />}
              {part.type === 'reasoning' && <ReasoningPart part={part} streaming={streaming && !part.time?.end} />}
              {part.type === 'tool' && <ToolPart part={part} directory={directory} />}
            </div>
          );
        })}
        {message.info.error && <MessageError error={message.info.error} />}
      </div>
    </div>
  );
}

/** One chat with an owner, drawn like OpenChamber's: bubbles for the person, a timeline of parts for the owner. */
export function ChatPane({ owner, sessionId, directory, pending, onPendingDone, autoAccept, onToggleAutoAccept }: {
  owner: OwnerSummary; sessionId: string; directory: string; pending: InboxEntry[]; onPendingDone: () => void; autoAccept: boolean; onToggleAutoAccept: () => void;
}) {
  const chat = useChat(owner.id, sessionId, directory);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const turns = useMemo(() => turnsOf(chat.messages), [chat.messages]);
  const [shownTurns, setShownTurns] = useState(TURN_PAGE);
  const hidden = Math.max(0, turns.length - shownTurns);

  const onScroll = () => {
    const element = scroller.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [chat.messages, pending.length, chat.busy]);
  useEffect(() => { pinned.current = true; }, [sessionId]);

  const lastModel = [...chat.messages].reverse().find(message => message.info.role === 'assistant')?.info.modelID ?? owner.name;
  return (
    <div className="flex h-full min-h-0 bg-background">
      <div className="relative flex min-w-0 flex-1 flex-col h-full bg-background">
        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll" data-scroll-shadow="true" data-orientation="vertical">
            {!chat.loaded && <div className="chat-message-column pt-6"><Empty>Loading…</Empty></div>}
            {chat.loaded && !chat.messages.length && <div className="chat-message-column pt-6"><Empty>Say something to {owner.name}.</Empty></div>}
            {hidden > 0 && (
              <div className="chat-message-column pt-4 flex justify-center">
                <button className="typography-meta text-muted-foreground hover:text-foreground rounded-md px-2 py-1 hover:bg-interactive-hover"
                  onClick={() => { pinned.current = false; setShownTurns(count => count + TURN_PAGE); }}>
                  Show {Math.min(hidden, TURN_PAGE)} earlier turns ({hidden} hidden)
                </button>
              </div>
            )}
            {turns.slice(hidden).map((turn, offset) => {
              const index = offset + hidden;
              const live = index === turns.length - 1 && chat.busy;
              const done = !live && turn.assistant.length > 0;
              return (
                <section key={turn.user?.info.id ?? turn.assistant[0]?.info.id} className="relative w-full">
                  {turn.user && <UserBubble message={turn.user} />}
                  <div className="relative z-0">
                    {turn.assistant.map((message, position) => (
                      <div key={message.info.id} className={position === turn.assistant.length - 1 ? 'group w-full pt-0 pb-2' : 'group w-full pt-0 pb-0'}>
                        <div className="chat-message-column relative">
                          <AssistantMessage message={message} directory={directory} streaming={live && position === turn.assistant.length - 1} />
                          {done && position === turn.assistant.length - 1 && <TurnFooter messages={turn.assistant} />}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
            {pending.map(entry => <PendingCard key={entry.id} entry={entry} onDone={onPendingDone} />)}
            {chat.error && <SessionErrorNotice error={chat.error} />}
            <div style={{ height: '10vh' }} />
          </div>
        </div>
        <div className="relative">
          {chat.busy && (
            <div className="chat-input-column absolute bottom-full inset-x-0 mb-2 pointer-events-none">
              <div className="oc-glass-popover inline-flex w-max max-w-full items-center gap-2 h-8 whitespace-nowrap rounded-full px-3">
                <span className="text-sm text-muted-foreground">{pending.length ? `${owner.name} is waiting for you` : `${lastModel} is working`}<BusyDots /></span>
              </div>
            </div>
          )}
          <Composer agent={owner.name} busy={chat.busy} onSend={chat.send} onStop={() => void chat.abort()} autoAccept={autoAccept} onToggleAutoAccept={onToggleAutoAccept} />
        </div>
      </div>
    </div>
  );
}
