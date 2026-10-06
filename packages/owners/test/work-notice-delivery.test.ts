import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pendingNotices, queueNotice, readNotice } from '../src/notices.ts';
import { Runtime } from '../src/runtime.ts';
import { messageFixture } from './owner-message-fixture.ts';
import { humanWorkActor, pauseItem, resumeItem, settleItemPause } from '@onionsoup/owners';

async function fixture() {
  const context = await messageFixture();
  const origin = await context.addSession('homelab', 'fixture-chat');
  await queueNotice(context.runtime, { id: 'fixture-notice', owner: 'homelab', change: 'landed',
    text: 'Fixture work is ready.', origin, at: new Date().toISOString() });
  return context;
}

test('ambiguous work notice send retains identity and restart reconciles exact transcript acceptance without replay', async () => {
  const context = await fixture();
  context.setMode('lost-reply');
  const first = context.pass();
  await assert.rejects(context.deliver(context.runtime, first), /plugin_maintenance_effect_uncertain/);
  assert.equal((await context.receipts())[0].status, 'uncertain');
  assert.equal((await pendingNotices(context.runtime)).length, 1);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.runtime.stateDirectory });
  await context.deliver(reopened);
  assert.equal(context.sends.length, 1);
  assert.equal((await context.receipts())[0].status, 'sent');
  assert.deepEqual(await pendingNotices(reopened), []);
});

test('work notice claims are exclusive and a busy target queues until idle', async () => {
  const context = await fixture();
  context.busy.add('fixture-chat');
  await context.deliver();
  assert.equal(context.sends.length, 0);
  assert.equal((await pendingNotices(context.runtime)).length, 1);
  context.busy.clear();
  await Promise.all([context.deliver(), context.deliver()]);
  assert.equal(context.sends.length, 1);
  assert.equal((await context.receipts())[0].status, 'sent');
  const saved = await readNotice(context.runtime, 'fixture-notice');
  await queueNotice(context.runtime, { ...saved!, at: new Date().toISOString() });
  await context.deliver();
  assert.equal(context.sends.length, 1, 'same queue ID cannot resurrect delivered work');
});

test('stopping after preparation but before transport keeps one exact-ID safe retry', async () => {
  const context = await fixture();
  const first = context.pass();
  const check = first.check.bind(first);
  first.check = () => {
    if (existsSync(join(context.runtime.stateDirectory, 'notices', 'delivery'))) first.stop();
    check();
  };
  await assert.rejects(context.deliver(context.runtime, first), /plugin_maintenance_stopped/);
  assert.equal(context.sends.length, 0);
  const before = (await context.receipts())[0];
  assert.equal(before.status, 'not-sent');
  await context.deliver();
  assert.equal(context.sends.length, 1);
  assert.equal(context.sends[0].body.messageID, before.messageID);
  assert.equal((await context.receipts()).length, 1);
  assert.equal((await context.receipts())[0].status, 'sent');
});

test('returned SDK error and unconfirmed acceptance never fabricate success or replay a different ID', async () => {
  for (const mode of ['reject', 'unconfirmed'] as const) {
    const context = await fixture();
    context.setMode(mode);
    if (mode === 'reject') await assert.rejects(context.deliver(), /plugin_maintenance_effect_uncertain/);
    else await context.deliver();
    assert.equal((await context.receipts())[0].status, 'uncertain');
    assert.equal((await pendingNotices(context.runtime)).length, 1);
    context.setMode('accept');
    await context.deliver();
    assert.equal(context.sends.length, 1);
    assert.equal((await context.receipts())[0].status, 'uncertain');
  }
});

test('a receipt ID with altered author or content is not acceptance proof', async () => {
  const context = await fixture();
  context.setMode('lost-reply');
  await assert.rejects(context.deliver(), /plugin_maintenance_effect_uncertain/);
  const transcript = context.transcripts.get('fixture-chat')!;
  transcript.at(-1)!.parts[0].text = 'Different message';
  await assert.rejects(context.deliver(), /work_notice_message_identity_conflict/);
  assert.equal((await context.receipts())[0].status, 'uncertain');
});

test('an uncertain notice does not block unrelated actionable work', async () => {
  const context = await fixture();
  context.setMode('unconfirmed');
  await context.deliver();
  context.setMode('accept');
  await queueNotice(context.runtime, { id: 'another-notice', owner: 'homelab', change: 'ruling',
    text: 'Continue independent work.', origin: await context.addSession('homelab', 'another-chat'), at: new Date().toISOString() });
  await context.deliver();
  assert.equal(context.sends.length, 2);
  assert.equal((await context.receipts()).filter(receipt => receipt.status === 'sent').length, 1);
});

test('addressed notices cannot wake paused work and resume releases the same queued notice without replacing the plan', async () => {
  const context = await fixture();
  const origin = await context.addSession('homelab', 'paused-work');
  const item = await context.runtime.ledger.create('homelab', 'owner-change', {
    title: 'Original', goal: 'Original goal', rationale: 'r', acceptance: ['a'], size: 'small',
  }, { status: 'working', session: origin });
  await queueNotice(context.runtime, {
    id: 'paused-ruling', owner: 'homelab', workItem: item.id, change: 'owner-message',
    text: 'Here is more context, not authority to resume.', origin, at: new Date().toISOString(),
  });
  await pauseItem(context.runtime, item.id, humanWorkActor(), 'Human stop');
  await settleItemPause(context.runtime, item.id, { stop: async () => true });
  await assert.rejects(context.deliver(), /work_item_paused/);
  assert.equal((await context.runtime.ledger.get(item.id)).status, 'paused');
  assert.equal(context.sends.some(send => send.path.id === origin.sessionID), false);
  assert.ok((await pendingNotices(context.runtime)).some(notice => notice.id === 'paused-ruling'));
  await resumeItem(context.runtime, item.id, humanWorkActor());
  await context.deliver();
  assert.equal((await context.runtime.ledger.get(item.id)).status, 'working');
  assert.equal(context.sends.filter(send => send.path.id === origin.sessionID).length, 2);
  assert.equal(context.creates(), 0);
});

test('pause does not rewrite an already uncertain work notice receipt or replay the attempted send', async () => {
  const context = await fixture();
  context.setMode('unconfirmed');
  await context.deliver();
  const before = (await context.receipts())[0];
  const notice = await readNotice(context.runtime, 'fixture-notice');
  const item = await context.runtime.ledger.create('homelab', 'owner-change', {
    title: 'Original', goal: 'Original goal', rationale: 'r', acceptance: ['a'], size: 'small',
  }, { status: 'working', session: notice!.origin });
  await pauseItem(context.runtime, item.id, humanWorkActor(), 'Stop after uncertain message');
  await settleItemPause(context.runtime, item.id, { stop: async () => true });
  await context.deliver();
  const after = (await context.receipts())[0];
  assert.equal(after.status, 'uncertain');
  assert.equal(after.messageID, before.messageID);
  assert.equal(after.text, before.text);
  assert.equal(after.agent, before.agent);
  assert.equal(context.sends.length, 1);
});
