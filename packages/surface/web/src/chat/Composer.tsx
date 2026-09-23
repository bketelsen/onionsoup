import { useRef, useState, type KeyboardEvent } from 'react';
import { RiSendPlane2Line, RiShieldCheckLine, RiShieldUserLine } from '@remixicon/react';
import { cx } from '../components/ui.tsx';

// The composer's look from OpenChamber (ChatInput.tsx, ComposerActionButtons.tsx, StopIcon.tsx; MIT, see
// ../../NOTICE), with a textarea instead of CodeMirror. Enter sends, Shift+Enter is a new line.

function StopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" className={className} aria-hidden>
      <path d="M208,56V200a8,8,0,0,1-8,8H56a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8H200A8,8,0,0,1,208,56Z" opacity="0.2" />
      <path d="M200,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,160H56V56H200V200Z" />
    </svg>
  );
}

const ICON_BUTTON = 'flex h-6 w-6 cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';

export function Composer({ agent, busy, onSend, onStop, autoAccept, onToggleAutoAccept }: {
  agent: string; busy: boolean; onSend: (text: string) => Promise<void>; onStop: () => void; autoAccept: boolean; onToggleAutoAccept: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0 && !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(text.trim());
      setText('');
      if (area.current) area.current.style.height = '';
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const grow = () => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  };

  return (
    <form className="relative w-full pt-0 pb-4" onSubmit={event => { event.preventDefault(); void send(); }}>
      <div className="chat-input-column relative overflow-visible">
        <div className="flex flex-col relative overflow-visible border border-border/80 focus-within:border-interactive-selection-foreground/35 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)] oc-glass-composer"
          style={{ borderRadius: 'var(--radius-xl)' }}>
          <textarea ref={area} value={text} rows={1} placeholder={`Message ${agent}…`} onChange={event => { setText(event.target.value); grow(); }} onKeyDown={onKeyDown}
            className="bg-transparent outline-none resize-none w-full min-h-[52px] px-3 pt-4 pb-2 text-[length:var(--text-ui-label)] text-[var(--surface-elevated-foreground,var(--foreground))] placeholder:text-[var(--surface-muted-foreground)]" />
          <div data-chat-input-footer="true" className="bg-transparent flex-shrink-0 px-2.5 py-1.5 flex items-center justify-between gap-x-1.5">
            <div className="flex items-center gap-x-1.5">
              {/* OpenChamber's auto-accept toggle (PermissionAutoAcceptButton.tsx): shield-check when on, shield-user when off. */}
              <button type="button" onClick={onToggleAutoAccept} onMouseDown={event => event.preventDefault()}
                className={cx(ICON_BUTTON, 'rounded-md hover:bg-transparent')}
                title={autoAccept ? 'Permissions in this chat are allowed automatically. Click to ask again.' : 'Permissions in this chat ask you. Click to allow them automatically.'}
                aria-label={autoAccept ? 'Stop auto-accepting permissions' : 'Auto-accept permissions'}>
                {autoAccept ? <RiShieldCheckLine className="h-[18px] w-[18px]" style={{ color: 'var(--status-info)' }} /> : <RiShieldUserLine className="h-[18px] w-[18px]" />}
              </button>
              <span className="typography-micro text-muted-foreground/70">{agent}{autoAccept && <span style={{ color: 'var(--status-info)' }}> · auto-accept</span>}</span>
            </div>
            <div className="flex items-center gap-x-3">
              {busy && <button type="button" className={cx(ICON_BUTTON, 'text-[var(--status-error)] hover:text-[var(--status-error)]')} title="Stop" onClick={onStop}><StopIcon className="h-5 w-5" /></button>}
              <button type="submit" className={cx(ICON_BUTTON, canSend ? 'text-primary hover:text-primary' : 'opacity-30')} disabled={!canSend} title="Send">
                <RiSendPlane2Line className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
