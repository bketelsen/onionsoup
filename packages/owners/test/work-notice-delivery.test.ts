import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode-ai/plugin';
import { Runtime } from '../src/runtime.ts';
import { pendingNotices, queueNotice } from '../src/notices.ts';
import { MaintenancePass } from '../src/plugin-maintenance.ts';
import { deliverWorkNotices, WorkNoticeDelivery } from '../src/work-notice-delivery.ts';

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'work-notice-delivery-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state });
  await queueNotice(runtime, { id: 'fixture-notice', owner: 'homelab', change: 'landed', text: 'Fixture work is ready.',
    origin: { sessionID: 'fixture-chat', directory: '/fixture' }, at: new Date().toISOString() });
  const pass = () => new MaintenancePass(join(state, `${randomUUID()}.json`), {
    version: 1, instanceID: randomUUID(), operationID: randomUUID(), kind: 'plugin:notices', directory: '/fixture',
    startedAt: new Date().toISOString(), phase: 'work-notices', status: 'running', calls: [],
  });
  const delivery = join(state, 'notices', 'delivery');
  const receipts = async () => Promise.all((await readdir(delivery)).sort().map(async file =>
    WorkNoticeDelivery.parse(JSON.parse(await readFile(join(delivery, file), 'utf8')))));
  return { state, runtime, pass, receipts, receipt: async () => (await receipts()).at(-1)! };
}

test('ambiguous work notice send keeps exact message receipt and is not replayed by a replacement instance', async () => {
  const context = await fixture();
  const sent: string[] = [];
  const client = { session: { status: async () => ({ data: {} }),
    promptAsync: async ({ body }: { body: { messageID: string } }) => {
      sent.push(body.messageID);
      throw new Error('reply_lost_after_acceptance');
    } } } as unknown as Parameters<Plugin>[0]['client'];
  const first = context.pass();
  await assert.rejects(deliverWorkNotices(context.runtime, first.client(client), first), /plugin_maintenance_effect_uncertain/);
  await first.settle();
  assert.equal(first.record.status, 'uncertain');
  assert.equal((await context.receipt()).status, 'uncertain');
  assert.equal((await context.receipt()).messageID, sent[0]);
  assert.deepEqual(await pendingNotices(context.runtime), []);
  const replacement = context.pass();
  await deliverWorkNotices(context.runtime, replacement.client(client), replacement);
  assert.equal(sent.length, 1);
});

test('work notice claims are exclusive and stopped reads cannot claim or send', async () => {
  const context = await fixture();
  const stopped = context.pass();
  const client = { session: { status: async () => { stopped.stop(); return { data: {} }; },
    promptAsync: async () => { throw new Error('must_not_send'); } } } as unknown as Parameters<Plugin>[0]['client'];
  await assert.rejects(deliverWorkNotices(context.runtime, stopped.client(client), stopped), /plugin_maintenance_stopped/);
  assert.equal((await pendingNotices(context.runtime)).length, 1);
  let sends = 0;
  const delivering = { session: { status: async () => ({ data: {} }), promptAsync: async () => { sends++; return { data: {} }; } } } as unknown as Parameters<Plugin>[0]['client'];
  const first = context.pass();
  const second = context.pass();
  await Promise.all([deliverWorkNotices(context.runtime, first.client(delivering), first),
    deliverWorkNotices(context.runtime, second.client(delivering), second)]);
  assert.equal(sends, 1);
  assert.equal((await context.receipt()).status, 'sent');
});


test('disposal after notice claim but before transport records not-sent and safely restores one retry', async () => {
  const context = await fixture();
  const first = context.pass();
  const check = first.check.bind(first);
  first.check = () => {
    if (existsSync(join(context.state, 'notices', 'delivery'))) first.stop();
    check();
  };
  let sends = 0;
  const client = { session: { status: async () => ({ data: {} }),
    promptAsync: async () => { sends++; return { data: {} }; } } } as unknown as Parameters<Plugin>[0]['client'];
  await assert.rejects(deliverWorkNotices(context.runtime, first.client(client), first), /plugin_maintenance_stopped/);
  assert.equal(sends, 0);
  assert.equal((await context.receipt()).status, 'not-sent');
  assert.equal((await pendingNotices(context.runtime)).length, 1);
  const second = context.pass();
  await deliverWorkNotices(context.runtime, second.client(client), second);
  assert.equal(sends, 1);
  assert.deepEqual((await context.receipts()).map(receipt => receipt.status).sort(), ['not-sent', 'sent']);
});
