import type { ChatOrigin } from './chat-origin.ts';
import { clipped } from './chat-context.ts';
import { isDirectReport, repositoryNames } from './declarations.ts';
import { itemText } from './desk.ts';
import type { WorkItem } from './ledger.ts';
import { NOTICE_PREFIX } from './notices.ts';
import { syncedChatPlace, type OwnerSessionClient } from './owner-sessions.ts';
import { isDue, pendingReminders, REMINDER_LIMITS, type Reminder, type ReminderRequest } from './reminders.ts';
import type { Runtime } from './runtime.ts';
import { spanMs } from './span.ts';

/**
 * What happens to reminders (reminders.ts is the record): an owner sets one within REMINDER_LIMITS, its owner or the
 * person cancels it, and the plugin opens it in a fresh owner session once it is due.
 */

/** When a request falls due, from whichever of after and at it names. */
const DUE_TIME: Record<'after' | 'at', (value: string, now: Date) => number> = {
  after: (value, now) => now.getTime() + spanMs(value),
  at: value => Date.parse(value),
};

function dueTime(request: ReminderRequest, now: Date) {
  const named = (['after', 'at'] as const).filter(key => request[key] !== undefined);
  if (!named.length) throw new Error('reminder_time_required: give after (e.g. 15d) or at (an ISO date or time)');
  if (named.length > 1) throw new Error('reminder_time_ambiguous: give after or at, not both');
  const key = named[0]!;
  const due = DUE_TIME[key](request[key]!, now);
  if (Number.isNaN(due)) throw new Error(`reminder_time_invalid: ${request[key]} is not an ISO date or time`);
  return due;
}

function checkDelay(due: number, now: Date) {
  const delay = due - now.getTime();
  if (delay < REMINDER_LIMITS.minDelayMinutes * 60_000) {
    throw new Error(`reminder_too_soon: a reminder is due at least ${REMINDER_LIMITS.minDelayMinutes} minutes from now`);
  }
  if (delay > REMINDER_LIMITS.maxDelayDays * 86_400_000) {
    throw new Error(`reminder_too_far: a reminder is due at most ${REMINDER_LIMITS.maxDelayDays} days from now`);
  }
}

/** A reminder may be about the owner's own work or a direct report's. */
async function checkItem(runtime: Runtime, ownerId: string, itemId: string) {
  const item = await runtime.ledger.get(itemId).catch(() => undefined);
  if (!item) throw new Error(`reminder_item_unknown: ${itemId}`);
  const isVisible = item.owner === ownerId || isDirectReport(runtime.declarations, ownerId, item.owner);
  if (!isVisible) throw new Error(`reminder_item_not_yours: ${itemId} belongs to ${item.owner}`);
}

async function checkRoom(runtime: Runtime, ownerId: string) {
  const pending = await pendingReminders(runtime, ownerId);
  if (pending.length >= REMINDER_LIMITS.maxPendingPerOwner) {
    throw new Error(`reminder_limit_reached: ${ownerId} has ${pending.length} pending reminders; cancel one first`);
  }
}

/** Set a reminder for an owner, within the limits, and journal it. */
export async function setReminder(runtime: Runtime, ownerId: string, request: ReminderRequest, origin?: ChatOrigin, now = new Date()) {
  if (request.prompt.length > REMINDER_LIMITS.promptChars) {
    throw new Error(`reminder_prompt_too_long: ${request.prompt.length} characters; at most ${REMINDER_LIMITS.promptChars}`);
  }
  const due = dueTime(request, now);
  checkDelay(due, now);
  if (request.item) await checkItem(runtime, ownerId, request.item);
  await checkRoom(runtime, ownerId);
  const dueAt = new Date(due).toISOString();
  const reminder = await runtime.reminders.open(ownerId, { prompt: request.prompt, item: request.item, dueAt, origin });
  await runtime.notebook(ownerId).journal({
    kind: 'reminder-set', note: request.prompt, outcome: `${reminder.id} due ${dueAt}`, workItem: request.item, session: origin?.sessionID,
  });
  return reminder;
}

