import type { Finding, Plan, ProposedWork, Verdict } from './artifacts.ts';
import type { Initiative } from './initiatives.ts';
import type { Duty } from './declarations.ts';
import type { Verification, WorkItem } from './ledger.ts';
import type { InstanceAsk, ResourceRequest } from './requests.ts';
import { REPOSITORY_REVIEW, REPOSITORY_WRITING } from './repository-writing.ts';

function block(label: string, body: string) {
  return `<${label}>\n${body.trim()}\n</${label}>`;
}

type HumanNoteKind = WorkItem['humanNotes'][number]['kind'];

function humanNotesText(item: WorkItem, ...kinds: HumanNoteKind[]) {
  return item.humanNotes.filter(note => kinds.includes(note.kind)).map(note => `${note.by} (${note.at.slice(0, 10)}): ${note.note}`).join('\n');
}

function list(items: readonly string[]) {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '(none)';
}

/**
 * The work as the owner proposed it. The rationale is the owner's reasoning (often the history that led here); a
 * planner or reviewer weighs it, an implementer following an approved plan does not need it.
 */
function proposalText(proposal: ProposedWork, withRationale = true) {
  return [
    `Title: ${proposal.title}`,
    `Goal: ${proposal.goal}`,
    ...(withRationale ? [`Why: ${proposal.rationale}`] : []),
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

export function findingsText(findings: readonly Finding[]) {
  return list(findings.map(finding => `[${finding.severity}] ${finding.file}: ${finding.issue} → ${finding.suggestion}`));
}

const CONVERGENCE = `This change has been reviewed before. Start by checking every previous finding against the diff,
and say in your summary which are resolved. Ask for changes only for previous findings that are not resolved and for
problems in the changes since the previous review. Text that earlier rounds already reviewed without objection is
settled: raise something new there only if it is a blocker (a factual, correctness or safety error), and say why no
earlier round caught it.`;

/** The review round before this one: who decided what, and the diff between the tree it reviewed and this one. */
export interface PreviousReview {
  round: number;
  reviewer: string;
  verdict: Pick<Verdict, 'decision' | 'summary' | 'findings'>;
  /** Undefined when the reviewed tree is gone; the reviewer then checks the findings against the full diff. */
  changesSince?: string;
}

/**
 * The previous round's findings and what changed since, so a re-review checks them instead of starting over. Desk
 * changes and work items share it: without it every round raises a new set of findings and review never converges.
 */
export function previousReviewText({ round, reviewer, verdict, changesSince }: PreviousReview) {
  const header = `round="${round}" reviewer="${reviewer}" decision="${verdict.decision}"`;
  const since = changesSince === undefined ? undefined : block('changes-since-previous-review', changesSince);
  const previous = `<previous-review ${header}>\n${verdict.summary}\n${findingsText(verdict.findings)}\n</previous-review>`;
  return [previous, since, CONVERGENCE].filter(Boolean).join('\n\n');
}

/** Host verification as a reader needs it: every command and its exit code, and the output of the ones that failed. */
function verificationText(results: readonly Verification[]) {
  return results.map(result => `$ ${result.command}  (exit ${result.exitCode})${result.exitCode === 0 ? '' : `\n${result.output.trim()}`}`).join('\n\n');
}

const NOTEBOOK_RULES = `Notebook edits: each edit targets one register (MAP, WISDOM, FAILURES, decisions, open-questions) and one "## section".
Use append to add to a section, replace-section only to correct it. Record durable knowledge a future
freelancer would need, not a narrative of this session. Cite files. Never record secrets.`;

const WORK_STATE_TEXT: Partial<Record<WorkItem['status'], (item: WorkItem) => string>> = {
  landed: item => item.publication
    ? `landed and published as ${item.publication.url}`
    : `landed on local branch ${item.branch}, NOT yet on the base branch, so your checkout does not show it`,
  cancelled: item => `cancelled by a person: ${item.reason}`,
  rejected: item => `plan rejected by a person: ${item.reason}`,
  failed: item => `failed: ${item.reason}`,
};

/** What the owner has already done, so a survey neither repeats landed work nor re-proposes what a person rejected. */
export function workSoFarText(items: readonly WorkItem[]) {
  return items.map(item => {
    const describe = WORK_STATE_TEXT[item.status];
    return `- ${item.proposal.title} [${item.id}]: ${describe ? describe(item) : `in progress (${item.status})`}`;
  }).join('\n') || '(none)';
}

const PROPOSAL_MODES = {
  work: (maxProposals: number) => `2. Propose at most ${maxProposals} improvements worth hiring freelancers for. Each must be small or medium, independently
   landable, testable, and have concrete acceptance criteria. Prefer real user-facing or maintenance value over churn.
   Do not propose work that duplicates what is already in progress or landed.`,
  attention: (maxProposals: number) => `2. You have no freelancers for this domain and no authority to change it. Raise at most ${maxProposals} items that need
   a person's attention (risks, broken or unready configuration, drift), each with what you observed, why it matters and
   what a person should do. Raise nothing if nothing needs attention. Never suggest you will change anything yourself.`,
};

export function surveyBrief(duty: Duty, notebook: string, snapshot: string, maxProposals: number, workSoFar: string, mode: keyof typeof PROPOSAL_MODES = 'work', roster = '') {
  return [
    `Duty: ${duty.id}. Your workspace (read-only) reflects your domain at ${snapshot}.`,
    block('instructions', duty.instructions),
    block('roster', roster || '(no other owners)'),
    block('notebook', notebook),
    block('work-so-far', `${workSoFar}\nDo not re-propose landed work. A rejected item may come back only if you change it to answer the person's reason.`),
    `You are a project manager: you do not implement. Read your workspace as much as you need. Then:
1. Write notebook edits for what you learned (layout into MAP, conventions into WISDOM, unknowns into open-questions).
${PROPOSAL_MODES[mode](maxProposals)}`,
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
  const feedback = humanNotesText(item, 'plan-feedback');
  if (item.plan && feedback) {
    sections.push(block('previous-plan', planText(item.plan)), block('human-feedback-on-plan', `${feedback}\nRevise the plan to address every point. The person approves plans; their feedback outranks the proposal.`));
  }
  if (item.plan && previous?.decision === 'replan') {
    sections.push(block('previous-plan', planText(item.plan)), block('why-replan', `${previous.summary}\n${findingsText(previous.findings)}`));
  }
  sections.push('Put questions only the owner can answer in questionsForOwner; leave it empty if the notebook and code answer everything.');
  sections.push(`The person approves this plan before anyone implements it, and that approval is their go-ahead for everything
the plan describes. Do not add steps that wait for further evidence of their approval (a GitHub comment, a review, a
message): an implementer cannot obtain it. If a step needs a decision only the person can make, name it in the plan's
risks so they settle it before approving.`);
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

/**
 * What an implementer needs: the goal and acceptance, the approved plan, and what the owner knows about the domain
 * (its map, conventions and the person's decisions). Not the owner's charter, failures or open questions: those are
 * the owner's to manage.
 */
export function implementBrief(item: WorkItem, plan: Plan, knowledge: string, rubric: string) {
  const sections = [
    'You have been hired to implement one approved plan in this working tree. Make the change, add the tests the plan calls for, and run them. Do not commit.',
    block('repository-writing', REPOSITORY_WRITING),
    block('work', proposalText(item.proposal, false)),
    block('approved-plan', planText(plan)),
    ...(knowledge ? [block('owner-knowledge', knowledge)] : []),
    block('rubric', rubric),
  ];
  const approvalNotes = humanNotesText(item, 'approval');
  if (approvalNotes) sections.push(block('conditions-of-approval', `${approvalNotes}\nThese are part of the approved plan.`));
  const recoveryNotes = humanNotesText(item, 'retry', 'resume');
  if (recoveryNotes) sections.push(block('person-notes-on-recovery', `${recoveryNotes}\nThe person wrote these when resuming or retrying this work; they answer questions an earlier attempt raised.`));
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

export function reviewBrief(
  item: WorkItem, plan: Plan, patch: string, verification: readonly Verification[], notebook: string, rubric: string,
  previousReview?: PreviousReview,
) {
  return [
    'You have been hired to review one change. The working tree has the change applied; read around it as needed. Do not edit anything.',
    block('repository-writing', REPOSITORY_REVIEW),
    block('work', proposalText(item.proposal)),
    block('approved-plan', planText(plan)),
    block('diff', patch),
    block('host-verification', verificationText(verification)),
    block('conditions-of-approval', humanNotesText(item, 'approval') || '(none)'),
    block('person-notes-on-recovery', humanNotesText(item, 'retry', 'resume') || '(none)'),
    ...(notebook ? [block('owner-knowledge', notebook)] : []),
    block('rubric', rubric),
    ...(previousReview ? [previousReviewText(previousReview)] : []),
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
    `Journal kinds from chats with the person: "chat-decision" lines are CANDIDATES (a watcher or you noted them, each with the
person's exact words in "quote"); record only real decisions, preferences and pronouncements, in decisions.md or WISDOM, and
cite the quote. "retracted" lines mean the person said something noted was not a decision: never record it. "chat-action"
lines are things you did with the person's approval, "subagent-action" lines what your subagents did; record them in MAP only where they change what exists.`,
    block('journal', journal.join('\n')),
    block('notebook', notebook),
    NOTEBOOK_RULES,
  ].join('\n\n');
}

export function requestDecisionBrief(request: ResourceRequest, notebook: string, snapshot: string, roster = '') {
  return [
    `Another owner, ${request.from}, asks you for an instance. Your workspace (read-only) reflects your domain at ${snapshot}.`,
    block('roster', roster || '(no other owners)'),
    block('request', [
      `Image: ${(request.ask as InstanceAsk).image}`,
      `Purpose: ${request.ask.purpose}`,
      `Expected duration: ${(request.ask as InstanceAsk).expectedMinutes} minutes`,
    ].join('\n')),
    block('notebook', notebook),
    `Decide as the owner of this domain. Accept only if the purpose is legitimate, a remote you may create on is
healthy and has capacity, and the image is one your domain allows (SNAPSHOT.md lists the create policy). Choose
the remote, the image and a short name suffix that says what it is for. A person approves every create and
delete after you; the runtime also re-checks your choice. Decline with a reason if anything is off.`,
  ].join('\n\n');
}

export function composeAskBrief(duty: Duty, notebook: string, snapshot: string, target: string, followUp: string) {
  return [
    `Duty: ${duty.id}. Your workspace (read-only) reflects your domain at ${snapshot}.`,
    block('instructions', duty.instructions),
    block('notebook', notebook),
    block('what-the-runtime-will-do-with-the-instance', followUp),
    `You need an instance from ${target}, the owner of the homelab's virtualization. Write the request: which
image you need, what it is for (so ${target} can judge it; describe what will actually happen, above) and how
many minutes you expect to need it. The runtime releases the instance afterwards.`,
  ].join('\n\n');
}

export function publishDecisionBrief(request: ResourceRequest, site: { id: string; app: string; url: string; source: string }, notebook: string, snapshot: string, roster: string) {
  return [
    `${request.from} asks you to publish the site "${site.id}" (served by the TrueNAS app \`${site.app}\` at ${site.url}). Your workspace (read-only) reflects your NAS at ${snapshot}.`,
    block('request', request.ask.kind === 'publish-site' ? request.ask.purpose : ''),
    block('roster', roster || '(no other owners)'),
    block('notebook', notebook),
    `Decide as the owner of the NAS. Accept unless something in your snapshot makes publishing unsafe right now (the app is
missing or failing, the pool is degraded, an alert affects the dataset). The runtime builds the site from ${site.source}'s
repository, swaps it in atomically, restarts the app and verifies it, rolling back on failure. Decline with a reason otherwise.`,
  ].join('\n\n');
}

/** A manager reviews a report's plan for one of its initiatives, under a standing grant from the person. */
export function managerPlanReviewBrief(initiative: Initiative, item: WorkItem, plan: Plan, notebook: string) {
  return [
    `You manage ${item.owner}, which planned work for your initiative "${initiative.title}". The person gave you a standing grant to approve its plans; the runtime journals every use. Review the plan as its manager. Read what you need; do not edit anything.`,
    block('initiative', `Goal: ${initiative.goal}\nWhy: ${initiative.rationale}`),
    block('assignment', proposalText(item.proposal)),
    block('plan', planText(plan)),
    block('earlier-plan-feedback', humanNotesText(item, 'plan-feedback') || '(none)'),
    block('your-notebook', notebook),
    `Approve if the plan does what the assignment asks, fits the initiative and stays in scope. Revise, with specific
notes the planner can act on, if it needs changes. Escalate if the person should decide: a change of scope or risk,
a disagreement you cannot settle, or anything you are unsure about.`,
  ].join('\n\n');
}
