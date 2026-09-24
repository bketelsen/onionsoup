import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Decision } from '../web/src/components/Decision.tsx';
import { ReviewFindings } from '../web/src/components/ReviewFindings.tsx';
import { QuestionCard } from '../web/src/chat/QuestionCard.tsx';
import { answersFor, emptyAnswer, selectAnswer, toggleCustom } from '../web/src/chat/questionAnswers.ts';
import type { InboxEntry, QuestionInfo, WorkItem } from '../web/src/types.ts';

const questions: QuestionInfo[] = [
  {
    header: 'Targets', question: 'Which targets?', multiple: true,
    options: [{ label: 'Engine', description: 'Runtime' }, { label: 'Surface', description: 'Browser' }],
  },
  {
    header: 'When', question: 'When should it run?', custom: false,
    options: [{ label: 'Now', description: 'Immediately' }, { label: 'Later', description: 'After review' }],
  },
  { header: 'Notes', question: 'Any notes?', options: [] },
];

function entry(questionsToAsk = questions): InboxEntry {
  return {
    kind: 'question', id: 'question-1', owner: 'bellonda', title: 'Input', detail: '', sessionID: 'chat-1',
    question: { id: 'question-1', sessionID: 'chat-1', questions: questionsToAsk },
  };
}

test('inbox question renders the full shared form with navigation, multiple selection and custom input', () => {
  const html = renderToStaticMarkup(createElement(Decision, { entry: entry(), onDone: () => undefined }));
  for (const text of ['Targets', 'When', 'Notes', 'Select multiple', 'Other…', 'Next', 'Dismiss']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('aria-pressed="false"'));
});

test('custom:false disables custom answers in the same form used by chat and inbox', () => {
  const html = renderToStaticMarkup(createElement(QuestionCard, { entry: entry([questions[1]!]), onDone: () => undefined }));
  assert.ok(html.includes('When should it run?'));
  assert.ok(!html.includes('Other…'));
  assert.deepEqual(answersFor([questions[1]!], [{ selected: ['Later'], custom: 'Injected', usesCustom: true }]), [['Later']]);
});

test('answers retain question order across navigation, multi-select toggles and custom entry', () => {
  const drafts = questions.map(emptyAnswer);
  drafts[1] = selectAnswer(drafts[1]!, questions[1]!, 'Now');
  drafts[1] = selectAnswer(drafts[1]!, questions[1]!, 'Later');
  drafts[0] = selectAnswer(drafts[0]!, questions[0]!, 'Engine');
  drafts[0] = selectAnswer(drafts[0]!, questions[0]!, 'Surface');
  drafts[0] = selectAnswer(drafts[0]!, questions[0]!, 'Engine');
  drafts[0] = { ...toggleCustom(drafts[0]!, questions[0]!), custom: '  Docs  ' };
  drafts[2] = { ...toggleCustom(drafts[2]!, questions[2]!), custom: '  Keep the existing colors.  ' };
  assert.deepEqual(answersFor(questions, drafts), [['Surface', 'Docs'], ['Later'], ['Keep the existing colors.']]);
  const single = { ...toggleCustom(emptyAnswer(), questions[2]!), custom: 'custom answer' };
  assert.deepEqual(answersFor([questions[2]!], [selectAnswer(single, questions[2]!, 'option')]), [['option']]);
});

test('review findings render the engine issue and suggestion, with optional empty file or suggestion', () => {
  const verdict: WorkItem['verdicts'][number] = {
    decision: 'revise', summary: 'Fix recovery', findings: [
      { severity: 'major', file: 'workflow.ts', issue: 'Publication is overwritten.', suggestion: 'Update only the learning fields.' },
      { severity: 'minor', file: '', issue: 'Add the missing recovery action.', suggestion: '' },
    ],
  };
  const html = renderToStaticMarkup(createElement(ReviewFindings, { verdict }));
  for (const text of ['major', 'workflow.ts', 'Publication is overwritten.', 'Suggestion: Update only the learning fields.', 'Add the missing recovery action.']) {
    assert.ok(html.includes(text), text);
  }
  assert.equal(renderToStaticMarkup(createElement(ReviewFindings, { verdict: { ...verdict, findings: [] } })), '');
});

test('pending force-push has a decline action requiring a reason', () => {
  const html = renderToStaticMarkup(createElement(Decision, {
    entry: { kind: 'push', id: 'work-1', owner: 'clippy', title: 'Resolve conflict', detail: '' },
    onDone: () => undefined,
  }));
  assert.ok(html.includes('Approve force-push'));
  assert.match(html, /disabled=""[^>]*>Decline force-push/);
  assert.ok(html.includes('Reason (required to decline force-push)'));
});

test('attention and interrupted requests retain their decision controls after the shared form integration', () => {
  const render = (kind: 'attention' | 'request-recovery') => renderToStaticMarkup(createElement(Decision, {
    entry: { kind, id: 'record-1', owner: 'clippy', title: 'Needs a decision', detail: '' },
    onDone: () => undefined,
  }));
  const attention = render('attention');
  assert.match(attention, /disabled=""[^>]*>Acknowledge/);
  assert.match(attention, /disabled=""[^>]*>Resolve/);
  const recovery = render('request-recovery');
  assert.ok(recovery.includes('Check outcome'));
  assert.match(recovery, /disabled=""[^>]*>Retry after inspection/);
  assert.match(recovery, /disabled=""[^>]*>Stop request/);
  for (const html of [attention, recovery]) assert.ok(html.includes('Reason or observed outcome'));
});
