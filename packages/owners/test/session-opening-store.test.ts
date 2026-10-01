import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionOpeningStore } from '../src/session-opening-store.ts';
import { Runtime } from '../src/runtime.ts';
import { openOwnerSession, type OwnerSessionClient } from '../src/owner-sessions.ts';
import { openReminderSession } from '../src/reminder-work.ts';
import type { MaintenanceContext } from '../src/maintenance-context.ts';

const declarations = 'packages/owners/test/fixtures/owners';
const proposal = { title: 'Review progress', goal: 'Inspect status', rationale: 'Requested review', acceptance: ['Report findings'], size: 'small' as const };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function maintenance(controller: AbortController): MaintenanceContext {
  const check = () => controller.signal.throwIfAborted();
  return { signal: controller.signal, check, phase: async (_name, operation) => {
    check();
    const value = await operation();
    check();
    return value;
  } };
}
async function setup(entity: 'owner-item' | 'reminder') {
  const home = await mkdtemp(join(tmpdir(), 'session-opening-'));
  const runtime = await Runtime.open({ declarations, state: join(home, 'state') });
  await runtime.notebook('odrade').ensureJournal();
  const item = await runtime.ledger.create('odrade', 'owner-change', proposal, { status: 'planning' });
  const reminder = await runtime.reminders.open('odrade', { prompt: 'Inspect progress', dueAt: new Date(0).toISOString() });
  const key = { entity, owner: 'odrade', id: entity === 'owner-item' ? item.id : reminder.id,
    kind: entity === 'owner-item' ? 'planning' as const : 'reminder' as const };
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const calls = { creates: 0, prompts: 0, removes: 0 };
  const client: OwnerSessionClient = {
    create: async () => { calls.creates++; return `ses_created_${calls.creates}`; },
    prompt: async (_origin, _agent, _text, messageID) => {
      calls.prompts++;
      const record = (await store.read(key))!;
      assert.equal(record.phase, 'prompting');
      assert.equal(messageID, record.messageID);
    },
    remove: async () => { calls.removes++; },
    activity: async () => ({ isBusy: false, updatedAt: undefined }),
  };
  const open = (context?: MaintenanceContext) => entity === 'owner-item'
    ? openOwnerSession(runtime, client, item.id, context)
    : openReminderSession(runtime, client, reminder, context);
  return { runtime, item, reminder, key, store, calls, client, open };
}

for (const entity of ['owner-item', 'reminder'] as const) {
  test(`${entity} reserves before create and protects concurrent and replacement openers`, async () => {
    const context = await setup(entity);
    const entered = deferred();
    const release = deferred();
    context.client.create = async () => {
      context.calls.creates++;
      assert.equal((await context.store.read(context.key))!.phase, 'creating');
      entered.resolve();
      await release.promise;
      return 'ses_exact';
    };
    const first = context.open();
    await entered.promise;
    assert.equal(await context.open(), undefined);
    const reopened = new SessionOpeningStore(context.runtime.stateDirectory);
    assert.equal(await reopened.reserve(context.key), undefined);
    release.resolve();
    assert.equal((await first)!.sessionID, 'ses_exact');
    assert.equal((await reopened.read(context.key))!.phase, 'opened');
    assert.deepEqual(context.calls, { creates: 1, prompts: 1, removes: 0 });
    assert.equal(await context.open(), undefined);
  });

  test(`${entity} ambiguous create is durable and never becomes a replacement session`, async () => {
    const context = await setup(entity);
    context.client.create = async () => { context.calls.creates++; throw new Error('response_lost_after_create'); };
    await assert.rejects(context.open(), /response_lost/);
    const saved = (await context.store.read(context.key))!;
    assert.equal(saved.phase, 'uncertain');
    assert.equal(saved.origin, undefined);
    assert.equal(await context.open(), undefined);
    assert.equal(await new SessionOpeningStore(context.runtime.stateDirectory).reserve(context.key), undefined);
    assert.deepEqual(context.calls, { creates: 1, prompts: 0, removes: 0 });
  });

  test(`${entity} ambiguous prompt retains exact session and immutable intent without delete or requeue`, async () => {
    const context = await setup(entity);
    context.client.prompt = async () => { context.calls.prompts++; throw new Error('response_lost_after_prompt'); };
    await assert.rejects(context.open(), /response_lost/);
    const saved = (await context.store.read(context.key))!;
    assert.equal(saved.phase, 'uncertain');
    assert.equal(saved.origin!.sessionID, 'ses_created_1');
    assert.equal(await context.open(), undefined);
    assert.deepEqual(await context.store.read(context.key), saved);
    assert.deepEqual(context.calls, { creates: 1, prompts: 1, removes: 0 });
    if (entity === 'reminder') {
      const reminder = await context.runtime.reminders.get(context.reminder.id);
      assert.equal(reminder.status, 'pending');
      assert.deepEqual(reminder.session, saved.origin);
    } else assert.deepEqual((await context.runtime.ledger.get(context.item.id)).origin, saved.origin);
  });

  test(`${entity} late create identity survives disposal without starting a prompt or replacement`, async () => {
    const context = await setup(entity);
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    context.client.create = async () => {
      context.calls.creates++;
      entered.resolve();
      await release.promise;
      return 'ses_late_receipt';
    };
    const pending = context.open(maintenance(controller));
    const rejected = assert.rejects(pending);
    await entered.promise;
    controller.abort();
    assert.equal(await context.open(), undefined);
    release.resolve();
    await rejected;
    const saved = (await context.store.read(context.key))!;
    assert.equal(saved.phase, 'uncertain');
    assert.equal(saved.origin!.sessionID, 'ses_late_receipt');
    assert.equal(await context.open(), undefined);
    assert.deepEqual(context.calls, { creates: 1, prompts: 0, removes: 0 });
  });
}

