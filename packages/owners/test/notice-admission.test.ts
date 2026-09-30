import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { Runtime } from '../src/runtime.ts';
import { armDeployment, beginDrain, listAdmissions } from '../src/deployment-admission.ts';
import { NOTICE_DELIVERY_LIMITS } from '../src/exchange-notice-delivery.ts';
import { deliveredExchangeNoticeProof, deliverExchangeNotices, queueExchangeNotice, type ExchangeClient, type NoticeMessage } from '../src/exchange-notices.ts';
import { withActiveHooks } from './active-hooks.ts';

const target = { sessionID: 'chat', directory: '/owner-chat' };
const declarations = 'packages/owners/test/fixtures/owners';
const stop = (parentID: string) => ({ info: { id: `answer-${parentID}`, role: 'assistant', parentID,
  time: { created: 2, completed: 3 }, finish: 'stop' }, parts: [] });

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'notice-admission-'));
  const runtime = await Runtime.open({ declarations, state });
  const messages: unknown[] = [];
  const timers: (() => Promise<unknown>)[] = [];
  let lookup: (() => Promise<void>) | undefined;
  let parentID: string | undefined;
  const client = { session: {
    get: async () => { await lookup?.(); return { data: { id: target.sessionID, directory: target.directory, parentID } }; },
    status: async () => ({ data: {} }),
    messages: async () => ({ data: messages }),
    children: async () => ({ data: [] }),
    create: async () => ({ data: undefined }),
  } };
  const original = globalThis.setInterval;
  let hooks: Awaited<ReturnType<typeof withActiveHooks>>;
  let second: Awaited<ReturnType<typeof withActiveHooks>>;
  try {
    globalThis.setInterval = ((callback: () => Promise<unknown>) => {
      timers.push(callback);
      return { unref() {} } as NodeJS.Timeout;
    }) as typeof setInterval;
    hooks = await withActiveHooks({ client, directory: '/sender' } as unknown as Parameters<Plugin>[0], { declarations, state });
    second = await withActiveHooks({ client, directory: target.directory } as unknown as Parameters<Plugin>[0], { declarations, state });
  } finally { globalThis.setInterval = original; }
  async function receive(body: Parameters<ExchangeClient['post']>[1]) {
    const parts = structuredClone(body.parts);
    const info = { id: body.messageID, role: 'user', agent: body.agent, sessionID: target.sessionID, time: { created: Date.now() } };
    await second['chat.message']!({ sessionID: target.sessionID, agent: body.agent, messageID: body.messageID }, { message: info, parts } as never);
    const message = { info, parts };
    messages.push(message);
    return message;
  }
  let afterReceive: ((body: Parameters<ExchangeClient['post']>[1]) => Promise<void>) | undefined;
  let failAfter = false;
  let posts = 0;
  const transport: ExchangeClient = {
    sessions: async () => [], idle: async () => true, messages: async () => messages as NoticeMessage[],
    post: async (_target, body) => {
      assert.equal(body.noReply, true);
      assert.equal((await listAdmissions(state)).some(lease => lease.kind === `notice:${body.messageID}`), true);
      posts++;
      await receive(body);
      await afterReceive?.(body);
      if (failAfter) throw new Error('lost_acknowledgement');
    },
  };
  async function person(id = 'person', text = 'Actual human request') {
    return receive({ agent: 'Miles Teg', messageID: id, noReply: true, parts: [{ type: 'text', text }] });
  }
  async function queue() { return queueExchangeNotice(runtime, 'homelab', 'Recorded status only', { id: `msg_${'a'.repeat(32)}`, at: new Date().toISOString(), target }); }
  async function deliver() {
    const errors: unknown[] = [];
    await deliverExchangeNotices(runtime, transport, (_id, error) => errors.push(error));
    return errors;
  }
  return { runtime, state, hooks, second, messages, queue, deliver, person, receive, posts: () => posts,
    reconcile: () => timers[3]!(),
    setLookup: (callback: () => Promise<void>) => { lookup = callback; }, setParent: (id: string) => { parentID = id; },
    setAfterReceive: (callback: (body: Parameters<ExchangeClient['post']>[1]) => Promise<void>) => { afterReceive = callback; }, setFailAfter: (value: boolean) => { failAfter = value; } };
}

test('host noReply delivery crosses plugin instances without creating a chat turn; durable receipt or copied text cannot authorize a genuine message', async () => {
  const context = await fixture();
  const notice = await context.queue();
  assert.deepEqual(await context.deliver(), []);
  assert.deepEqual(await listAdmissions(context.state), []);
  const message = context.messages[0] as NoticeMessage;
  assert.deepEqual((message.parts[0] as { metadata?: unknown }).metadata, {}, 'one-time capability is removed before persistence');
  assert.ok(await deliveredExchangeNoticeProof(context.runtime, target, message));
  await context.person(notice.id, message.parts[0]!.text);
  assert.deepEqual((await listAdmissions(context.state)).map(lease => lease.kind), ['chat:chat']);
});

test('a delivered notice after a completed human turn does not replace that turn; a later genuine message still holds admission', async () => {
  const context = await fixture();
  await context.person();
  context.messages.push(stop('person'));
  await context.queue();
  assert.deepEqual(await context.deliver(), []);
  await context.reconcile();
  assert.deepEqual(await listAdmissions(context.state), []);
  await context.person('next-person');
  await context.reconcile();
  assert.equal((await listAdmissions(context.state)).length, 1);
});

