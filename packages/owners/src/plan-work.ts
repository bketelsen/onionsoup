import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatOrigin } from './chat-origin.ts';
import type { PlanDocument, WorkItem, WorkStatus } from './ledger.ts';
import { NOTICE_PREFIX, queueNotice } from './notices.ts';
import type { Runtime } from './runtime.ts';

/**
 * An owner's plan as a work item. The owner brainstorms and writes the plan itself, submits it, and the person (or,
 * for delegated work, a manager under a standing grant) approves it; host code records who. An approved plan runs in
 * a new owner session, which ends by proposing its desk changes for this item: verification, the required
 * cross-family review and publication then happen in host code, as for any desk change.
 */
export const OWNER_CHANGE_WORKFLOW = 'owner-change';

/** The chat permission the person answers to approve a plan. Nothing may answer it on their behalf. */
export const PLAN_APPROVAL_PERMISSION = 'onionsoup_plan_approval';

export const PlanSubmission = z.object({
  title: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  plan: z.string().trim().min(1),
  repository: z.string().optional(),
  item: z.string().optional(),
});
export type PlanSubmission = z.infer<typeof PlanSubmission>;

export function planDocument(markdown: string): PlanDocument {
  return { markdown, digest: createHash('sha256').update(markdown).digest('hex').slice(0, 16) };
}

/** Work another owner asked for (or a manager assigned) has no chat of the person's: its plan goes to the inbox. */
export function isDelegated(item: WorkItem) {
  return Boolean(item.request || item.assignment);
}

const RESUBMITTABLE = new Set<WorkStatus>(['planning', 'awaiting-plan-approval']);

function requireResubmittable(item: WorkItem, ownerId: string) {
  if (item.owner !== ownerId) throw new Error(`plan_item_not_yours: ${item.id} belongs to ${item.owner}`);
  if (item.workflow !== OWNER_CHANGE_WORKFLOW) throw new Error(`not_an_owner_plan: ${item.id} is ${item.workflow} work`);
  if (!RESUBMITTABLE.has(item.status) || item.activeRunner) throw new Error(`plan_not_resubmittable: ${item.id} is ${item.status}`);
}

function proposalOf(submission: PlanSubmission, repository: string | undefined) {
  return {
    title: submission.title, goal: submission.goal, rationale: 'Planned by its owner', size: 'medium' as const,
    acceptance: ['The approved plan is carried out, verified and reviewed'], repository,
  };
}

async function resubmit(runtime: Runtime, ownerId: string, submission: PlanSubmission, origin: ChatOrigin) {
  return runtime.ledger.update(submission.item!, current => {
    requireResubmittable(current, ownerId);
    const repository = submission.repository ?? current.proposal.repository;
    return {
      ...current, status: 'awaiting-plan-approval', reason: undefined, planDocument: planDocument(submission.plan),
      proposal: { ...current.proposal, title: submission.title, goal: submission.goal, repository },
      origin: current.origin ?? origin,
    };
  });
}

/** Record the plan as a work item awaiting approval: a new one, or a revision of the owner's own. */
export async function submitPlan(runtime: Runtime, ownerId: string, submission: PlanSubmission, origin: ChatOrigin) {
  const repository = submission.repository ?? (submission.item ? (await runtime.ledger.get(submission.item)).proposal.repository : undefined);
  runtime.repositoryOwner(ownerId, repository);
  const item = submission.item
    ? await resubmit(runtime, ownerId, submission, origin)
    : await runtime.ledger.create(ownerId, OWNER_CHANGE_WORKFLOW, proposalOf(submission, repository), {
      status: 'awaiting-plan-approval', planDocument: planDocument(submission.plan), origin,
    });
  const notebook = runtime.notebook(ownerId);
  await notebook.journal({ kind: 'plan-submitted', workItem: item.id, note: submission.title, session: origin.sessionID });
  await notebook.commit(`journal ${item.id}`).catch(() => undefined);
  return item;
}

