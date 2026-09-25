import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import type { ChatOrigin } from '../src/chat-origin.ts';
import { recentJournal } from '../src/chat-context.ts';
import { deskState } from '../src/desk.ts';
import { NOTICE_PREFIX } from '../src/notices.ts';
import type { OwnerSessionClient } from '../src/owner-sessions.ts';
import { cancelReminder, openDueReminders, setReminder } from '../src/reminder-work.ts';
import { REMINDER_LIMITS } from '../src/reminders.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';

const declarations = 'packages/owners/test/fixtures/owners';
const DAY_MS = 86_400_000;
const proposal = { title: 'Stage Coder on minideb', goal: 'Run Coder', rationale: 'Workspaces', acceptance: ['Coder answers'], size: 'small' as const };

async function reminderHooks() {
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-reminders-'));
  const hooks = await withActiveHooks({} as Parameters<Plugin>[0], { declarations, state });
  const runtime = await Runtime.open({ declarations, state });
  return { hooks, runtime };
}

function toolContext(agent = 'Miles Teg') {
  return {
    agent, sessionID: 'ses_chat', messageID: 'msg_1', directory: '/desk', worktree: '/desk',
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  };
}

/** opencode as the reminder opener sees it: sessions and prompts are recorded, nothing runs. */
function scriptedSessions(isPromptFailing = false) {
  const created: { directory: string; title: string }[] = [];
  const prompts: { target: ChatOrigin; agent: string; text: string }[] = [];
  const removed: string[] = [];
  const client: OwnerSessionClient = {
    create: async (directory, title) => {
      created.push({ directory, title });
      return `ses_reminder_${created.length}`;
    },
    prompt: async (target, agent, text) => {
      if (isPromptFailing) throw new Error('owner_session_prompt_failed');
      prompts.push({ target, agent, text });
    },
    remove: async target => {
      removed.push(target.sessionID);
    },
  };
  return { client, created, prompts, removed };
}

async function journalKinds(runtime: Runtime, ownerId: string, kind: string) {
  return (await recentJournal(runtime, ownerId)).filter(entry => entry.kind === kind);
}

function overrideLimit(context: TestContext, key: keyof typeof REMINDER_LIMITS, value: number) {
  const previous = REMINDER_LIMITS[key];
  context.after(() => { REMINDER_LIMITS[key] = previous; });
  REMINDER_LIMITS[key] = value;
}

test('an owner sets a reminder from chat: it is pending with the chat as its origin, journaled, and in its status', async () => {
  const { hooks, runtime } = await reminderHooks();
  const item = await runtime.ledger.create('homelab', 'owner-change', proposal, { status: 'landed' });
  const remind = hooks.tool!.onionsoup_remind!;
  const prompt = 'Verify Coder backups on minideb keep exactly 14 days.';
  const answer = await remind.execute({ action: 'set', after: '15d', prompt, item: item.id }, toolContext() as never);
  const [reminder] = await runtime.reminders.list();
  assert.match(String(answer), new RegExp(`Set ${reminder!.id}`));
  assert.equal(reminder!.status, 'pending');
  assert.equal(reminder!.owner, 'homelab');
  assert.equal(reminder!.item, item.id);
  assert.deepEqual(reminder!.origin, { sessionID: 'ses_chat', directory: '/desk' });
  const delay = Date.parse(reminder!.dueAt) - Date.parse(reminder!.createdAt);
  assert.ok(Math.abs(delay - 15 * DAY_MS) < 60_000, 'due fifteen days after it was set');
  const [journaled] = await journalKinds(runtime, 'homelab', 'reminder-set');
  assert.equal(journaled?.note, prompt);
  assert.equal(journaled?.workItem, item.id);
  const status = String(await hooks.tool!.onionsoup_status!.execute({}, toolContext() as never));
  assert.match(status, new RegExp(`Your reminders[^]*- ${reminder!.id} due ${reminder!.dueAt} \\(${item.id}\\): Verify Coder backups`));
  const listed = String(await remind.execute({ action: 'list' }, toolContext() as never));
  assert.match(listed, new RegExp(reminder!.id));
  const desk = await deskState(runtime, { owner: 'homelab' });
  assert.deepEqual(desk.owner && desk.reminders, [{ id: reminder!.id, prompt, item: item.id, dueAt: reminder!.dueAt, createdAt: reminder!.createdAt }]);
});

test('reminders are refused past each limit, for another owner\'s work, and for agents that are not owners', async context => {
  const { hooks, runtime } = await reminderHooks();
  const remind = hooks.tool!.onionsoup_remind!;
  const set = (args: Record<string, string>, agent?: string) => remind.execute({ action: 'set', prompt: 'Check it', ...args }, toolContext(agent) as never);
  await assert.rejects(set({}), /reminder_time_required/);
  await assert.rejects(set({ after: '1d', at: '2026-12-01' }), /reminder_time_ambiguous/);
  await assert.rejects(set({ after: 'soon' }), /reminder_invalid: after/);
  await assert.rejects(set({ at: 'next tuesday' }), /reminder_time_invalid/);
  await assert.rejects(set({ after: '2m' }), /reminder_too_soon/);
  await assert.rejects(set({ after: '91d' }), /reminder_too_far/);
  const bellondaItem = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'landed' });
  await assert.rejects(set({ after: '1d', item: bellondaItem.id }), /reminder_item_not_yours/);
  await assert.rejects(set({ after: '1d', item: 'w-20260925-000000' }), /reminder_item_unknown/);
  await assert.rejects(set({ after: '1d' }, 'onionsoup-implementer'), /not one/);
  overrideLimit(context, 'promptChars', 10);
  await assert.rejects(set({ after: '1d', prompt: 'Check the backups kept' }), /reminder_prompt_too_long/);
  overrideLimit(context, 'maxPendingPerOwner', 1);
  await set({ after: '1d' });
  await assert.rejects(set({ after: '2d' }), /reminder_limit_reached/);
  assert.equal((await runtime.reminders.list()).length, 1, 'only the reminder within the limits is recorded');
  assert.equal((await journalKinds(runtime, 'homelab', 'reminder-set')).length, 1);
});

