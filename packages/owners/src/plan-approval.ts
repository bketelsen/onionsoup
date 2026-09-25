import { userInfo } from 'node:os';
import type { ToolContext } from '@opencode-ai/plugin';
import type { WorkItem } from './ledger.ts';
import { openOwnerSession, type OwnerSessionClient } from './owner-sessions.ts';
import { isDelegated, PLAN_APPROVAL_PERMISSION, recordPlanFeedback } from './plan-work.ts';
import type { Runtime } from './runtime.ts';
import { approvePlan } from './work-recovery.ts';

/**
 * The person approves an owner's plan in the chat it was submitted from, through opencode's permission prompt. The
 * tool asks and host code records the answer, so a model cannot approve its own plan; the surface never answers this
 * prompt on the person's behalf.
 */
type AskContext = Pick<ToolContext, 'ask' | 'abort' | 'metadata'>;

/** opencode rejects with the person's note in its message when they send a prompt back with one. */
function feedbackOf(rejection: unknown) {
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  return /feedback:\s*([\s\S]*)$/.exec(message)?.[1]?.trim() ?? '';
}

async function askPerson(item: WorkItem, context: AskContext) {
  context.metadata({ title: `plan ${item.id}: ${item.proposal.title}` });
  const metadata = { item: item.id, title: item.proposal.title, plan: item.planDocument?.markdown ?? '' };
  const rejection = await context.ask({ permission: PLAN_APPROVAL_PERMISSION, patterns: [item.id], always: [], metadata })
    .then(() => undefined, (error: unknown) => error ?? new Error('plan_approval_rejected'));
  if (context.abort.aborted) throw new Error('plan_approval_aborted');
  return rejection;
}

async function sentBack(runtime: Runtime, item: WorkItem, person: string, rejection: unknown) {
  const revised = await recordPlanFeedback(runtime, item.id, person, feedbackOf(rejection));
  const note = revised.humanNotes.at(-1)!.note;
  return `The person did not approve plan ${item.id}: ${note}. Revise it with them and submit it again with item "${item.id}".`;
}

async function approved(runtime: Runtime, sessions: OwnerSessionClient, item: WorkItem, person: string) {
  await approvePlan(runtime, item.id, person);
  const session = await openOwnerSession(runtime, sessions, item.id).catch((error: unknown) => {
    console.warn('owner_session_failed', item.id, error);
    return undefined;
  });
  const where = session
    ? `It runs in its own session, "Plan ${item.id}: ${item.proposal.title}" (${session.sessionID})`
    : 'Its session could not be opened yet; the runtime retries shortly';
  return `${person} approved plan ${item.id}. ${where}, which ends by proposing the changes for this item. Tell the person; do not start the work in this chat.`;
}

/** Ask for approval of a submitted plan and record the answer; delegated plans wait in the inbox instead. */
export async function requestPlanApproval(runtime: Runtime, sessions: OwnerSessionClient, item: WorkItem, context: AskContext) {
  if (isDelegated(item)) {
    return `Submitted plan ${item.id}. Delegated work is approved in the person's inbox, or by your manager under a standing grant; an approved plan starts its own session.`;
  }
  const person = userInfo().username;
  const rejection = await askPerson(item, context);
  return rejection ? sentBack(runtime, item, person, rejection) : approved(runtime, sessions, item, person);
}
