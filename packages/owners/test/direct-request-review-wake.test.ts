import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { processRequest } from '../src/brokering.ts';
import { requestWork } from '../src/delegation.ts';
import { getDirectRequestReview, reviewDirectRequestPlan } from '../src/direct-request-plan-review.ts';
import { deliverDirectRequestReviews, directRequestReviewWakeStatus } from '../src/direct-request-review-wake.ts';
import type { PlanRevisionClient } from '../src/plan-revision.ts';
import { submitPlan } from '../src/plan-work.ts';
import { requestProgressDetail } from '../src/request-status.ts';
import { Runtime } from '../src/runtime.ts';
import { approvePlan, revisePlan } from '../src/work-recovery.ts';

const origin = { sessionID: 'fixture-coordinator', directory: '/fixture/coordinator' };
const proposal = { title: 'README refresh', goal: 'Explain daily use', rationale: 'Documentation only',
  acceptance: ['Only documentation', 'Draft PR only'], size: 'small' as const };
async function setup(context: TestContext, hasOrigin = true) {
  const root = await mkdtemp(join(tmpdir(), 'direct-review-wake-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  const declarations = join(root, 'config');
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  const runtime = await Runtime.open({ declarations, state: join(root, 'state') });
  for (const owner of ['odrade', 'clippy']) await runtime.notebook(owner).ensure('# Fixture');
  const request = await requestWork(runtime, 'odrade', 'clippy', proposal, hasOrigin ? origin : undefined);
  await processRequest(runtime, request.id);
  const accepted = await runtime.requests.get(request.id);
  const item = await submitPlan(runtime, 'clippy', { item: accepted.workItem!, title: proposal.title,
    goal: 'A short daily-use guide', plan: 'Markdown changes only; checked examples; draft PR.' }, { sessionID: 'fixture-report', directory: '/fixture/report' });
  return { runtime, request: accepted, item, declarations };
}
function transport() {
  const messages: string[] = [];
  const calls: { id: string; text: string }[] = [];
  const state = { exists: true, idle: true, accept: true, fail: false, beforePrompt: async () => {} };
  const client: PlanRevisionClient = {
    exists: async target => { assert.deepEqual(target, origin); return state.exists; },
    messages: async () => messages,
    idle: async () => state.idle,
    prompt: async (_target, agent, text, id) => {
      assert.equal(agent, 'Odrade');
      await state.beforePrompt();
      calls.push({ id, text });
      if (state.accept) messages.push(id);
      if (state.fail) throw new Error('fixture_transport_lost');
    },
  };
  return { client, calls, state, messages };
}
function fail(_request: string, error: unknown): never { throw error; }

test('direct review wake uses one durable actionable receipt across concurrent deliveries and restart', async context => {
  const { runtime, request, declarations, item } = await setup(context);
  const review = await getDirectRequestReview(runtime, request.id);
  const fake = transport();
  const reopened = await Runtime.open({ declarations, state: runtime.stateDirectory });
  await Promise.all([runtime, reopened].map(instance => deliverDirectRequestReviews(instance, fake.client, fail)));
  await deliverDirectRequestReviews(reopened, fake.client, fail);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /continuation requests a review, not an approval/);
  assert.match(fake.calls[0].text, /needs-human/);
  assert.match(fake.calls[0].text, new RegExp(review.digest));
  assert.match(fake.calls[0].id, /^msg_[a-f0-9]{26}$/);
  assert.equal((await directRequestReviewWakeStatus(runtime, request.id, review.digest))?.status, 'delivered');
  assert.equal((await runtime.ledger.get(item.id)).status, 'awaiting-plan-approval');
  assert.equal((await runtime.ledger.get(item.id)).planApproval, undefined);
});

test('busy and unavailable origin are safe retry prerequisites, not lost review wakes', async context => {
  const { runtime, request } = await setup(context);
  const review = await getDirectRequestReview(runtime, request.id);
  const fake = transport();
  fake.state.exists = false;
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal((await directRequestReviewWakeStatus(runtime, request.id, review.digest))?.reason, 'direct_review_wake_origin_unavailable');
  fake.state.exists = true;
  fake.state.idle = false;
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 0);
  fake.state.idle = true;
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 1);
});