/** The person sent the plan back in chat: it stays awaiting approval, with their words for the revision. */
export async function recordPlanFeedback(runtime: Runtime, itemId: string, by: string, feedback: string) {
  const note = feedback.trim() || 'sent back without a note; ask the person what to change';
  const item = await runtime.ledger.update(itemId, current => ({
    ...current, humanNotes: [...current.humanNotes, { kind: 'plan-feedback', by, at: new Date().toISOString(), note }],
  }));
  await runtime.notebook(item.owner).journal({ kind: 'plan-feedback', workItem: itemId, note: `${by}: ${note}` });
  return item;
}

/** Wake the owner about its plan work in the session doing it, or the chat it came from. */
export async function tellOwner(runtime: Runtime, item: WorkItem, change: string, text: string) {
  const origin = item.session ?? item.origin;
  await runtime.notebook(item.owner).journal({ kind: 'work-status', workItem: item.id, outcome: change, note: text.slice(0, 500) });
  if (!origin) return;
  await queueNotice(runtime, {
    id: `${item.id}-${change}-${randomUUID().slice(0, 8)}`, owner: item.owner, workItem: item.id, change, text, origin,
    at: new Date().toISOString(),
  });
}

function notesOf(item: WorkItem, kind: WorkItem['humanNotes'][number]['kind']) {
  return item.humanNotes.filter(note => note.kind === kind).map(note => `- ${note.by}: ${note.note}`).join('\n');
}

function repositoryLine(item: WorkItem) {
  return item.proposal.repository ? `, repository "${item.proposal.repository}"` : '';
}

/** The first message of the session that carries out an approved plan. */
export function executionPrompt(item: WorkItem) {
  const conditions = notesOf(item, 'approval');
  return [
    `${NOTICE_PREFIX} ${item.planApproval?.by ?? 'The person'} approved your plan ${item.id} "${item.proposal.title}". This session carries it out.`,
    `Run it with the subagent-driven-development skill on your desk: one small task at a time, an implementer subagent
for each and your reviewer subagent after each. Make the rulings the plan leaves open yourself and record them with
onionsoup_record_fact or onionsoup_record_decision; stop for the person only for what only they can decide. When every
task is done and verified, end with onionsoup_propose_changes with item "${item.id}"${repositoryLine(item)}: host code
verifies, has another model family review the whole diff, and opens the PR.`,
    conditions && `<conditions-of-approval>\n${conditions}\n</conditions-of-approval>`,
    `<approved-plan>\n${item.planDocument?.markdown ?? item.proposal.goal}\n</approved-plan>`,
  ].filter(Boolean).join('\n\n');
}

/** The first message of the session where an owner plans work another owner asked for, with nobody in the chat. */
export function planningPrompt(item: WorkItem) {
  const who = item.assignment ? `Your manager assigned this work (initiative ${item.assignment.initiative}, assignment ${item.assignment.assignment})` : 'Another owner asked for this work';
  return [
    `${NOTICE_PREFIX} ${who}${item.request ? ` in request ${item.request}` : ''}; you accepted it as ${item.id}. Nobody is in this chat.`,
    `Brainstorm it alone with the brainstorming skill (record the assumptions you make), write the plan with the
writing-plans skill, and submit it with onionsoup_submit_plan with item "${item.id}"${repositoryLine(item)}. The plan is
approved in the person's inbox, or by your manager under a standing grant; an approved plan starts its own session.
If the work is wrong or you cannot do it, say so${item.assignment ? ' with onionsoup_raise' : ''} instead of planning something else.`,
    `<requested-work>\nTitle: ${item.proposal.title}\nGoal: ${item.proposal.goal}\nWhy: ${item.proposal.rationale}\nAcceptance:\n${item.proposal.acceptance.map(entry => `- ${entry}`).join('\n')}\n</requested-work>`,
  ].join('\n\n');
}
