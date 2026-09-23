import { useEffect, useRef, useState } from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiArrowUpSLine, RiBrainLine, RiErrorWarningLine, RiInformationLine } from '@remixicon/react';
import type { Message, Part } from '../types.ts';
import { cx } from '../components/ui.tsx';
import { Markdown } from './Markdown.tsx';
import { formatDuration, STATIC_TOOLS, toolDescription, ToolIcon, toolTitle } from './tools.tsx';

// Message parts, rendered to look like OpenChamber's chat (MIT, see ../../NOTICE): ChatMessage.tsx, MessageBody.tsx,
// parts/UserTextPart.tsx, AssistantTextPart.tsx, ReasoningPart.tsx, ToolPart.tsx, ProgressiveGroup.tsx.

const TOOL_ROW_TEXT = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE = cx('typography-meta font-medium', TOOL_ROW_TEXT);
const TOOL_ROW_DESCRIPTION = cx('typography-meta', TOOL_ROW_TEXT);

export function BusyDots() {
  return <>{' '}<span className="inline-flex" aria-hidden>{[0, 200, 400].map(delay => <span key={delay} className="animate-busy-wave" style={{ animationDelay: `${delay}ms` }}>.</span>)}</span></>;
}

/** Text a user typed, shown in the right-aligned bubble; long messages clamp to two lines until clicked. */
export function UserBubble({ message }: { message: Message }) {
  const text = message.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text ?? '').join('\n\n');
  const [expanded, setExpanded] = useState(false);
  const long = text.split('\n').length > 2 || text.length > 240;
  if (!text) return null;
  return (
    <div className="group w-full pt-4 pb-0">
      <div className="chat-message-column relative">
        <div className="relative flex justify-end group/user-shell">
          <div className="max-w-[85%]">
            <div className="px-5 py-3 shadow-none border border-primary/5 relative"
              style={{ backgroundColor: 'var(--chat-user-message-bg)', borderRadius: 'var(--radius-xl)', borderBottomRightRadius: 'var(--radius-sm)' }}>
              {expanded && long && (
                <button className="absolute top-1 right-1 z-10 flex items-center justify-center rounded-sm bg-surface-elevated p-0.5 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground" onClick={() => setExpanded(false)}>
                  <RiArrowUpSLine className="h-3.5 w-3.5" />
                </button>
              )}
              <div className="leading-relaxed text-foreground/90 text-base overflow-x-hidden overflow-y-hidden">
                <div className={cx('break-words font-sans typography-markdown-body', long && !expanded && 'line-clamp-2 cursor-pointer')} onClick={() => long && setExpanded(true)}>
                  <Markdown text={text} className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AssistantText({ part }: { part: Part }) {
  if (!part.text?.trim()) return null;
  return <div className="group/assistant-text relative break-words my-1"><Markdown text={part.text} /></div>;
}

function Disclosure({ expanded, icon }: { expanded: boolean; icon: React.ReactNode }) {
  return (
    <div className="relative h-5 w-3.5 flex-shrink-0 cursor-pointer">
      <div className={cx('absolute inset-0 flex items-center justify-center transition-opacity', expanded ? 'opacity-0' : 'group-hover/tool:opacity-0')}>{icon}</div>
      <div className={cx('absolute inset-0 transition-opacity flex items-center justify-center', expanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100')} style={{ color: 'var(--tools-icon)' }}>
        {expanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
      </div>
    </div>
  );
}

/** The timeline body under an expanded row: indented, with a thin rail on the left. */
function RailBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative ml-2 pl-3">
      <span aria-hidden className="pointer-events-none absolute left-0 top-px bottom-0 w-px" style={{ backgroundColor: 'var(--tools-border)' }} />
      {children}
    </div>
  );
}

function cleanReasoning(text: string) {
  return text.split('\n').map(line => line.replace(/^>\s?/, '')).filter(line => line.trim()).join('\n');
}

function summarize(text: string, length = 80) {
  const plain = text.replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= length) return plain;
  const cut = plain.slice(0, length);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : length)}…`;
}

/** "Thinking": open while it streams, folded once done, with a one-line summary. */
export function ReasoningPart({ part, streaming }: { part: Part; streaming: boolean }) {
  const [toggled, setToggled] = useState<boolean>();
  const expanded = toggled ?? streaming;
  const text = cleanReasoning(part.text ?? '');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (streaming && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, streaming]);
  if (!text) return null;
  return (
    <div className="py-0">
      <div role="button" tabIndex={0} aria-expanded={expanded} onClick={() => setToggled(!expanded)}
        className="group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl cursor-pointer items-center">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Disclosure expanded={expanded} icon={<span style={{ color: 'var(--tools-icon)' }}><RiBrainLine className="h-3.5 w-3.5" /></span>} />
          <span className={cx(TOOL_ROW_TITLE, streaming && 'flex items-center gap-1')} style={{ color: 'var(--tools-title)' }}>Thinking{streaming && <BusyDots />}</span>
        </div>
        <div className={cx('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION)} style={{ color: 'var(--tools-description)' }}>
          {!streaming && !expanded ? <span className={cx('min-w-0 truncate', TOOL_ROW_DESCRIPTION)} title={summarize(text, 400)}>{summarize(text)}</span> : <span className="min-w-0 flex-1" />}
        </div>
      </div>
      {expanded && (
        <div className="relative ml-2 pl-3 pb-1 pt-0.5">
          <span aria-hidden className="pointer-events-none absolute left-0 top-0 bottom-0 w-px" style={{ backgroundColor: 'var(--tools-border)' }} />
          <div ref={body} className="max-h-80 overflow-y-auto"><Markdown text={text} variant="reasoning" /></div>
        </div>
      )}
    </div>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function stringifyInput(input: Record<string, unknown> | undefined) {
  if (!input) return '';
  return Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`).join('\n');
}

