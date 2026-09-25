import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { Span } from './span.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

/**
 * A reminder is a one-off wake-up an owner sets for itself: "check the backups once 14 days of them exist". Host code
 * keeps the time; when it is due, the plugin opens a fresh owner session with the owner's own prompt. A reminder
 * grants nothing: whatever the owner then does goes through the usual gates. Recurring checks stay config duties.
 * This module is the record; reminder-work.ts sets, cancels and fires them.
 */
export const REMINDER_LIMITS = { maxPendingPerOwner: 20, minDelayMinutes: 5, maxDelayDays: 90, promptChars: 2_000, titleChars: 60, lineChars: 160 };

/** Journal kinds reminders write; activity views and chat context show them. */
export const REMINDER_JOURNAL_KINDS = ['reminder-set', 'reminder-fired', 'reminder-cancelled'] as const;

export const ReminderStatus = z.enum(['pending', 'fired', 'cancelled']);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const Reminder = z.object({
  id: z.string(),
  owner: z.string(),
  prompt: z.string(),
  /** A work item the reminder is about: its record goes into the prompt when it fires. */
  item: z.string().optional(),
  dueAt: z.string(),
  status: ReminderStatus,
  /** The chat the owner set it from. */
  origin: ChatOrigin.optional(),
  /** The session it fired into. */
  session: ChatOrigin.optional(),
  firedAt: z.string().optional(),
  cancelled: z.object({ by: z.string(), at: z.string(), note: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Reminder = z.infer<typeof Reminder>;

/** What an owner asks for: a delay (after, like a duty's every) or a moment (at), a prompt, and optionally an item. */
export const ReminderRequest = z.object({
  after: Span.optional(),
  at: z.string().optional(),
  prompt: z.string().trim().min(1),
  item: z.string().optional(),
});
export type ReminderRequest = z.infer<typeof ReminderRequest>;

/** Parse a reminder request from chat input, naming every problem the owner needs to fix. */
export function parseReminderRequest(value: unknown) {
  const parsed = ReminderRequest.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`reminder_invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
}

/** What the surface shows of a reminder; the chat directories stay host-side. */
export type ReminderSummary = Pick<Reminder, 'id' | 'prompt' | 'item' | 'dueAt' | 'createdAt'>;

export function reminderSummary({ id, prompt, item, dueAt, createdAt }: Reminder): ReminderSummary {
  return { id, prompt, item, dueAt, createdAt };
}

const REMINDER_ID = /^m-\d{8}-[0-9a-f]{6}$/;

export class Reminders {
  constructor(readonly directory: string) {}

  async open(owner: string, fields: Pick<Reminder, 'prompt' | 'item' | 'dueAt' | 'origin'>) {
    const now = new Date().toISOString();
    const id = `m-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`;
    const reminder = Reminder.parse({ ...fields, id, owner, status: 'pending', createdAt: now, updatedAt: now });
    return withRecordLock(`${this.path(id)}.lock`, () => this.write(reminder));
  }

  async get(id: string) {
    if (!REMINDER_ID.test(id)) throw new Error(`reminder_invalid_id: ${id}`);
    return Reminder.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const records = await Promise.allSettled(names.map(name => this.get(name.slice(0, -'.json'.length))));
    const reminders: Reminder[] = [];
    for (const [index, record] of records.entries()) {
      if (record.status === 'fulfilled') reminders.push(record.value);
      else console.warn(`reminder_record_unreadable: ${names[index]}`);
    }
    return reminders.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  /** Read and change the latest record under a cross-process lock; never hold it across effects. */
  async update(id: string, change: (current: Reminder) => Reminder) {
    return withRecordLock(`${this.path(id)}.lock`, async () => this.write(Reminder.parse(change(await this.get(id)))));
  }

  private async write(reminder: Reminder) {
    await mkdir(this.directory, { recursive: true });
    const updated = { ...reminder, updatedAt: new Date().toISOString() };
    const temporary = `${this.path(reminder.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path(reminder.id));
    return updated;
  }

  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
}

export function isDue(reminder: Reminder, now: Date) {
  return reminder.status === 'pending' && Date.parse(reminder.dueAt) <= now.getTime();
}

/** An owner's pending reminders, soonest first. */
export async function pendingReminders(runtime: Runtime, ownerId: string) {
  return (await runtime.reminders.list()).filter(reminder => reminder.owner === ownerId && reminder.status === 'pending');
}
