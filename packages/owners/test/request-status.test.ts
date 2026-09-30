import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { REQUEST_STATUS_LIMITS, noticeRequestProgress, requestProgressDetail, requestProgress, requestProgressSummary, requestProgressText, requestVisibleTo } from '../src/request-status.ts';
import { deliverExchangeNotices, type ExchangeClient, type NoticeMessage } from '../src/exchange-notices.ts';

const proposal = { title: 'Repair svu', goal: 'Fix the version check', rationale: 'CI evidence', acceptance: ['Check succeeds'], size: 'small' as const };
const origin = { sessionID: 'odrade-origin', directory: '/fixture/chat/odrade' };
async function setup() {
  return Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'request-progress-')) });
}
async function open(runtime: Runtime, withOrigin = true) {
  return runtime.requests.open('odrade', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none', withOrigin ? origin : undefined);
}
async function notices(runtime: Runtime, kind = 'pending') {
  const directory = join(runtime.stateDirectory, 'notices', 'exchanges', kind);
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}
function fail(_id: string, error: unknown): never { throw error; }

function transport() {
  const messages: NoticeMessage[] = [];
  let posts = 0;
  let failAfter = true;
  const client: ExchangeClient = {
    sessions: async () => { throw new Error('must_not_choose_different_chat'); },
    idle: async target => { assert.deepEqual(target, origin); return true; },
    messages: async () => messages,
    post: async (target, body) => {
      assert.deepEqual(target, origin);
      assert.equal(body.noReply, true);
      posts++;
      messages.push({ info: { id: body.messageID, role: 'user', agent: body.agent, time: { created: Date.now() } }, parts: body.parts });
      if (failAfter) { failAfter = false; throw new Error('accepted_then_disconnected'); }
    },
  };
  return { client, posts: () => posts };
}

test('Odrade reads fresh linked progress, blocker, PR evidence and next action without relaying facts', async () => {
  const runtime = await setup();
  const request = await open(runtime);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { request: request.id, status: 'awaiting-plan-approval' });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id,
    publishDecision: { decision: 'accept', reply: 'I will fix it' } }));
  let summary = await requestProgressSummary(runtime, 'odrade');
  assert.match(summary, /I will fix it/);
  assert.match(summary, /awaiting-plan-approval/);
  assert.match(summary, /configured manager/);
  await runtime.ledger.save({ ...item, status: 'landed', publication: { url: 'https://example.invalid/pr/1', state: 'merged', branch: 'fix', by: 'clippy', at: new Date().toISOString() } });
  summary = await requestProgressSummary(runtime, 'odrade');
  assert.match(summary, /example.invalid\/pr\/1: merged/);
  assert.match(summary, /deployment unknown/);
  assert.equal((await runtime.requests.list()).length, 1);
});

test('participants and direct receiver manager see progress; unrelated owners do not', async () => {
  const runtime = await setup();
  const request = await runtime.requests.open('homelab', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  assert.equal(requestVisibleTo(runtime, 'homelab', request), true);
  assert.equal(requestVisibleTo(runtime, 'clippy', request), true);
  assert.equal(requestVisibleTo(runtime, 'odrade', request), true);
  assert.equal(requestVisibleTo(runtime, 'moneo', request), false);
  assert.equal(await requestProgressSummary(runtime, 'moneo'), '');
});

test('significant transitions queue once across restarts; changing timestamp alone does not notify', async () => {
  const runtime = await setup();
  const request = await open(runtime);
  assert.equal(await noticeRequestProgress(runtime, fail), 1);
  assert.equal(await noticeRequestProgress(runtime, fail), 0);
  await runtime.requests.update(request.id, current => ({ ...current }));
  assert.equal(await noticeRequestProgress(runtime, fail), 0);
  await runtime.requests.update(request.id, current => ({ ...current, status: 'declined', reason: 'Not the right approach' }));
  assert.equal(await noticeRequestProgress(runtime, fail), 1);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  assert.equal(await noticeRequestProgress(reopened, fail), 0);
  const queued = await notices(runtime);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(notice => JSON.stringify(notice.target) === JSON.stringify(origin)));
  assert.match(queued.map(notice => notice.text).join('\n'), /Not the right approach/);
});

