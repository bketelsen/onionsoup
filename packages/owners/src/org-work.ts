import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { isDirectReport } from './declarations.ts';
import type { WorkItem } from './ledger.ts';
import { queueNotice, readNotice } from './notices.ts';
import { latestOwnerMessageTarget, ownerMessageId } from './owner-messages.ts';
import type { Runtime } from './runtime.ts';
import { cancelItem } from './work-recovery.ts';
import { managerWorkActor, resumePausedItem } from './work-pause.ts';

/**
 * A manager fans work out to her direct reports with onionsoup_request_work and follows it with onionsoup_status.
 * On work she requested she may cancel it, leave the report a note in that work's own session, or resume it after an
 * intentional pause (under the report's approve-plans grant). Plan review is direct-request-plan-review.ts.
 */
export const SteerInvocation = z.object({ origin: ChatOrigin, messageID: z.string().min(1) });
export type SteerInvocation = z.infer<typeof SteerInvocation>;
type Steer = (runtime: Runtime, managerId: string, item: WorkItem, note: string, invocation?: SteerInvocation) => Promise<string>;

/** The note reaches the report's work session (when it is idle) and is journaled once, however often it is retried. */
async function queueManagerNote(runtime: Runtime, managerId: string, item: WorkItem, note: string, invocation?: SteerInvocation) {
  const id = ownerMessageId(['manager-note', managerId, item.id, note, invocation]);
  const previous = await readNotice(runtime, id);
  const origin = previous ? previous.origin : item.session ?? item.origin ?? await latestOwnerMessageTarget(runtime, item.owner);
  const notice = await queueNotice(runtime, {
    id, owner: item.owner, workItem: item.id, change: 'manager-ruling', text: note, origin,
    sender: { owner: managerId, origin: invocation?.origin }, at: new Date().toISOString(),
  });
  await runtime.notebook(item.owner).journalOnce({
    kind: 'manager-note', workItem: item.id, source: id, note: `from ${managerId}: ${note}`,
  }, notice.at);
}

const STEERS: Record<'resume' | 'cancel' | 'note', Steer> = {
  resume: async (runtime, managerId, item, note) =>
    (await resumePausedItem(runtime, item.id, await managerWorkActor(runtime, managerId, item), note)).status,
  cancel: async (runtime, managerId, item, note) => (await cancelItem(runtime, item.id, `owner:${managerId}`, note)).status,
  note: async (runtime, managerId, item, note, invocation) => {
    await queueManagerNote(runtime, managerId, item, note, invocation);
    return 'queued to its work session';
  },
};
export type SteerAction = keyof typeof STEERS;
export const STEER_ACTIONS = Object.keys(STEERS) as SteerAction[];

/** A direct report's work item that this manager requested; nothing else is hers to steer. */
async function requestedReportItem(runtime: Runtime, managerId: string, itemId: string) {
  const item = await runtime.ledger.get(itemId).catch(() => undefined);
  const request = item?.request ? await runtime.requests.get(item.request).catch(() => undefined) : undefined;
  if (!item || request?.from !== managerId || request.to !== item.owner || !isDirectReport(runtime.declarations, managerId, item.owner)) {
    throw new Error(`not_your_report_item: ${itemId} is not work you requested from one of your direct reports`);
  }
  return item;
}

export async function steerReportItem(runtime: Runtime, managerId: string, itemId: string, action: SteerAction,
  note: string, source?: SteerInvocation) {
  if (!note.trim()) throw new Error(`steer_note_required: ${action} needs a note`);
  const item = await requestedReportItem(runtime, managerId, itemId);
  const invocation = source ? SteerInvocation.parse(source) : undefined;
  const outcome = await STEERS[action](runtime, managerId, item, note, invocation);
  for (const ownerId of new Set([managerId, item.owner])) {
    const notebook = runtime.notebook(ownerId);
    await notebook.journal({ kind: 'steered', note: `${itemId}: ${action} by ${managerId}: ${note}` });
    await notebook.commit('journal steered').catch(() => undefined);
  }
  return outcome;
}