test('a proven pre-create failure may retry with a fenced token while retaining previous attempt history', async () => {
  const context = await setup('owner-item');
  const original = (await context.store.reserve(context.key))!;
  await context.store.failed(original);
  const retry = (await context.store.reserve(context.key))!;
  assert.notEqual(retry.token, original.token);
  assert.deepEqual(retry.history.slice(0, 2).map(entry => entry.phase), ['reserved', 'blocked']);
  await assert.rejects(context.store.advance(original, 'creating'), /reservation_changed/);
  await context.store.advance(retry, 'creating', { directory: '/fixture' });
  await context.store.failed(retry);
  assert.equal(await context.store.reserve(context.key), undefined);
});

test('an already stopped maintenance context cannot reserve or open any session', async () => {
  for (const entity of ['owner-item', 'reminder'] as const) {
    const context = await setup(entity);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(context.open(maintenance(controller)));
    assert.equal(await context.store.read(context.key), undefined);
    assert.deepEqual(context.calls, { creates: 0, prompts: 0, removes: 0 });
  }
});

test('a timed-out create phase retains its late receipt after the caller has already failed', async () => {
  const context = await setup('reminder');
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const settled = deferred();
  context.client.create = async () => {
    context.calls.creates++;
    entered.resolve();
    await release.promise;
    return 'ses_after_timeout';
  };
  const lifecycle = maintenance(controller);
  lifecycle.phase = async (name, operation) => {
    lifecycle.check();
    if (name !== 'session-create') return operation();
    const late = operation().finally(() => settled.resolve());
    const stopped = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('maintenance_timed_out')), { once: true });
    });
    return Promise.race([late, stopped]);
  };
  const pending = context.open(lifecycle);
  const rejection = assert.rejects(pending, /maintenance_timed_out/);
  await entered.promise;
  controller.abort();
  await rejection;
  assert.equal((await context.store.read(context.key))!.phase, 'uncertain');
  assert.equal((await context.store.read(context.key))!.origin, undefined);
  assert.equal(await context.open(), undefined);
  release.resolve();
  await settled.promise;
  const recorded = (await context.store.read(context.key))!;
  assert.equal(recorded.phase, 'uncertain');
  assert.equal(recorded.origin!.sessionID, 'ses_after_timeout');
  assert.equal(await context.open(), undefined);
  assert.deepEqual(context.calls, { creates: 1, prompts: 0, removes: 0 });
});

test('an actual pre-create placement failure retries safely without discarding its audit history', async () => {
  const context = await setup('reminder');
  const controller = new AbortController();
  const lifecycle = maintenance(controller);
  lifecycle.phase = async (name, operation) => {
    if (name === 'chat-place') throw new Error('fixture_place_unavailable');
    return operation();
  };
  await assert.rejects(context.open(lifecycle), /fixture_place_unavailable/);
  const failed = (await context.store.read(context.key))!;
  assert.equal(failed.phase, 'blocked');
  assert.equal(context.calls.creates, 0);
  await context.open();
  const opened = (await context.store.read(context.key))!;
  assert.equal(opened.phase, 'opened');
  assert.notEqual(opened.token, failed.token);
  assert.deepEqual(opened.history.slice(0, failed.history.length), failed.history);
  assert.deepEqual(context.calls, { creates: 1, prompts: 1, removes: 0 });
});
