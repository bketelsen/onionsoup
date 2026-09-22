import type { Finding, Plan, ProposedWork } from './artifacts.ts';
import type { Duty } from './declarations.ts';
import type { Verification, WorkItem } from './ledger.ts';

function block(label: string, body: string) {
  return `<${label}>\n${body.trim()}\n</${label}>`;
}

function list(items: readonly string[]) {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '(none)';
}

function proposalText(proposal: ProposedWork) {
  return [
    `Title: ${proposal.title}`,
    `Goal: ${proposal.goal}`,
    `Why: ${proposal.rationale}`,
    `Acceptance:\n${list(proposal.acceptance)}`,
  ].join('\n');
}

function planText(plan: Plan) {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.description} [${step.files.join(', ')}]`).join('\n');
  return [
    `Summary: ${plan.summary}`,
    `Steps:\n${steps}`,
    `Tests:\n${list(plan.tests)}`,
    `Risks:\n${list(plan.risks)}`,
    `Out of scope:\n${list(plan.outOfScope)}`,
  ].join('\n');
}

function findingsText(findings: readonly Finding[]) {
  return list(findings.map(finding => `[${finding.severity}] ${finding.file}: ${finding.issue} → ${finding.suggestion}`));
}

function verificationText(results: readonly Verification[]) {
  return results.map(result => `$ ${result.command}  (exit ${result.exitCode})\n${result.output.trim()}`).join('\n\n');
}

const NOTEBOOK_RULES = `Notebook edits: each edit targets one register (MAP, WISDOM, FAILURES, decisions, open-questions) and one "## section".
Use append to add to a section, replace-section only to correct it. Record durable knowledge a future
freelancer would need, not a narrative of this session. Cite files. Never record secrets.`;

export function surveyBrief(duty: Duty, notebook: string, head: string, maxProposals: number) {
  return [
    `Duty: ${duty.id}. You are working in your domain's checkout at commit ${head}.`,
    block('instructions', duty.instructions),
    block('notebook', notebook),
    `You are a project manager: you do not implement. Read the code as much as you need. Then:
1. Write notebook edits for what you learned (layout into MAP, conventions into WISDOM, unknowns into open-questions).
2. Propose at most ${maxProposals} improvements worth hiring freelancers for. Each must be small or medium, independently
   landable, testable, and have concrete acceptance criteria. Prefer real user-facing or maintenance value over churn.
   Do not propose work that duplicates what is already in progress.`,
    NOTEBOOK_RULES,
  ].join('\n\n');
}

export function planBrief(item: WorkItem, notebook: string, rubric: string) {
  const previous = item.verdicts.at(-1);
  const sections = [
    'You have been hired to plan one piece of work in this repository. Read the code you need; do not edit anything.',
    block('work', proposalText(item.proposal)),
    block('owner-notebook', notebook),
    block('rubric', rubric),
  ];
  if (item.ownerAnswers) {
    sections.push(block('owner-answers', item.ownerAnswers.answers.map(entry => `Q: ${entry.question}\nA: ${entry.answer}`).join('\n\n')));
  }
  if (item.plan && previous?.decision === 'replan') {
    sections.push(block('previous-plan', planText(item.plan)), block('why-replan', `${previous.summary}\n${findingsText(previous.findings)}`));
  }
  sections.push('Put questions only the owner can answer in questionsForOwner; leave it empty if the notebook and code answer everything.');
  return sections.join('\n\n');
}

export function ownerAnswerBrief(item: WorkItem, questions: readonly string[], notebook: string) {
  return [
    `A planner you hired for "${item.proposal.title}" has questions. Answer from your notebook and the code. If you do not know, say so.`,
    block('work', proposalText(item.proposal)),
    block('questions', list(questions)),
    block('notebook', notebook),
  ].join('\n\n');
}

export function implementBrief(item: WorkItem, plan: Plan, notebook: string, rubric: string) {
  const sections = [
    'You have been hired to implement one approved plan in this working tree. Make the change, add the tests the plan calls for, and run them. Do not commit.',
    block('work', proposalText(item.proposal)),
    block('approved-plan', planText(plan)),
    block('owner-notebook', notebook),
    block('rubric', rubric),
  ];
  const lastVerdict = item.verdicts.at(-1);
  if (lastVerdict?.decision === 'revise') {
    sections.push(block('review-findings-to-address', `${lastVerdict.summary}\n${findingsText(lastVerdict.findings)}`));
  }
  const lastImplementation = item.implementations.at(-1);
  if (lastImplementation && lastImplementation.verification.some(result => result.exitCode !== 0)) {
    sections.push(block('failed-verification', verificationText(lastImplementation.verification)));
  }
  return sections.join('\n\n');
}

export function reviewBrief(item: WorkItem, plan: Plan, patch: string, verification: readonly Verification[], notebook: string, rubric: string) {
  return [
    'You have been hired to review one change. The working tree has the change applied; read around it as needed. Do not edit anything.',
    block('work', proposalText(item.proposal)),
    block('approved-plan', planText(plan)),
    block('diff', patch),
    block('host-verification', verificationText(verification)),
    block('owner-notebook', notebook),
    block('rubric', rubric),
    'Decide: approve (ready to land), revise (the implementer should fix specific findings), or replan (the plan itself is wrong).',
  ].join('\n\n');
}

export function learningsBrief(item: WorkItem, notebook: string) {
  const verdicts = item.verdicts.map((verdict, index) => `Round ${index + 1}: ${verdict.decision}: ${verdict.summary}\n${findingsText(verdict.findings)}`);
  return [
    `Work item "${item.proposal.title}" finished with status ${item.status}${item.reason ? ` (${item.reason})` : ''}.`,
    block('plan', item.plan ? planText(item.plan) : '(none)'),
    block('reviews', verdicts.join('\n\n') || '(none)'),
    block('notebook', notebook),
    `As the owner, record what this work taught you about your domain and about briefing freelancers:
conventions the reviewer enforced (WISDOM), mistakes and their causes (FAILURES), decisions taken (decisions).
Only record what will change how future work is planned, implemented or reviewed. Return no edits if nothing qualifies.`,
    NOTEBOOK_RULES,
  ].join('\n\n');
}

export function distillBrief(journal: readonly string[], notebook: string) {
  return [
    'Fold your recent journal into your notebook. Keep registers short: merge duplicates, correct what the journal shows is wrong.',
    block('journal', journal.join('\n')),
    block('notebook', notebook),
    NOTEBOOK_RULES,
  ].join('\n\n');
}