test('lost response reconciles an accepted receipt but uncertain unobserved sends never duplicate inference', async context => {
  for (const accept of [true, false]) {
    const { runtime, request, declarations } = await setup(context);
    const review = await getDirectRequestReview(runtime, request.id);
    const fake = transport();
    fake.state.accept = accept;
    fake.state.fail = true;
    await deliverDirectRequestReviews(runtime, fake.client, fail);
    const reopened = await Runtime.open({ declarations, state: runtime.stateDirectory });
    await deliverDirectRequestReviews(reopened, fake.client, fail);
    await deliverDirectRequestReviews(reopened, fake.client, fail);
    assert.equal(fake.calls.length, 1);
    const wake = await directRequestReviewWakeStatus(runtime, request.id, review.digest);
    assert.equal(wake?.status, accept ? 'delivered' : 'blocked');
    if (!accept) assert.equal(wake?.reason, 'direct_review_wake_delivery_uncertain');
  }
});

test('needs-human scope decision stops repeat wakes and keeps the plan pending with visible evidence', async context => {
  const { runtime, request, item } = await setup(context);
  const review = await getDirectRequestReview(runtime, request.id);
  const fake = transport();
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  await reviewDirectRequestPlan(runtime, 'odrade', { request: request.id, item: item.id, digest: review.digest,
    decision: 'needs-human', scope: 'needs-human', note: 'Confirm whether Go documentation-contract test edits fit the docs-only request.' });
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  const status = await requestProgressDetail(runtime, 'odrade', request.id);
  assert.match(status, /needs-human/);
  assert.match(status, /Go documentation-contract/);
  assert.equal(fake.calls.length, 1);
  assert.equal((await runtime.ledger.get(item.id)).status, 'awaiting-plan-approval');
});

test('a revised plan gets a new binding and one new wake; original receipt is retained', async context => {
  const { runtime, request, item } = await setup(context);
  const initial = await getDirectRequestReview(runtime, request.id);
  const fake = transport();
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  await revisePlan(runtime, item.id, 'Fixture person', 'Keep examples in README');
  await submitPlan(runtime, 'clippy', { item: item.id, title: proposal.title, goal: proposal.goal,
    plan: 'Only README, retain examples; draft PR.' }, origin);
  const revised = await getDirectRequestReview(runtime, request.id);
  assert.notEqual(revised.digest, initial.digest);
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 2);
  assert.notEqual(fake.calls[0].id, fake.calls[1].id);
  assert.equal((await directRequestReviewWakeStatus(runtime, request.id, initial.digest))?.status, 'delivered');
});

test('human approval before delivery wins without a wake or duplicate execution', async context => {
  const { runtime, item } = await setup(context);
  const fake = transport();
  fake.client.idle = async () => {
    await approvePlan(runtime, item.id, 'Fixture person', 'Proceed with documentation scope');
    return true;
  };
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 0);
  assert.equal((await runtime.ledger.get(item.id)).planApproval?.by, 'Fixture person');
});

test('current grant revocation before delivery prevents the review wake and explains human fallback', async context => {
  const { runtime, declarations, request } = await setup(context);
  const fake = transport();
  const path = join(declarations, 'owners/clippy.yaml');
  const original = await readFile(path, 'utf8');
  fake.client.idle = async () => {
    await writeFile(path, original.replace(/grants:[\s\S]*$/, 'grants: []\n'));
    return true;
  };
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 0);
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /direct_plan_review_no_grant/);
});

test('missing origin stays pull-only with an explicit delivery blocker', async context => {
  const { runtime, request } = await setup(context, false);
  const fake = transport();
  await deliverDirectRequestReviews(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 0);
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /direct_review_wake_origin_or_persona_missing/);
});