/** Cancel a pending reminder: by its owner (owner:<id>) or by the person. */
export async function cancelReminder(runtime: Runtime, id: string, by: string, note = '') {
  const cancelled = await runtime.reminders.update(id, current => {
    if (current.status !== 'pending') throw new Error(`reminder_not_pending: ${id} is ${current.status}`);
    return { ...current, status: 'cancelled', cancelled: { by, at: new Date().toISOString(), note } };
  });
  await runtime.notebook(cancelled.owner).journal({
    kind: 'reminder-cancelled', note: note || cancelled.prompt, outcome: `${id} cancelled by ${by}`, workItem: cancelled.item,
  });
  return cancelled;
}

/**
 * Due reminders open on the surface's opencode, like the sessions plans need (owner-sessions.ts): the plugin checks
 * on its notice timer, and a claim under the reminder's lock makes exactly one server open each, once. A reminder
 * missed while the surface was down fires late.
 */
const REMINDER_CHOICES = `Decide what this needs now. Act through your usual tools (their gates still apply), record what you
found with onionsoup_record_fact, raise it for the person if it needs them, or, if it is still too early, set a new
reminder with onionsoup_remind. Say what you found and what you did.`;

/** The first message of a reminder's session, starting with the notice prefix: the runtime speaks, not the person. */
export function reminderPrompt(reminder: Reminder, item?: WorkItem) {
  const parts = [`${NOTICE_PREFIX} You set this reminder on ${reminder.createdAt}: ${reminder.prompt}`];
  if (item) parts.push(`The work it is about:\n${itemText(item)}`);
  parts.push(REMINDER_CHOICES);
  return parts.join('\n\n');
}

function reminderTitle(reminder: Reminder) {
  return `Reminder: ${clipped(reminder.prompt.replace(/\s+/g, ' ').trim(), REMINDER_LIMITS.titleChars)}`;
}

/** Record the session and mark the reminder fired, unless another opener got there first. */
async function claimReminder(runtime: Runtime, id: string, session: ChatOrigin) {
  try {
    return await runtime.reminders.update(id, current => {
      if (current.status !== 'pending') throw new Error('reminder_already_open');
      return { ...current, status: 'fired', session, firedAt: new Date().toISOString() };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'reminder_already_open') return undefined;
    throw error;
  }
}

async function releaseReminder(runtime: Runtime, id: string) {
  await runtime.reminders.update(id, current => ({ ...current, status: 'pending', session: undefined, firedAt: undefined }));
}

async function reminderItem(runtime: Runtime, reminder: Reminder) {
  return reminder.item ? runtime.ledger.get(reminder.item).catch(() => undefined) : undefined;
}

/** Open a fresh owner session for a due reminder and send its prompt; returns the session, if one was opened. */
export async function openReminderSession(runtime: Runtime, client: OwnerSessionClient, reminder: Reminder) {
  const owner = runtime.owner(reminder.owner);
  if (!owner.persona) return undefined;
  const { directory, note } = await syncedChatPlace(runtime, owner.id, repositoryNames(owner), reminder.id);
  const session = { sessionID: await client.create(directory, reminderTitle(reminder), []), directory };
  const claimed = await claimReminder(runtime, reminder.id, session);
  if (!claimed) {
    await client.remove(session).catch(() => undefined);
    return undefined;
  }
  try {
    await client.prompt(session, owner.persona.name, `${reminderPrompt(claimed, await reminderItem(runtime, claimed))}${note}`);
  } catch (error) {
    await releaseReminder(runtime, reminder.id);
    await client.remove(session).catch(() => undefined);
    throw error;
  }
  await runtime.notebook(owner.id).journal({
    kind: 'reminder-fired', note: claimed.prompt, outcome: claimed.id, workItem: claimed.item, session: session.sessionID,
  });
  return session;
}

/** Every due reminder of an owner with a persona, opened one at a time; a failure leaves it for the next pass. */
export async function openDueReminders(runtime: Runtime, client: OwnerSessionClient, onError: (id: string, error: unknown) => void, now = new Date()) {
  const hasPersona = (reminder: Reminder) => Boolean(runtime.declarations.owners.get(reminder.owner)?.persona);
  const due = (await runtime.reminders.list()).filter(reminder => isDue(reminder, now) && hasPersona(reminder));
  for (const reminder of due) await openReminderSession(runtime, client, reminder).catch(error => onError(reminder.id, error));
}
