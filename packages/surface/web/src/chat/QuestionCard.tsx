import { useState } from 'react';
import { RiArrowRightSLine, RiCheckLine, RiCloseLine, RiEditLine, RiQuestionLine } from '@remixicon/react';
import { api } from '../api.ts';
import type { InboxEntry, QuestionInfo } from '../types.ts';
import { cx } from '../components/ui.tsx';
import { answersFor, emptyAnswer, selectAnswer, toggleCustom, type QuestionDraft } from './questionAnswers.ts';

const ACTION = 'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed';

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

function useQuestionForm(entry: InboxEntry, onDone: () => void) {
  const questions = entry.question?.questions ?? [];
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(emptyAnswer));
  const [error, setError] = useState('');
  const [responding, setResponding] = useState(false);
  const answers = answersFor(questions, drafts);
  const satisfied = answers.length > 0 && answers.every(answer => answer.length > 0);
  const updateDraft = (change: (draft: QuestionDraft) => QuestionDraft) =>
    setDrafts(current => current.map((draft, position) => position === index ? change(draft) : draft));
  const respond = async (body: { answers: string[][] } | { reject: true }) => {
    setResponding(true);
    setError('');
    try {
      await api(`/api/owners/${entry.owner}/questions/${entry.id}`, { method: 'POST', body });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setResponding(false);
    }
  };
  const submit = () => {
    if (!satisfied) {
      setIndex(answers.findIndex(answer => !answer.length));
      return;
    }
    void respond({ answers });
  };
  return { questions, index, setIndex, drafts, answers, error, responding, satisfied, updateDraft, respond, submit };
}

type QuestionFormProps = { form: ReturnType<typeof useQuestionForm> };

function QuestionTabs({ form }: QuestionFormProps) {
  const { questions, index, setIndex, responding, answers } = form;
  if (questions.length < 2) return null;
  return <div className="flex items-center gap-1 mb-2 flex-wrap">
    {questions.map((question, position) => (
      <button key={position} disabled={responding} onClick={() => setIndex(position)}
        className={cx('px-2 py-0.5 typography-meta font-medium rounded transition-colors',
          position === index ? 'bg-interactive-selection/40 text-foreground' : 'text-muted-foreground')}>
        {answers[position]!.length > 0 && <RiCheckLine className="inline h-3 w-3" />}
        {question.header || `Q${position + 1}`}
      </button>
    ))}
  </div>;
}

function QuestionChoices({ form }: QuestionFormProps) {
  const { questions, index, drafts, responding, updateDraft } = form;
  const question = questions[index]!;
  return <div className="space-y-0.5">
    {question.options.map(option => {
      const selected = drafts[index]!.selected.includes(option.label);
      return (
        <button key={option.label} disabled={responding}
          aria-pressed={selected} onClick={() => updateDraft(draft => selectAnswer(draft, question, option.label))}
          className={cx('w-full px-1.5 py-1 text-left rounded hover:bg-interactive-hover/30', selected && 'bg-interactive-selection/20')}>
          <div className="flex items-start gap-2">
            <div className="mt-0.5 shrink-0"><Choice multiple={Boolean(question.multiple)} selected={selected} /></div>
            <div className="min-w-0 flex-1">
              <div className={cx('typography-meta break-all', selected ? 'text-foreground font-medium' : 'text-foreground/80')}>
                {option.label}
              </div>
              {option.description && <div className="typography-micro text-muted-foreground break-words">{option.description}</div>}
            </div>
          </div>
        </button>
      );
    })}
    <CustomAnswer form={form} />
  </div>;
}

function CustomAnswer({ form }: QuestionFormProps) {
  const { questions, index, drafts, responding, updateDraft } = form;
  const question = questions[index]!;
  const draft = drafts[index]!;
  if (question.custom === false) return null;
  return <>
    <button disabled={responding} aria-pressed={draft.usesCustom}
      onClick={() => updateDraft(current => toggleCustom(current, question))}
      className={cx('w-full px-1.5 py-1 text-left rounded hover:bg-interactive-hover/30', draft.usesCustom && 'bg-interactive-selection/20')}>
      <div className="flex items-center gap-2">
        <RiEditLine className={cx('h-3.5 w-3.5', draft.usesCustom ? 'text-primary' : 'text-muted-foreground/50')} />
        <span className="typography-meta">Other…</span>
      </div>
    </button>
    {draft.usesCustom && <div className="pl-6 pr-1 pt-0.5">
      <textarea rows={2} placeholder="Your answer" aria-label="Your answer" autoFocus value={draft.custom}
        disabled={responding} onChange={event => updateDraft(current => ({ ...current, custom: event.target.value }))}
        className="w-full bg-surface-elevated border border-border/30 rounded px-2 py-1 typography-meta outline-none" />
    </div>}
  </>;
}

function QuestionActions({ form }: QuestionFormProps) {
  const { responding, satisfied, submit, respond, error } = form;
  return <div className="px-2 pb-1.5 pt-1 flex items-center gap-1.5 border-t border-border/20">
    <button className={ACTION} style={{ color: 'var(--status-success)' }} disabled={responding} onClick={submit}>
      {satisfied ? <RiCheckLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}
      {satisfied ? 'Submit' : 'Next'}
    </button>
    <button className={ACTION} style={{ color: 'var(--status-error)' }} disabled={responding}
      onClick={() => void respond({ reject: true })}>
      <RiCloseLine className="h-3 w-3" />Dismiss
    </button>
    {responding && <span className="ml-auto typography-meta">Sending…</span>}
    {error && <span role="alert" className="typography-meta text-status-error">{error}</span>}
  </div>;
}

/** The same complete question form appears in chat and in the inbox. */
export function QuestionCard({ entry, onDone }: { entry: InboxEntry; onDone: () => void }) {
  const form = useQuestionForm(entry, onDone);
  const question = form.questions[form.index];
  if (!question) return <div role="alert">question_empty: no questions to answer</div>;
  return <div className="group w-full pt-0 pb-2">
    <div className="chat-column">
      <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
        <div className="px-2 py-1.5 border-b border-border/20 flex items-center gap-2">
          <RiQuestionLine className="h-3.5 w-3.5 text-primary" />
          <span className="typography-meta font-medium text-muted-foreground">Input needed</span>
          {question.header && <span className="ml-auto typography-micro">{question.header}</span>}
        </div>
        <div className="px-2 py-2">
          <QuestionTabs form={form} />
          <div className="typography-meta font-medium text-foreground mb-1.5">{question.question}</div>
          {question.multiple && <div className="typography-micro text-muted-foreground mb-1.5">Select multiple</div>}
          <QuestionChoices form={form} />
        </div>
        <QuestionActions form={form} />
      </div>
    </div>
  </div>;
}