test('accepted delivery reconciles after disconnect without a second post or any work creation', async () => {
  const runtime = await setup();
  await open(runtime);
  await noticeRequestProgress(runtime, fail);
  const fake = transport();
  const errors: unknown[] = [];
  await deliverExchangeNotices(runtime, fake.client, (_id, error) => errors.push(error));
  assert.equal(errors.length, 1);
  await deliverExchangeNotices(runtime, fake.client, fail);
  assert.equal(fake.posts(), 1);
  assert.equal((await notices(runtime, 'delivered')).length, 1);
  assert.equal((await runtime.ledger.list()).length, 0);
});

test('missing origin stays pull-visible and denial is never converted to work', async () => {
  const runtime = await setup();
  const request = await open(runtime, false);
  await runtime.requests.update(request.id, current => ({ ...current, status: 'denied', reason: 'Not authorized' }));
  assert.equal(await noticeRequestProgress(runtime, fail), 0);
  assert.match(await requestProgressSummary(runtime, 'odrade'), /Not authorized/);
  assert.equal((await runtime.ledger.list()).length, 0);
});

test('stale or missing evidence stays explicit and never implies deployment', async () => {
  const runtime = await setup();
  const request = await open(runtime);
  const progress = requestProgress({ ...request, workItem: 'missing', updatedAt: '2020-01-01T00:00:00Z' }, undefined, new Date('2026-09-30T00:00:00Z'));
  assert.equal(progress.stale, true);
  assert.equal(progress.evidence, 'linked_work_missing');
  assert.match(requestProgressText(progress), /unknown/);
  assert.match(requestProgressText(progress), /Live state not probed/);
});

test('outbox crash before cursor completion adopts the same notice identity', async () => {
  const runtime = await setup();
  await open(runtime);
  await noticeRequestProgress(runtime, fail);
  const [notice] = await notices(runtime);
  const directory = join(runtime.stateDirectory, 'notices', 'request-progress');
  const [file] = (await readdir(directory)).filter(name => name.endsWith('.json'));
  const cursor = JSON.parse(await readFile(join(directory, file), 'utf8'));
  await writeFile(join(directory, file), JSON.stringify({ ...cursor, pending: notice }));
  await noticeRequestProgress(runtime, fail);
  assert.equal((await notices(runtime)).length, 1);
});

test('context bounds are explicit, retain blocker labels, and offer paginated full details', async () => {
  const runtime = await setup();
  for (let index = 0; index < REQUEST_STATUS_LIMITS.summaryRecords + 2; index++) await open(runtime, false);
  const newest = await open(runtime, false);
  const reason = 'Required evidence is unavailable. '.repeat(100);
  await runtime.requests.update(newest.id, request => ({ ...request, status: 'interrupted', reason }));
  const summary = await requestProgressSummary(runtime, 'odrade');
  assert.ok(summary.length <= REQUEST_STATUS_LIMITS.summaryChars);
  assert.match(summary, /additional requests omitted; blockers may be among them/);
  assert.match(summary, /Details abbreviated \(including any long blocker\)/);
  assert.match(summary, /Required evidence is unavailable/);
  const nextOffset = Number(/offset=(\d+)/.exec(summary)?.[1]);
  assert.ok(nextOffset > 0);
  const next = await requestProgressSummary(runtime, 'odrade', new Date(), nextOffset);
  assert.match(next, /Cross-owner progress/);
  assert.ok((await requestProgressDetail(runtime, 'odrade', newest.id)).includes(reason));
  assert.equal(await requestProgressDetail(runtime, 'moneo', newest.id), 'No visible request with that ID.');
});