function Scrollable({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className="w-full min-w-0 flex-none overflow-hidden"><div className={cx('tool-output-surface p-2 rounded-xl w-full min-w-0 max-h-[60vh] overflow-auto', className)}>{children}</div></div>;
}

/** A tool call: one line (icon, title, description, duration), expanding to its input, output or error. */
export function ToolPart({ part, directory }: { part: Part; directory: string }) {
  const [expanded, setExpanded] = useState(false);
  const state = part.state;
  const tool = part.tool ?? 'tool';
  const running = state?.status === 'running';
  const error = state?.status === 'error';
  const now = useNow(running && tool === 'bash');
  if (!state || state.status === 'pending') return null;
  const description = toolDescription(part, directory);
  const title = toolTitle(tool);
  const start = state.time?.start;
  const duration = start ? formatDuration((state.time?.end ?? now) - start) : '';
  const input = state.input ?? {};
  const color = error ? 'var(--status-error)' : 'var(--tools-icon)';

  if (STATIC_TOOLS.has(tool)) {
    const slash = description.lastIndexOf('/');
    return (
      <div className="oc-static-tool-row flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0">
        <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color }}><ToolIcon tool={tool} /></div>
        <span className={cx(TOOL_ROW_TITLE, 'inline-flex items-center flex-shrink-0 opacity-85 transition-opacity duration-200', running && 'opacity-70')} style={{ color: error ? color : 'var(--tools-title)' }}>{title}</span>
        <span className={cx('min-w-0 inline-flex max-w-full flex-1 items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION)} title={description}>
          {slash > 0 && <span className="min-w-0 shrink truncate whitespace-nowrap" style={{ color: 'var(--tools-description)', direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}>{description.slice(0, slash)}</span>}
          {slash > 0 && <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>}
          <span className="flex-shrink-0 truncate" style={{ color: 'var(--tools-title)' }}>{slash > 0 ? description.slice(slash + 1) : description}</span>
        </span>
      </div>
    );
  }

  const additions = typeof state.metadata?.additions === 'number' ? state.metadata.additions as number : undefined;
  const deletions = typeof state.metadata?.deletions === 'number' ? state.metadata.deletions as number : undefined;
  const editLike = ['edit', 'multiedit', 'apply_patch'].includes(tool);
  const diff = typeof state.metadata?.diff === 'string' ? state.metadata.diff as string : undefined;
  return (
    <div>
      <div role="button" tabIndex={0} onClick={() => setExpanded(!expanded)} className="group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl items-center cursor-pointer">
        <div className="flex gap-1.5 items-center flex-shrink-0">
          <Disclosure expanded={expanded} icon={<span style={{ color }}><ToolIcon tool={tool} /></span>} />
          <span className={cx(TOOL_ROW_TITLE, 'flex-shrink-0 transition-opacity duration-200', running && 'opacity-70')} style={{ color: error ? 'var(--status-error)' : 'var(--tools-title)' }}>{title}</span>
          {tool === 'bash' && duration && <span className={cx('flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION)}>{duration}</span>}
        </div>
        <div className={cx('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION)} style={{ color: 'var(--tools-description)' }}>
          <span className={cx('min-w-0 truncate', TOOL_ROW_DESCRIPTION)} title={description}>{description}</span>
          {editLike && additions !== undefined && (
            <span className="typography-meta flex-shrink-0 tabular-nums" style={{ fontSize: '0.8rem', lineHeight: 1 }}>
              <span style={{ color: 'var(--status-success)' }}>+{additions}</span><span style={{ color: 'var(--tools-description)' }}>/</span><span style={{ color: 'var(--status-error)' }}>-{deletions ?? 0}</span>
            </span>
          )}
        </div>
      </div>
      {expanded && (
        <RailBody>
          <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
            {!editLike && (
              <div className="my-1">
                <Scrollable className={cx('max-h-60', tool === 'bash' && 'p-0 rounded-none')}>
                  {tool === 'bash'
                    ? <pre className="tool-input-text whitespace-pre-wrap break-words typography-code text-muted-foreground/90 m-0 p-0">{String(input.command ?? '')}</pre>
                    : <blockquote className="tool-input-text whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">{stringifyInput(input)}</blockquote>}
                </Scrollable>
              </div>
            )}
            {(state.status === 'completed' || (running && state.output)) && (
              <div>
                {editLike && diff ? (
                  <Scrollable className="p-1"><pre className="typography-code whitespace-pre m-0">{diff.split('\n').map((line, index) => (
                    <div key={index} style={{ color: line.startsWith('+') && !line.startsWith('+++') ? 'var(--status-success)' : line.startsWith('-') && !line.startsWith('---') ? 'var(--status-error)' : line.startsWith('@@') ? 'var(--status-info)' : undefined }}>{line || ' '}</div>
                  ))}</pre></Scrollable>
                ) : state.output?.trim() ? (
                  tool === 'task'
                    ? <Markdown text={state.output} variant="tool" />
                    : <Scrollable className={cx(tool === 'bash' && 'p-1 rounded-none max-h-[46vh]')}><pre className="typography-code text-muted-foreground/90 m-0 whitespace-pre-wrap break-words" style={{ lineHeight: 'var(--code-block-line-height)' }}>{state.output}</pre></Scrollable>
                ) : <div className="typography-meta text-muted-foreground/70">No output produced</div>}
              </div>
            )}
            {error && (
              <div>
                <div className="typography-meta font-medium text-muted-foreground/80 mb-1">Error:</div>
                <div className="typography-meta p-2 rounded-xl border whitespace-pre-wrap break-words" style={{ backgroundColor: 'var(--status-error-background)', color: 'var(--status-error)', borderColor: 'var(--status-error-border)' }}>{state.error}</div>
              </div>
            )}
          </div>
        </RailBody>
      )}
    </div>
  );
}

function errorText(error: NonNullable<Message['info']['error']>) {
  if (error.name === 'MessageAbortedError') return 'The running turn was stopped before OpenCode could send the next message.';
  if (error.name === 'ProviderAuthError') return 'The model provider rejected the credentials. Log in to the provider again in opencode.';
  return `Opencode failed to send message with error: ${error.data?.message ?? error.name ?? 'unknown error'}`;
}

export function MessageError({ error }: { error: NonNullable<Message['info']['error']> }) {
  return (
    <div className="group/assistant-text relative mt-3 max-w-full break-words rounded-2xl border border-[var(--status-info-border)] bg-[var(--status-info-background)] px-4 py-3 text-base leading-relaxed">
      <div className="flex items-center gap-3">
        <RiInformationLine className="size-4 shrink-0 text-[var(--status-info)]" />
        <div className="min-w-0 flex-1 break-words"><Markdown text={errorText(error)} className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0" /></div>
      </div>
    </div>
  );
}

export function SessionErrorNotice({ error }: { error: string }) {
  return (
    <div className="chat-message-column">
      <div role="status" className="mt-3 max-w-full break-words rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3 text-base leading-relaxed">
        <div className="flex items-start gap-3">
          <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-medium text-foreground">OpenCode stopped this reply</div>
            <div className="mt-1 text-foreground/80">{error}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Under the last assistant message of a finished turn: model · agent · duration · time. */
export function TurnFooter({ messages }: { messages: Message[] }) {
  const last = messages.at(-1)!.info;
  const first = messages[0]!.info;
  const facts = [
    last.modelID,
    last.agent,
    last.time.completed ? formatDuration(last.time.completed - first.time.created) : undefined,
    new Date(last.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  ].filter(Boolean) as string[];
  return (
    <div className="mt-2 mb-1 flex flex-col gap-y-1.5">
      <div className="message-footer__facts whitespace-nowrap text-sm text-muted-foreground/60">
        {facts.map((fact, index) => (
          <span key={index} className={cx('tabular-nums', index === 0 ? 'flex min-w-0 shrink items-center gap-1.5' : 'message-footer__fact')}>
            {index > 0 && <span className="opacity-60" aria-hidden>·</span>}
            <span className={index === 0 ? 'truncate' : undefined}>{fact}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