test('a due reminder opens one owner session with its prompt and item; a future one waits and a second pass opens nothing', async () => {
  const { runtime } = await reminderHooks();
  const reportItem = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'landed' });
  const origin = { sessionID: 'ses_chat', directory: '/chat' };
  const due = await setReminder(runtime, 'odrade', { after: '15d', prompt: 'Check that Bellonda\'s Coder backups keep 14 days.', item: reportItem.id }, origin);
  const later = await setReminder(runtime, 'odrade', { after: '30d', prompt: 'Review the rollout.' });
  const sessions = scriptedSessions();
  const errors: unknown[] = [];
  await openDueReminders(runtime, sessions.client, (_id, error) => errors.push(error));
  assert.equal(sessions.created.length, 0, 'nothing is due yet');
  const inSixteenDays = new Date(Date.now() + 16 * DAY_MS);
  await openDueReminders(runtime, sessions.client, (_id, error) => errors.push(error), inSixteenDays);
  await openDueReminders(runtime, sessions.client, (_id, error) => errors.push(error), inSixteenDays);
  assert.deepEqual(errors, []);
  assert.equal(sessions.created.length, 1, 'fired once');
  assert.equal(sessions.created[0]!.title, 'Reminder: Check that Bellonda\'s Coder backups keep 14 days.');
  const [prompt] = sessions.prompts;
  assert.equal(prompt!.agent, 'Odrade');
  assert.ok(prompt!.text.startsWith(`${NOTICE_PREFIX} You set this reminder on ${due.createdAt}: Check that Bellonda`));
  assert.ok(prompt!.text.includes(`${reportItem.id}: Stage Coder on minideb`), 'the item\'s record is in the prompt');
  assert.match(prompt!.text, /onionsoup_record_fact/);
  const fired = await runtime.reminders.get(due.id);
  assert.equal(fired.status, 'fired');
  assert.deepEqual(fired.session, { sessionID: 'ses_reminder_1', directory: sessions.created[0]!.directory });
  assert.ok(fired.firedAt);
  assert.equal((await runtime.reminders.get(later.id)).status, 'pending');
  const [journaled] = await journalKinds(runtime, 'odrade', 'reminder-fired');
  assert.equal(journaled?.outcome, due.id);
  assert.equal(journaled?.session, 'ses_reminder_1');
});

test('a reminder whose prompt fails is released for the next pass and its session removed', async () => {
  const { runtime } = await reminderHooks();
  const reminder = await setReminder(runtime, 'odrade', { after: '1d', prompt: 'Check the rollout settled.' });
  const failing = scriptedSessions(true);
  const errors: string[] = [];
  const tomorrow = new Date(Date.now() + 2 * DAY_MS);
  await openDueReminders(runtime, failing.client, id => errors.push(id), tomorrow);
  assert.deepEqual(errors, [reminder.id]);
  assert.deepEqual(failing.removed, ['ses_reminder_1']);
  const released = await runtime.reminders.get(reminder.id);
  assert.equal(released.status, 'pending');
  assert.equal(released.session, undefined);
  assert.equal((await journalKinds(runtime, 'odrade', 'reminder-fired')).length, 0);
  const working = scriptedSessions();
  await openDueReminders(runtime, working.client, id => errors.push(id), tomorrow);
  assert.equal((await runtime.reminders.get(reminder.id)).status, 'fired', 'the next pass opens it');
});

test('an owner cancels its own reminder, which then never fires; a fired or another owner\'s reminder cannot be cancelled', async () => {
  const { hooks, runtime } = await reminderHooks();
  const remind = hooks.tool!.onionsoup_remind!;
  await remind.execute({ action: 'set', after: '1d', prompt: 'Check the snapshot.' }, toolContext() as never);
  const [reminder] = await runtime.reminders.list();
  const odradeReminder = await setReminder(runtime, 'odrade', { after: '1d', prompt: 'Review the org.' });
  await assert.rejects(remind.execute({ action: 'cancel', id: odradeReminder.id }, toolContext() as never), /reminder_not_yours/);
  assert.match(String(await remind.execute({ action: 'cancel', id: reminder!.id, reason: 'Snapshot already verified' }, toolContext() as never)), /Cancelled/);
  const cancelled = await runtime.reminders.get(reminder!.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled?.by, 'owner:homelab');
  assert.equal(cancelled.cancelled?.note, 'Snapshot already verified');
  assert.equal((await journalKinds(runtime, 'homelab', 'reminder-cancelled'))[0]?.note, 'Snapshot already verified');
  const sessions = scriptedSessions();
  await openDueReminders(runtime, sessions.client, () => {}, new Date(Date.now() + 2 * DAY_MS));
  assert.deepEqual(sessions.created.map(session => session.title), ['Reminder: Review the org.'], 'the cancelled reminder never fires');
  await assert.rejects(cancelReminder(runtime, odradeReminder.id, 'tester'), /reminder_not_pending: .* is fired/);
  assert.equal(String(await remind.execute({ action: 'list' }, toolContext() as never)), 'You have no pending reminders.');
});
