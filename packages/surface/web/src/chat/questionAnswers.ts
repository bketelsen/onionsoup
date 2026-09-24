import type { QuestionInfo } from '../types.ts';

export interface QuestionDraft {
  selected: string[];
  custom: string;
  usesCustom: boolean;
}

export function emptyAnswer(): QuestionDraft {
  return { selected: [], custom: '', usesCustom: false };
}

export function selectAnswer(draft: QuestionDraft, question: QuestionInfo, label: string): QuestionDraft {
  if (!question.multiple) return { ...draft, selected: [label], usesCustom: false };
  const selected = draft.selected.includes(label)
    ? draft.selected.filter(answer => answer !== label) : [...draft.selected, label];
  return { ...draft, selected };
}

export function toggleCustom(draft: QuestionDraft, question: QuestionInfo): QuestionDraft {
  return { ...draft, usesCustom: !draft.usesCustom, selected: question.multiple ? draft.selected : [] };
}

/** The one payload shape used by both the inbox and chat; question order stays intact. */
export function answersFor(questions: readonly QuestionInfo[], drafts: readonly QuestionDraft[]) {
  return questions.map((question, position) => {
    const draft = drafts[position] ?? emptyAnswer();
    const custom = question.custom !== false && draft.usesCustom ? draft.custom.trim() : '';
    return [...draft.selected, ...(custom ? [custom] : [])];
  });
}
