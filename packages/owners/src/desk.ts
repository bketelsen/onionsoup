import { parseJournalRecord, type JournalRecord } from './journal-record.ts';
import { listAttention } from './attention.ts';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { OwnerDeclaration } from './declarations.ts';
import { INITIATIVE_JOURNAL_KINDS, type AssignmentState, type Escalation, type PlanReview } from './initiatives.ts';
import type { AssignmentView, InitiativeView } from './org-work.ts';
import type { WorkItem } from './ledger.ts';
import { describeAsk, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';

export const DESK_LIMITS = { notes: 40, registerChars: 20_000, requests: 15 };

const REGISTERS = ['MAP', 'WISDOM', 'decisions', 'open-questions', 'FAILURES'] as const;
const NOTE_KINDS = new Set([
  'delete-approved', 'request-denied', 'create-failed', 'delete-failed',
  'attention-decision', 'request-recovery', 'request-recovered', 'request-completed', 'create-approved', 'request-opened',
  'chat-decision', 'chat-action', 'retracted', 'work-opened', 'plan-approved', 'plan-rejected', 'published', 'publish-failed',
  'rebase-pushed', 'attention', 'app-held', 'app-update-proposed', 'app-updated', 'request-accepted', 'request-declined',
  'request-refused', 'instance-created', 'instance-deleted', 'follow-up', 'asked', 'answered', 'ci-triage', 'owner-created',
  'owner-updated', 'owner-retired', 'ship-started', 'shipped', 'work-status', 'friction',
  ...INITIATIVE_JOURNAL_KINDS,
]);
const DONE = new Set(['landed', 'failed', 'rejected', 'cancelled']);

function isOpenWork(item: WorkItem) {
  return !DONE.has(item.status) || item.publication?.state === 'open';
}

/** Landed on a local branch but not yet a PR: the person publishes it. Rebases update an existing PR instead. */
export function awaitingPublish(item: WorkItem) {
  return item.status === 'landed' && !item.publication && !item.rebaseOf;
}



async function journal(directory: string) {
  const files = (await readdir(join(directory, 'journal')).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
  const lines = (await Promise.all(files.map(file => readFile(join(directory, 'journal', file), 'utf8')))).join('').split('\n').filter(Boolean);
  return lines.flatMap(line => {
    const entry = parseJournalRecord(line);
    return entry ? [entry] : [];
  });
}

function pickOwner(runtime: Runtime, query: DeskQuery) {
  const owners = [...runtime.declarations.owners.values()];
  const byId = query.owner ? owners.find(owner => owner.id === query.owner) : undefined;
  const byAgent = query.agent ? owners.find(owner => owner.persona?.name === query.agent) : undefined;
  const deskOf = (owner: OwnerDeclaration) => resolve(runtime.desksRoot, owner.id);
  const byDirectory = query.directory ? owners.find(owner => resolve(query.directory!).startsWith(deskOf(owner))) : undefined;
  return byId ?? byAgent ?? byDirectory ?? owners.find(owner => owner.persona);
}

export interface DeskQuery { agent?: string; directory?: string; owner?: string }

/** Everything Bellonda's Desk (or any owner's) shows, in one read-only snapshot. */
export async function deskState(runtime: Runtime, query: DeskQuery) {
  const owners = [...runtime.declarations.owners.values()].filter(owner => owner.persona).map(owner => ({ id: owner.id, name: owner.persona!.name, title: owner.persona!.title }));
  const owner = pickOwner(runtime, query);
  if (!owner) return { owners, owner: null };
  const notebook = runtime.notebook(owner.id);
  const registers = Object.fromEntries(await Promise.all(REGISTERS.map(async register => [
    register,
    (await readFile(join(notebook.directory, `${register}.md`), 'utf8').catch(() => '')).slice(0, DESK_LIMITS.registerChars),
  ])));
  const entries = await journal(notebook.directory);
  const retracted = new Set(entries.filter(entry => entry.kind === 'retracted').map(entry => entry.note ?? ''));
  const seenQuotes: string[] = [];
  const isDuplicate = (entry: JournalRecord) => {
    const quote = entry.quote?.trim();
    if (entry.kind !== 'chat-decision' || !quote) return false;
    const duplicate = seenQuotes.some(seen => seen.includes(quote) || quote.includes(seen));
    seenQuotes.push(quote);
    return duplicate;
  };
  const notes = entries.filter(entry => NOTE_KINDS.has(entry.kind) && entry.kind !== 'retracted').filter(entry => !isDuplicate(entry))
    .slice(-DESK_LIMITS.notes).reverse()
    .map(entry => ({ ...entry, retracted: retracted.has(entry.note ?? '') }));
  const items = (await runtime.ledger.list()).filter(item => item.owner === owner.id);
  const requests = (await runtime.requests.list()).filter(request => request.from === owner.id || request.to === owner.id);
  const pending = [
    ...items.filter(item => item.status === 'awaiting-plan-approval').map(item => ({ kind: 'plan', id: item.id, title: item.proposal.title, detail: item.plan?.summary ?? item.proposal.goal })),
    ...items.filter(awaitingPublish).map(item => ({ kind: 'publish', id: item.id, title: item.proposal.title, detail: `Landed on ${item.branch}; publishing opens a draft PR.` })),
    ...items.filter(item => item.status === 'awaiting-push-approval').map(item => ({ kind: 'push', id: item.id, title: item.proposal.title, detail: item.rebaseOf?.prUrl ?? '' })),
    ...requests.filter(request => request.status === 'awaiting-create-approval').map(request => ({
      kind: 'create', id: request.id, detail: request.ask.purpose,
      title: request.ask.kind === 'instance' ? `Create ${request.decision?.remote}:${request.decision?.nameSuffix} (${request.decision?.image})` : describeAsk(request.ask),
    })),
    ...requests.filter(request => request.status === 'awaiting-delete-approval').map(request => ({ kind: 'delete', id: request.id, title: `Delete ${request.instance?.remote}:${request.instance?.name}`, detail: request.followUpResult?.summary ?? '' })),
  ];
  const work = items.filter(isOpenWork).map(item => ({ id: item.id, status: item.status, title: item.proposal.title }));
  const activity = requests.slice(-DESK_LIMITS.requests).reverse().map(request => ({
    id: request.id, status: request.status, title: describeAsk(request.ask), from: request.from, to: request.to,
    detail: `${request.workItem ? `Work ${request.workItem}: ` : ''}${request.reason ?? request.followUpResult?.summary ?? request.ask.purpose}`, at: request.updatedAt,
  }));
  const recent = items.filter(item => !isOpenWork(item)).slice(-5).reverse().map(item => ({ id: item.id, status: item.status, title: item.proposal.title, url: item.publication?.url }));
  return {
    owners,
    owner: { id: owner.id, name: owner.persona?.name ?? owner.id, title: owner.persona?.title ?? '', source: owner.persona?.source ?? '', model: owner.model, desk: resolve(runtime.desksRoot, owner.id) },
    pending,
    work,
    recent,
    activity,
    notes,
    registers,
    attention: (await listAttention(runtime)).filter(entry => entry.owner === owner.id),
  };
}

export const STATUS_LIMITS = { recentDays: 7, recentItems: 10 };

/** Where a finished item ended up, in words an owner can repeat to the person. */
function outcome(item: WorkItem) {
  if (item.status === 'landed') {
    if (item.publication) return `landed; PR ${item.publication.url} (${item.publication.state})`;
    if (item.rebaseOf) return `landed; updated ${item.rebaseOf.prUrl}`;
    return `landed on ${item.branch} (${item.landedCommit?.slice(0, 12)}); not yet a PR: waiting on the person to publish it`;
  }
  return `${item.status}${item.reason ? `: ${item.reason}` : ''}`;
}

/** An owner's work and requests: everything open, then what finished recently and how. */
export function statusText(items: readonly WorkItem[], requests: readonly ResourceRequest[], now = new Date()) {
  const since = now.getTime() - STATUS_LIMITS.recentDays * 24 * 60 * 60 * 1000;
  const open = items.filter(isOpenWork);
  const recent = items.filter(item => !isOpenWork(item) && Date.parse(item.updatedAt) >= since).slice(-STATUS_LIMITS.recentItems).reverse();
  const live = requests.filter(request => !['deleted', 'declined', 'denied', 'failed', 'published', 'updated', 'completed'].includes(request.status));
  const finishedRequests = requests.filter(request => !live.includes(request) && Date.parse(request.updatedAt) >= since).slice(-STATUS_LIMITS.recentItems).reverse();
  const sections = [
    open.length || live.length ? ['Open:', ...open.map(item => `- work ${item.id}: ${outcome(item)}: ${item.proposal.title}`), ...live.map(request => `- request ${request.id}: ${request.status}: ${request.from} → ${request.to} ${describeAsk(request.ask)}${request.workItem ? `; work ${request.workItem}` : ''}`)] : ['Open: nothing.'],
    finishedRequests.length ? ['Recent requests:', ...finishedRequests.map(request => `- ${request.id}: ${request.status}: ${describeAsk(request.ask)}${request.workItem ? `; work ${request.workItem}` : ''}${request.reason ? `; ${request.reason}` : ''}`)] : [],
    recent.length ? [`Finished in the last ${STATUS_LIMITS.recentDays} days:`, ...recent.map(item => `- work ${item.id}: ${outcome(item)}: ${item.proposal.title}`)] : [],
  ];
  return sections.filter(section => section.length).map(section => section.join('\n')).join('\n\n');
}

/** One work item in full, for an owner asking about it by id. */
export function itemText(item: WorkItem) {
  const lines = [`${item.id}: ${item.proposal.title}`, `Status: ${DONE.has(item.status) ? outcome(item) : item.status}`, `Opened ${item.createdAt}; updated ${item.updatedAt}`, `Goal: ${item.proposal.goal}`];
  if (item.plan) lines.push(`Plan: ${item.plan.summary}`, ...item.plan.steps.map((step, index) => `  ${index + 1}. ${step.description}`));
  if (item.planApproval) lines.push(`Plan approved by ${item.planApproval.by} at ${item.planApproval.at}`);
  item.implementations.forEach((implementation, index) => lines.push(`Implementation ${index + 1}: ${implementation.report.summary}`, `  verify: ${implementation.verification.map(result => `${result.command.slice(0, 60)}=${result.exitCode}`).join(', ')}`));
  item.verdicts.forEach((verdict, index) => lines.push(`Review ${index + 1}: ${verdict.decision}: ${verdict.summary}`));
  lines.push(`Hires: ${item.hires.map(hire => `${hire.stage} ${hire.model} ${hire.outcome}${hire.error ? ` (${hire.error.slice(0, 120)})` : ''}`).join('; ') || 'none'}`);
  return lines.join('\n');
}

const ASSIGNMENT_WORDS: Partial<Record<AssignmentState, string>> = {
  'not-dispatched': 'not dispatched yet',
  'plan-waiting': 'plan waiting for approval',
  'awaiting-publish': 'landed; waiting on the person to publish it',
  'awaiting-merge': 'PR open; waiting on the person to merge it',
  'awaiting-person': 'waiting on the person',
  blocked: 'interrupted; waiting on the person',
};

function assignmentLine(assignment: AssignmentView) {
  const after = assignment.after.length ? ` after ${assignment.after.join(', ')}` : '';
  const work = assignment.item ? `; work ${assignment.item.id}` : '';
  const pr = assignment.item?.publication ? ` ${assignment.item.publication.url}` : '';
  return `- ${assignment.id} → ${assignment.to}${after}: ${assignment.proposal.title} [${ASSIGNMENT_WORDS[assignment.state] ?? assignment.state}]${work}${pr}`;
}

function escalationLine(escalation: Escalation) {
  const state = escalation.resolution ? `resolved by ${escalation.resolution.by}: ${escalation.resolution.note}` : 'OPEN';
  return `Escalation ${escalation.id} (${escalation.kind}) from ${escalation.from} on ${escalation.assignment}: ${escalation.note} [${state}]`;
}

function planReviewLine(review: PlanReview) {
  return `Plan review of ${review.item} (plan ${review.digest}): ${review.verdict} by ${review.by}${review.note ? `: ${review.note}` : ''}`;
}

/** One initiative in full, for its manager and the person. */
export function initiativeText(view: InitiativeView) {
  const approval = view.approval ? `approved by ${view.approval.by} for revision ${view.approval.revision}` : 'not approved';
  const lines = [
    `${view.id}: ${view.title} [${view.status}; revision ${view.revision}; ${approval}]`,
    `Goal: ${view.goal}`,
    `Why: ${view.rationale}`,
    'Assignments:',
    ...view.assignments.map(assignmentLine),
    ...view.feedback.map(entry => `Sent back by ${entry.by} (revision ${entry.revision}): ${entry.note}`),
    ...view.escalations.map(escalationLine),
    ...view.planReviews.map(planReviewLine),
  ];
  if (view.outcome) lines.push(`Outcome: ${view.outcome}`);
  return lines.join('\n');
}

/** Initiatives, one line each. */
export function initiativesText(views: readonly InitiativeView[]) {
  if (!views.length) return 'No initiatives.';
  return views.map(view => {
    const merged = view.assignments.filter(assignment => assignment.state === 'completed').length;
    const open = view.escalations.filter(escalation => !escalation.resolution).length;
    const escalations = open ? `; ${open} open escalation${open === 1 ? '' : 's'}` : '';
    return `- ${view.id} [${view.status}]: ${view.title} (${merged}/${view.assignments.length} merged${escalations})`;
  }).join('\n');
}

const FINISHED_INITIATIVES = new Set(['completed', 'failed', 'cancelled']);

/** A manager's status section: open initiatives, and those that finished recently. Empty when there are none. */
export function initiativeSection(views: readonly InitiativeView[], ownerId: string, now = new Date()) {
  const since = now.getTime() - STATUS_LIMITS.recentDays * 24 * 60 * 60 * 1000;
  const shown = views.filter(view => view.owner === ownerId && (!FINISHED_INITIATIVES.has(view.status) || Date.parse(view.updatedAt) >= since));
  if (!shown.length) return '';
  return `Your initiatives (onionsoup_initiative show <id> for detail):\n${initiativesText(shown)}`;
}
