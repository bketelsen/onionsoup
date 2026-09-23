import { useState } from 'react';
import { RiArrowRightSLine, RiCheckLine, RiCloseLine, RiEditLine, RiQuestionLine, RiTimeLine } from '@remixicon/react';
import { api } from '../api.ts';
import type { InboxEntry } from '../types.ts';
import { cx } from '../components/ui.tsx';
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

function Choice({ multiple, selected }: { multiple: boolean; selected: boolean }) {
  if (multiple) {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border" style={{ borderColor: 'color-mix(in srgb, var(--foreground) 40%, var(--interactive-border))' }}>
        {selected && <RiCheckLine className="h-3 w-3 text-[var(--primary-text,var(--primary))]" />}
      </span>
    );
  }
  return selected
    ? <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary-base,var(--primary))_80%,transparent)]"><span className="h-[5px] w-[5px] rounded-full bg-primary-foreground" /></span>
    : <span className="block h-3.5 w-3.5 rounded-full bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)]" />;
}

export function QuestionCard({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const questions = entry.question!.questions;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(questions.map(() => ''));
  const [customActive, setCustomActive] = useState<boolean[]>(questions.map(() => false));
  const [responding, setResponding] = useState(false);
  const question = questions[index]!;
  const multiple = Boolean(question.multiple);
  const answered = (position: number) => answers[position]!.length > 0 || (customActive[position] && custom[position]!.trim().length > 0);
  const satisfied = questions.every((_, position) => answered(position));

  const toggle = (label: string) => {
    setAnswers(current => current.map((selected, position) => {
      if (position !== index) return selected;
      if (multiple) return selected.includes(label) ? selected.filter(entry => entry !== label) : [...selected, label];
      return [label];
    }));
    if (!multiple) setCustomActive(current => current.map((active, position) => (position === index ? false : active)));
  };
  const submit = async () => {
    if (!satisfied) { setIndex(questions.findIndex((_, position) => !answered(position))); return; }
    setResponding(true);
    const final = questions.map((_, position) => [...answers[position]!, ...(customActive[position] && custom[position]!.trim() ? [custom[position]!.trim()] : [])]);
    try {
      await api(`/api/owners/${entry.owner}/questions/${entry.id}`, { method: 'POST', body: { answers: final } });
      onDone();
    } catch {
      setResponding(false);
    }
  };
  const dismiss = async () => {
    setResponding(true);
    await api(`/api/owners/${entry.owner}/questions/${entry.id}`, { method: 'POST', body: { reject: true } }).catch(() => undefined);
    onDone();
  };

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-2 py-1.5 border-b border-border/20">
            <div className="flex items-center gap-2">
              <RiQuestionLine className="h-3.5 w-3.5 text-primary" />
              <span className="typography-meta font-medium text-muted-foreground">Input needed</span>
              {question.header && <span className="ml-auto typography-micro font-medium text-foreground/70 px-1.5 py-0.5 rounded bg-muted/30 border border-border/20">{question.header}</span>}
            </div>
          </div>
          <div className="px-2 py-2">
            {questions.length > 1 && (
              <div className="flex items-center gap-1 mb-2 flex-wrap">
                {questions.map((entry, position) => (
                  <button key={position} onClick={() => setIndex(position)}
                    className={cx('px-2 py-0.5 typography-meta font-medium rounded transition-colors flex items-center gap-1',
                      position === index ? 'bg-interactive-selection/40 text-foreground' : answered(position) ? 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-interactive-hover/20' : 'text-foreground/85 hover:text-foreground hover:bg-interactive-hover/20')}>
                    {entry.header || `Q${position + 1}`}
                  </button>
                ))}
              </div>
            )}
            <div className="typography-meta font-medium text-foreground mb-1.5">{question.question}</div>
            {multiple && <div className="typography-micro text-muted-foreground mb-1.5">Select multiple</div>}
            <div className="space-y-0.5">
              {question.options.map(option => {
                const selected = answers[index]!.includes(option.label);
                return (
                  <button key={option.label} disabled={responding} onClick={() => toggle(option.label)}
                    className={cx('w-full px-1.5 py-1 text-left rounded transition-colors hover:bg-interactive-hover/30', selected && 'bg-interactive-selection/20', responding && 'opacity-60 cursor-not-allowed')}>
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 shrink-0"><Choice multiple={multiple} selected={selected} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cx('typography-meta break-all', selected ? 'text-foreground font-medium' : 'text-foreground/80')}>{option.label}</span>
                          {/\(recommended\)/i.test(option.label) && <span className="typography-micro text-primary/80">recommended</span>}
                        </div>
                        {option.description && <div className="typography-micro text-muted-foreground break-words">{option.description}</div>}
                      </div>
                    </div>
                  </button>
                );
              })}
              <button onClick={() => { setCustomActive(current => current.map((active, position) => (position === index ? !active : active))); if (!multiple) setAnswers(current => current.map((selected, position) => (position === index ? [] : selected))); }}
                className={cx('w-full px-1.5 py-1 text-left rounded transition-colors hover:bg-interactive-hover/30', customActive[index] && 'bg-interactive-selection/20')}>
                <div className="flex items-center gap-2">
                  <RiEditLine className={cx('h-3.5 w-3.5', customActive[index] ? 'text-primary' : 'text-muted-foreground/50')} />
                  <span className={cx('typography-meta', customActive[index] ? 'text-foreground font-medium' : 'text-muted-foreground')}>Other…</span>
                </div>
              </button>
              {customActive[index] && (
                <div className="pl-6 pr-1 pt-0.5">
                  <textarea rows={2} placeholder="Your answer" autoFocus value={custom[index]}
                    onChange={event => setCustom(current => current.map((text, position) => (position === index ? event.target.value : text)))}
                    className="oc-surface-elevated w-full bg-surface-elevated border border-border/30 focus:border-interactive-border-focus rounded px-2 py-1 outline-none typography-meta text-foreground placeholder:text-muted-foreground/50 transition-colors resize-none overflow-hidden" />
                </div>
              )}
            </div>
          </div>
          <div className="px-2 pb-1.5 pt-1 flex items-center gap-1.5 border-t border-border/20">
            <button className={ACTION} style={{ color: 'var(--status-success)' }} disabled={responding} onClick={() => void submit()}>
              {satisfied ? <RiCheckLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}{satisfied ? 'Submit' : 'Next'}
            </button>
            <button className={ACTION} style={{ color: 'var(--status-error)' }} disabled={responding} onClick={() => void dismiss()}>
              <RiCloseLine className="h-3 w-3" />Dismiss
            </button>
            {responding && <div className="ml-auto"><Spinner /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
