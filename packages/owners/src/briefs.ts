import { effectiveDecision, type Finding, type Verdict } from './artifacts.ts';
import type { Duty } from './declarations.ts';
import type { WorkItem } from './ledger.ts';
import type { InstanceAsk, ResourceRequest } from './requests.ts';

function block(label: string, body: string) {
  return `<${label}>\n${body.trim()}\n</${label}>`;
}

function list(items: readonly string[]) {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '(none)';
}

export function findingsText(findings: readonly Finding[]) {
  return list(findings.map(finding => `[${finding.severity}] ${finding.file}: ${finding.issue} → ${finding.suggestion}`));
}

/**
 * The review as the person who merges reads it in the PR: what the last round decided and every finding it raised,
 * blocking or not. Findings that did not block are advice, and this is where the person sees them.
 */
export function findingsSection(verdicts: readonly Verdict[]) {
  const last = verdicts.at(-1);
  if (!last) return '';
  const rounds = verdicts.length === 1 ? '1 round' : `${verdicts.length} rounds`;
  const findings = last.findings.length ? `\n\nFindings from the last round:\n${findingsText(last.findings)}` : '';
  return `### Review\n\n${effectiveDecision(last)} after ${rounds}: ${last.summary}${findings}\n`;
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
 * The previous round's findings and what changed since, so a re-review of a desk change checks them instead of
 * starting over: without it every round raises a new set of findings and review never converges.
 */
export function previousReviewText({ round, reviewer, verdict, changesSince }: PreviousReview) {
  const header = `round="${round}" reviewer="${reviewer}" decision="${verdict.decision}"`;
  const since = changesSince === undefined ? undefined : block('changes-since-previous-review', changesSince);
  const previous = `<previous-review ${header}>\n${verdict.summary}\n${findingsText(verdict.findings)}\n</previous-review>`;
  return [previous, since, CONVERGENCE].filter(Boolean).join('\n\n');
}

const NOTEBOOK_RULES = `Notebook edits: each edit targets one register (MAP, WISDOM, FAILURES, decisions, open-questions) and one "## section".
Use append to add to a section, replace-section only to correct it. Record durable knowledge a future
session would need, not a narrative of this session. Cite files. Never record secrets.`;

const WORK_STATE_TEXT: Partial<Record<WorkItem['status'], (item: WorkItem) => string>> = {
  landed: item => item.publication
    ? `published as ${item.publication.url} (${item.publication.state})`
    : `landed on ${item.branch ?? 'a branch'}, NOT on the base branch, so your checkout does not show it`,
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
  work: (maxProposals: number) => `2. Propose at most ${maxProposals} improvements worth doing. Each must be small or medium, independently
   landable, testable, and have concrete acceptance criteria. Prefer real user-facing or maintenance value over churn.
   Do not propose work that duplicates what is already in progress or landed. Each proposal goes to the person, who
   plans it with you in chat.`,
  attention: (maxProposals: number) => `2. You have no authority to change this domain yourself. Raise at most ${maxProposals} items that need
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

export function distillBrief(journal: readonly string[], notebook: string) {
  return [
    'Fold your recent journal into your notebook. Keep registers short: merge duplicates, correct what the journal shows is wrong.',
    `Journal kinds from chats with the person: "chat-decision" lines are CANDIDATES (a watcher or you noted them, each with the
person's exact words in "quote"); record only real decisions, preferences and pronouncements, in decisions.md or WISDOM, and
cite the quote. "retracted" lines mean the person said something noted was not a decision: never record it. "chat-action"
lines are things you did with the person's approval, "subagent-action" lines what your subagents did; record them in MAP only where they change what exists. "fact"
lines are facts you observed, each with its source: keep every statement word for word in MAP (what exists) or WISDOM
(what holds), citing its source, unless a later line shows it is no longer true.`,
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