test('a human turn arriving during a notice post remains admitted after the bounded notice lease ends', async () => {
  const context = await fixture();
  await context.queue();
  context.setAfterReceive(async () => { await context.person(); });
  assert.deepEqual(await context.deliver(), []);
  assert.deepEqual((await listAdmissions(context.state)).map(lease => lease.kind), ['chat:chat']);
  await context.reconcile();
  assert.equal((await listAdmissions(context.state)).length, 1);
  context.messages.push(stop('person'));
  await context.reconcile();
  assert.deepEqual(await listAdmissions(context.state), []);
});

test('lost acknowledgement retains pending evidence and reconciles the exact accepted notice once without reposting', async () => {
  const context = await fixture();
  const notice = await context.queue();
  context.setFailAfter(true);
  assert.match(String((await context.deliver())[0]), /lost_acknowledgement/);
  assert.equal(await deliveredExchangeNoticeProof(context.runtime, target, context.messages[0]), undefined);
  assert.deepEqual(await listAdmissions(context.state), []);
  const pendingPath = join(context.state, 'notices/exchanges/pending', `${notice.id}.json`);
  const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
  context.runtime.owner('homelab').chatContext.noticeChars = 1;
  context.setFailAfter(false);
  assert.deepEqual(await context.deliver(), []);
  assert.equal(context.posts(), 1);
  const proof = await deliveredExchangeNoticeProof(context.runtime, target, context.messages[0]);
  assert.equal(proof?.text, pending.delivery.text, 'recorded rendering survives later configuration changes');
});

test('an ID collision with a real human entry is never adopted as trusted delivered evidence', async () => {
  const context = await fixture();
  const notice = await context.queue();
  await context.person(notice.id, 'Different human content');
  assert.match(String((await context.deliver())[0]), /exchange_notice_message_conflict/);
  assert.equal(context.posts(), 0);
  assert.equal(await deliveredExchangeNoticeProof(context.runtime, target, context.messages[0]), undefined);
});

test('delivered proof requires exact target, role, agent and sole unmodified text part', async () => {
  const context = await fixture();
  await context.queue();
  assert.deepEqual(await context.deliver(), []);
  const message = context.messages[0] as NoticeMessage;
  for (const changed of [
    { ...message, info: { ...message.info, role: 'assistant' } },
    { ...message, info: { ...message.info, agent: 'Someone Else' } },
    { ...message, parts: [{ type: 'text', text: 'Copied notice prefix' }] },
    { ...message, parts: [...message.parts, { type: 'text', text: 'Actual user instruction' }] },
    { ...message, parts: [{ ...message.parts[0], ignored: true }] },
    { ...message, info: { ...message.info, id: '../../record' } },
  ]) assert.equal(await deliveredExchangeNoticeProof(context.runtime, target, changed), undefined);
  assert.equal(await deliveredExchangeNoticeProof(context.runtime, { ...target, directory: '/other' }, message), undefined);
  assert.equal(await deliveredExchangeNoticeProof(context.runtime, { ...target, sessionID: 'other' }, message), undefined);
});

test('a pre-existing exact copy cannot gain delivery provenance from a later attempted post', async () => {
  const context = await fixture();
  const notice = await context.queue();
  const root = join(context.state, 'notices/exchanges');
  const text = `[onionsoup notice] Owner exchange (${notice.id})\n${notice.text}\n\nFull exchange record: ${root}/delivered/${notice.id}.json\nWhile delivery is pending: ${root}/pending/${notice.id}.json`;
  await context.person(notice.id, text);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match(String((await context.deliver())[0]), /exchange_notice_message_conflict/);
    const pending = JSON.parse(await readFile(join(root, 'pending', `${notice.id}.json`), 'utf8'));
    assert.equal(pending.delivery, undefined);
  }
  assert.equal(context.posts(), 0);
  assert.equal(await deliveredExchangeNoticeProof(context.runtime, target, context.messages[0]), undefined);
});

test('expired authorization after asynchronous ancestry lookup fails closed and drain rejects new notice posts', async () => {
  const context = await fixture();
  await context.queue();
  const previous = NOTICE_DELIVERY_LIMITS.timeoutMs;
  NOTICE_DELIVERY_LIMITS.timeoutMs = 1;
  context.setLookup(() => new Promise(resolve => setTimeout(resolve, 10)));
  try {
    assert.match(String((await context.deliver())[0]), /exchange_notice_delivery_unverified/);
    assert.deepEqual(await listAdmissions(context.state), []);
    assert.deepEqual(context.messages, []);
  } finally { NOTICE_DELIVERY_LIMITS.timeoutMs = previous; }
  const drained = await fixture();
  await drained.queue();
  await armDeployment(drained.state, 'target');
  await beginDrain(drained.state, 'target');
  assert.match(String((await drained.deliver())[0]), /deployment_draining/);
  assert.equal(drained.posts(), 0);
});

test('consumed or unknown delivery capabilities reject before message persistence or chat bookkeeping', async () => {
  const context = await fixture();
  const notice = await context.queue();
  context.setAfterReceive(async body => {
    await assert.rejects(context.receive(body), /exchange_notice_delivery_unverified/);
  });
  assert.deepEqual(await context.deliver(), []);
  assert.equal(context.messages.length, 1);
  assert.deepEqual(await listAdmissions(context.state), []);
  await assert.rejects(context.receive({ agent: 'Miles Teg', noReply: true, messageID: notice.id,
    parts: [{ type: 'text', text: 'Unknown token', metadata: { onionsoupNoticeDelivery: 'copied-or-forged' } }] }), /exchange_notice_delivery_unverified/);
  assert.equal(context.messages.length, 1);
  assert.deepEqual(await listAdmissions(context.state), []);
});
