import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { access, mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { processRequest } from '../src/brokering.ts';
import { queueExchangeNotice, deliverExchangeNotices } from '../src/exchange-notices.ts';
import { ownerMessageId, sendOwnerMessage, replyToOwnerMessage } from '../src/owner-messages.ts';
import { pendingNotices, queueNotice } from '../src/notices.ts';
import {
  approveInitiative, draftInitiative, queueResolvedEscalations, raiseToManager,
  resolveEscalation, steerReportItem, submitInitiative, superviseInitiatives,
} from '../src/org-work.ts';
import { submitPlan } from '../src/plan-work.ts';
import { Runtime } from '../src/runtime.ts';
import { rememberedSession, rememberSession, itemSessionHistory } from '../src/session-history.ts';
import { SessionOpeningStore } from '../src/session-opening-store.ts';
import { messageFixture } from './owner-message-fixture.ts';
import { requestWork } from '../src/delegation.ts';
import { getDirectRequestReview } from '../src/direct-request-plan-review.ts';
import { deliverDirectRequestReviews, directRequestReviewWakeStatus } from '../src/direct-request-review-wake.ts';
import { deliverPlanRevisions, planRevisionStatus } from '../src/plan-revision.ts';
import { planRevisionClient } from '../src/plan-revision-client.ts';
import { revisePlan } from '../src/work-recovery.ts';
import { openNeededSessions, ownerSessionClient } from '../src/owner-sessions.ts';
import { chatPath } from '../src/chats.ts';

const proposal = { title: 'Original Lucilla request', goal: 'Complete option A', rationale: 'Recovery',
  acceptance: ['Original request resumes'], size: 'small' as const };
const fail = (_id: string, error: unknown) => { throw error; };

async function assignedFixture() {
  const context = await messageFixture();
  const manager = await context.addSession('odrade', 'ses_odrade');
  const planner = await context.addSession('clippy', 'ses_lucilla');
  const drafted = await draftInitiative(context.runtime, 'odrade', {
    title: 'Lucilla manager resolution', goal: proposal.goal, rationale: proposal.rationale,
    assignments: [{ id: 'lucilla', to: 'clippy', proposal, after: [] }],
  }, manager);
  await submitInitiative(context.runtime, 'odrade', drafted.id);
  await approveInitiative(context.runtime, drafted.id, 'person');
  await superviseInitiatives(context.runtime, { onError: fail });
  const request = (await context.runtime.requests.list())[0];
  await processRequest(context.runtime, request.id);
  const item = await context.runtime.ledger.update((await context.runtime.requests.get(request.id)).workItem!,
    current => ({ ...current, origin: planner, originOwner: 'clippy' }));
  const escalation = await raiseToManager(context.runtime, 'clippy', {
    kind: 'blocked', note: 'Which option clears this blocker?', item: item.id,
  });
  return { ...context, manager, planner, initiative: drafted, request, item, escalation };
}

test('Lucilla resolution reaches the ORIGINAL planning transcript and resumes without replacement, cancellation or a new gate', async () => {
  const context = await assignedFixture();
  const { runtime, item, initiative, escalation } = context;
  await resolveEscalation(runtime, 'odrade', initiative.id, escalation.id, 'Use option A; the blocker is cleared.');
  context.busy.add(context.planner.sessionID);
  await context.deliver();
  assert.equal(context.sends.filter(send => send.path.id === context.planner.sessionID).length, 0);
  assert.equal((await runtime.ledger.get(item.id)).status, 'planning');
  context.busy.clear();
  context.onPrompt(async prompt => {
    if (prompt.path.id !== context.planner.sessionID) return;
    assert.match(prompt.body.parts[0].text, /Use option A/);
    assert.equal(prompt.body.noReply, undefined);
    await submitPlan(runtime, 'clippy', { ...proposal, plan: 'Carry out option A', item: item.id }, context.planner);
  });
  await context.deliver();
  const resumed = await runtime.ledger.get(item.id);
  assert.equal(resumed.status, 'awaiting-plan-approval', 'the existing eventual effect gate is preserved');
  assert.equal(resumed.request, context.request.id);
  assert.equal(resumed.planDocument?.markdown, 'Carry out option A');
  assert.equal((await runtime.requests.list()).length, 1);
  assert.equal((await runtime.ledger.list()).length, 1);
  assert.equal(context.creates(), 0);
  assert.equal((await runtime.initiatives.get(initiative.id)).escalations[0].resolution?.note, 'Use option A; the blocker is cleared.');
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  await resolveEscalation(reopened, 'odrade', initiative.id, escalation.id, 'Use option A; the blocker is cleared.');
  await queueResolvedEscalations(reopened, fail);
  await context.deliver(reopened);
  assert.equal(context.sends.filter(send => send.path.id === context.planner.sessionID).length, 1);
  assert.equal((await pendingNotices(reopened)).filter(notice => notice.change === 'manager-ruling').length, 0);
  assert.equal((await context.receipts()).filter(receipt => receipt.origin.sessionID === context.planner.sessionID)[0].status, 'sent');
  await assert.rejects(resolveEscalation(reopened, 'odrade', initiative.id, escalation.id, 'Change the recorded ruling'), /resolution_conflict/);
});

test('resolution retry repairs the crash between the persisted resolution and its missing delivery intent', async () => {
  const context = await assignedFixture();
  await context.runtime.initiatives.update(context.initiative.id, current => ({
    ...current, escalations: current.escalations.map(escalation => ({
      ...escalation, resolution: { by: 'owner:odrade', at: new Date().toISOString(), note: 'Option A' },
    })),
  }));
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.runtime.stateDirectory });
  await queueResolvedEscalations(reopened, fail);
  await queueResolvedEscalations(reopened, fail);
  assert.equal((await pendingNotices(reopened)).filter(notice => notice.change === 'manager-ruling').length, 1);
  await context.deliver(reopened);
  assert.equal(context.sends.filter(send => send.path.id === context.planner.sessionID).length, 1);
});

test('manager note retries deduplicate by invocation while a deliberate same-text repeat reaches the exact execution session', async () => {
  const context = await assignedFixture();
  const execution = await context.addSession('clippy', 'ses_execution');
  await context.runtime.ledger.update(context.item.id, current => ({ ...current, session: execution }));
  const firstInvocation = { origin: context.manager, messageID: 'msg_first_note' };
  await steerReportItem(context.runtime, 'odrade', context.item.id, 'note', 'Use option A', firstInvocation);
  await steerReportItem(context.runtime, 'odrade', context.item.id, 'note', 'Use option A', firstInvocation);
  await context.deliver();
  assert.equal(context.sends.filter(send => send.path.id === execution.sessionID).length, 1);
  assert.equal(context.sends.filter(send => send.path.id === context.planner.sessionID).length, 0);
  assert.match(context.sends.find(send => send.path.id === execution.sessionID)!.body.parts[0].text, /From owner odrade/);
  const secondInvocation = { origin: context.manager, messageID: 'msg_deliberate_repeat' };
  await steerReportItem(context.runtime, 'odrade', context.item.id, 'note', 'Use option A', secondInvocation);
  await steerReportItem(context.runtime, 'odrade', context.item.id, 'note', 'Use option A', secondInvocation);
  await context.deliver();
  assert.equal(context.sends.filter(send => send.path.id === execution.sessionID).length, 2);
  assert.equal((await pendingNotices(context.runtime)).filter(notice => notice.change === 'manager-ruling').length, 0);
});

test('actionable peers send and reply in their real contexts with durable identity, not read-only hires', async () => {
  const context = await messageFixture();
  context.runtime.hire = async () => { throw new Error('peer_messages_must_not_hire'); };
  const sender = await context.addSession('odrade', 'ses_sender');
  const recipient = await context.addSession('homelab', 'ses_recipient');
  const input = { to: 'homelab', text: 'Please answer the correction in your current context.', session: recipient };
  const sent = await sendOwnerMessage(context.runtime, 'odrade', input, sender, 'msg_invocation');
  assert.equal((await sendOwnerMessage(context.runtime, 'odrade', input, sender, 'msg_invocation')).id, sent.id);
  context.busy.add(recipient.sessionID);
  await context.deliver();
  assert.equal(context.sends.length, 0);
  context.busy.clear();
  await context.deliver();
  const reply = await replyToOwnerMessage(context.runtime, 'homelab', { message: sent.id, text: 'Corrected from my actual session.' },
    recipient, 'msg_reply');
  await context.deliver();
  assert.deepEqual(context.sends.map(send => send.path.id), [recipient.sessionID, sender.sessionID]);
  assert.ok(context.sends.every(send => send.body.noReply === undefined));
  assert.equal(reply.owner, 'odrade');
  assert.equal(reply.replyTo, sent.id);
  await assert.rejects(replyToOwnerMessage(context.runtime, 'bellonda', { message: sent.id, text: 'Impersonate recipient' },
    recipient, 'msg_invalid'), /not_replyable/);
  await assert.rejects(sendOwnerMessage(context.runtime, 'odrade', { ...input, session: sender }, sender, 'msg_foreign'), /session_not_recipient/);
  await assert.rejects(sendOwnerMessage(context.runtime, 'homelab', { ...input, to: 'odrade' }, sender, 'msg_forged'), /sender_session_unproven/);
});

test('consultation exchange remains informational noReply and cannot wake an owner', async () => {
  const context = await messageFixture();
  const origin = await context.addSession('homelab', 'ses_consultation');
  await queueExchangeNotice(context.runtime, 'homelab', 'Read-only consultation answer.', {
    id: `msg_${'a'.repeat(32)}`, at: new Date().toISOString(), target: origin,
  });
  const posts: boolean[] = [];
  await deliverExchangeNotices(context.runtime, {
    sessions: async () => [], messages: async () => [], idle: async () => true,
    post: async (_target, body) => { posts.push(body.noReply); },
  }, fail);
  assert.deepEqual(posts, [true]);
  await context.deliver();
  assert.equal(context.sends.length, 0);
});

test('retired worktree preserves history and reuses one correctly owned fresh continuation without probing or recreating it', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_manager');
  const retired = await context.addSession('homelab', 'ses_retired', join(context.root, 'plans', 'removed'), true);
  const input = { to: 'homelab', text: 'Reply after reading your retained history.', session: retired };
  const first = await sendOwnerMessage(context.runtime, 'odrade', input, sender, 'msg_one');
  await context.deliver();
  const continuation = context.sends[0];
  assert.notEqual(continuation.query.directory, retired.directory);
  assert.equal(continuation.body.agent, context.runtime.owner('homelab').persona!.name);
  assert.match(continuation.body.parts[0].text, /homelab's original context/);
  assert.match(continuation.body.parts[0].text, /Historical session ses_retired/);
  assert.equal((await rememberedSession(context.runtime, retired.sessionID))?.archived, true);
  await assert.rejects(access(retired.directory));
  assert.equal(context.queries.filter(query => query.directory === retired.directory).length, 0);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.runtime.stateDirectory });
  await sendOwnerMessage(reopened, 'odrade', { ...input, text: 'A second correction.' }, sender, 'msg_two');
  await context.deliver(reopened);
  assert.equal(context.creates(), 1);
  assert.equal(context.sends[1].path.id, continuation.path.id);
  assert.equal((await new SessionOpeningStore(reopened.stateDirectory).list())[0].phase, 'opened');
  const returnSource = { sessionID: continuation.path.id, directory: continuation.query.directory };
  await replyToOwnerMessage(reopened, 'homelab', { message: first.id, text: 'Resolved in the continuation.' }, returnSource, 'msg_return');
  await context.deliver(reopened);
  assert.equal(context.sends.at(-1)!.path.id, sender.sessionID);
});

test('a requester-owned historical origin is never treated as the receiving item owner', async () => {
  const context = await messageFixture();
  const requester = await context.addSession('odrade', 'ses_requester', join(context.root, 'removed-requester'), true);
  const item = await context.runtime.ledger.create('homelab', 'owner-change', proposal, {
    status: 'planning', request: 'r_original', origin: requester,
  });
  assert.deepEqual(itemSessionHistory(item), []);
  await queueNotice(context.runtime, { id: 'recipient-ruling', owner: 'homelab', workItem: item.id,
    change: 'ruling', text: 'Continue the original request.', origin: requester, at: new Date().toISOString() });
  await context.deliver();
  assert.equal(context.sends[0].body.agent, context.runtime.owner('homelab').persona!.name);
  assert.match(context.sends[0].body.parts[0].text, /r_original/);
  assert.doesNotMatch(context.sends[0].body.parts[0].text, /odrade's original context/);
  assert.equal((await rememberedSession(context.runtime, requester.sessionID))?.owner, 'odrade');
  assert.equal(context.queries.filter(query => query.directory === requester.directory).length, 0);
});

test('uncertain continuation creation fences only that identity, never blindly creates again', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_manager');
  const retired = await context.addSession('homelab', 'ses_retired', join(context.root, 'retired'), true);
  await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', text: 'Continue', session: retired }, sender, 'msg_one');
  const create = context.sdk.session.create.bind(context.sdk.session);
  context.sdk.session.create = async options => {
    await create(options);
    throw new Error('create_response_lost');
  };
  await assert.rejects(context.deliver(), /plugin_maintenance_effect_uncertain/);
  await assert.rejects(context.deliver(), /owner_message_continuation_creation_uncertain/);
  assert.equal(context.creates(), 1);
  assert.equal(context.sends.length, 0);
  const opening = (await new SessionOpeningStore(context.runtime.stateDirectory).list())[0];
  assert.equal(opening.phase, 'uncertain');
  assert.equal(opening.origin, undefined);
  assert.equal((await pendingNotices(context.runtime)).length, 1);
});

test('queue identity conflicts retain original content and delivered tombstone', async () => {
  const context = await messageFixture();
  const origin = await context.addSession('homelab', 'ses_owner');
  const notice = { id: ownerMessageId(['same']), owner: 'homelab', text: 'Original', origin, change: 'message', at: new Date().toISOString() };
  await queueNotice(context.runtime, notice);
  await assert.rejects(queueNotice(context.runtime, { ...notice, text: 'Overwritten' }), /work_notice_identity_conflict/);
  await context.deliver();
  await assert.rejects(queueNotice(context.runtime, { ...notice, text: 'Overwritten' }), /work_notice_identity_conflict/);
  assert.equal((await pendingNotices(context.runtime)).length, 0);
  const receipt = (await context.receipts())[0];
  await unlink(join(context.runtime.stateDirectory, 'notices', 'delivered', `${notice.id}.json`));
  await queueNotice(context.runtime, notice);
  await context.deliver();
  assert.equal(context.sends.length, 1, 'receipt repairs a missing delivered tombstone');
  assert.equal((await context.receipts())[0].messageID, receipt.messageID);
});

test('direct-request review of a report returns to the requester in a fresh owned continuation after its worktree is removed', async () => {
  const context = await messageFixture();
  const retired = await context.addSession('odrade', 'ses_old_manager', join(context.root, 'removed-manager'), true);
  const planner = await context.addSession('clippy', 'ses_report');
  const request = await requestWork(context.runtime, 'odrade', 'clippy', proposal, undefined, retired);
  await processRequest(context.runtime, request.id);
  const itemID = (await context.runtime.requests.get(request.id)).workItem!;
  await submitPlan(context.runtime, 'clippy', { ...proposal, plan: 'Option A', item: itemID }, planner);
  const review = await getDirectRequestReview(context.runtime, request.id);
  const scope = context.pass();
  await deliverDirectRequestReviews(context.runtime, planRevisionClient(scope.client(context.sdk), { runtime: context.runtime, pass: scope }), fail);
  assert.equal(context.sends.length, 1);
  assert.equal(context.sends[0].body.agent, 'Odrade');
  assert.notEqual(context.sends[0].path.id, planner.sessionID);
  assert.match(context.sends[0].body.parts[0].text, /odrade's original context/);
  assert.match(context.sends[0].body.parts[0].text, new RegExp(request.id));
  assert.equal((await directRequestReviewWakeStatus(context.runtime, request.id, review.digest))?.status, 'delivered');
  assert.equal(context.creates(), 1);
  assert.equal((await rememberedSession(context.runtime, retired.sessionID))?.owner, 'odrade');
  assert.equal((await context.runtime.ledger.get(itemID)).planApproval, undefined);
  assert.equal(context.queries.filter(query => query.directory === retired.directory).length, 0);
});

test('plan revision in a retired planner continues the original item and reconciles exact SDK receipt after acknowledgement loss', async () => {
  const context = await messageFixture();
  const retired = await context.addSession('homelab', 'ses_old_planner', join(context.root, 'removed-planner'), true);
  const item = await submitPlan(context.runtime, 'homelab', { ...proposal, plan: 'Option B' }, retired);
  await revisePlan(context.runtime, item.id, 'person', 'Use option A instead.');
  context.setMode('lost-reply');
  const first = context.pass();
  await deliverPlanRevisions(context.runtime, planRevisionClient(first.client(context.sdk), { runtime: context.runtime, pass: first }), fail);
  assert.equal((await planRevisionStatus(context.runtime, item.id))?.status, 'blocked');
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.runtime.stateDirectory });
  const next = context.pass();
  await deliverPlanRevisions(reopened, planRevisionClient(next.client(context.sdk), { runtime: reopened, pass: next }), fail);
  assert.equal((await planRevisionStatus(reopened, item.id))?.status, 'delivered');
  assert.equal(context.sends.length, 1);
  assert.equal(context.creates(), 1);
  assert.match(context.sends[0].body.parts[0].text, /homelab's original context/);
  assert.match(context.sends[0].body.parts[0].text, new RegExp(item.id));
  assert.equal((await reopened.ledger.list()).length, 1);
  assert.equal((await reopened.ledger.get(item.id)).status, 'planning');
  assert.equal(context.queries.filter(query => query.directory === retired.directory).length, 0);
});

test('a notice arriving before initial planning uses the canonical opener, never a second planner', async () => {
  const context = await messageFixture();
  const item = await context.runtime.ledger.create('homelab', 'owner-change', proposal, {
    status: 'planning', request: 'r_initial',
  });
  await queueNotice(context.runtime, { id: 'first-ruling', owner: 'homelab', workItem: item.id,
    change: 'manager-ruling', text: 'Use option A.', at: new Date().toISOString() });
  context.onPrompt(async prompt => {
    if (prompt.body.parts[0].text.includes('you accepted it')) context.busy.add(prompt.path.id);
  });
  await context.deliver();
  const opened = await context.runtime.ledger.get(item.id);
  assert.ok(opened.origin);
  assert.equal(opened.originOwner, 'homelab');
  const pass = context.pass();
  await openNeededSessions(context.runtime, ownerSessionClient(pass.client(context.sdk)), fail, pass);
  assert.equal(context.creates(), 1);
  assert.equal(context.sends.length, 1, 'canonical handoff is the only prompt while busy');
  assert.equal((await pendingNotices(context.runtime)).length, 1);
  context.busy.clear();
  await context.deliver();
  assert.equal(context.sends.length, 2);
  assert.equal(context.sends[1].path.id, opened.origin.sessionID);
  assert.equal(context.creates(), 1);
});

test('a retired continuation gets one fenced successor on retry without querying either retired directory', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_sender');
  const retired = await context.addSession('homelab', 'ses_original', join(context.root, 'old-original'), true);
  await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', session: retired, text: 'First correction.' }, sender, 'msg_first');
  await context.deliver();
  const first = context.sends[0];
  context.sessions.get(first.path.id)!.time.archived = 1;
  context.queries.length = 0;
  await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', session: retired, text: 'Second correction.' }, sender, 'msg_second');
  await context.deliver();
  assert.equal(context.creates(), 2);
  assert.notEqual(context.sends[1].path.id, first.path.id);
  const second = context.sends[1];
  await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', session: retired, text: 'Third correction.' }, sender, 'msg_third');
  await context.deliver();
  assert.equal(context.creates(), 2);
  assert.equal(context.sends[2].path.id, second.path.id);
  assert.equal((await rememberedSession(context.runtime, first.path.id))?.archived, true);
  assert.equal(context.queries.filter(query => query.directory === retired.directory).length, 0);
});

test('a positively not-sent notice reroutes with the SAME message ID after its workspace disappears', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_sender');
  const recipient = await context.addSession('homelab', 'ses_recipient');
  await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', session: recipient, text: 'Requested correction.' }, sender, 'msg_one');
  const pass = context.pass();
  const check = pass.check.bind(pass);
  pass.check = () => {
    if (existsSync(join(context.runtime.stateDirectory, 'notices', 'delivery'))) pass.stop();
    check();
  };
  await assert.rejects(context.deliver(context.runtime, pass), /plugin_maintenance_stopped/);
  const receipt = (await context.receipts())[0];
  assert.equal(receipt.status, 'not-sent');
  await rm(recipient.directory, { recursive: true, force: true });
  context.queries.length = 0;
  await context.deliver();
  assert.equal(context.sends.length, 1);
  assert.notEqual(context.sends[0].path.id, recipient.sessionID);
  assert.equal(context.sends[0].body.messageID, receipt.messageID);
  assert.equal((await context.receipts()).length, 1);
  assert.equal((await context.receipts())[0].status, 'sent');
  assert.equal(context.queries.filter(query => query.directory === recipient.directory).length, 0);
});

test('a retired execution session falls back to its proven live planning origin', async () => {
  const context = await assignedFixture();
  const retired = await context.addSession('clippy', 'ses_execution_retired', join(context.root, 'removed-execution'), true);
  await context.runtime.ledger.update(context.item.id, current => ({ ...current, session: retired }));
  await steerReportItem(context.runtime, 'odrade', context.item.id, 'note', 'Continue with option A.');
  await context.deliver();
  assert.equal(context.creates(), 0);
  assert.equal(context.sends.filter(send => send.path.id === context.planner.sessionID).length, 1);
  assert.equal(context.queries.filter(query => query.directory === retired.directory).length, 0);
});

test('a continuation whose approved worktree is removed moves to the declared desk without recreating that worktree', async () => {
  const context = await messageFixture();
  const retired = await context.addSession('homelab', 'ses_old_execution', join(context.root, 'old-execution'), true);
  const worktree = join(context.root, 'approved-worktree');
  await mkdir(worktree);
  const item = await context.runtime.ledger.create('homelab', 'owner-change', proposal, {
    status: 'working', session: retired, planWorktree: worktree,
    planApproval: { by: 'person', at: new Date().toISOString() },
  });

  const notice = { owner: 'homelab', workItem: item.id, origin: retired, change: 'manager-ruling',
    text: 'Continue this approved work.', at: new Date().toISOString() };
  await queueNotice(context.runtime, { ...notice, id: 'worktree-ruling-one' });
  await context.deliver();
  assert.equal(context.sends[0].query.directory, worktree);
  await rm(worktree, { recursive: true, force: true });
  context.queries.length = 0;
  await queueNotice(context.runtime, { ...notice, id: 'worktree-ruling-two' });
  await context.deliver();
  assert.notEqual(context.sends[1].query.directory, worktree);
  assert.notEqual(context.sends[1].path.id, context.sends[0].path.id);
  assert.equal(context.creates(), 2);
  assert.equal(context.queries.filter(query => query.directory === worktree).length, 0);
  await assert.rejects(access(worktree));
  assert.equal((await rememberedSession(context.runtime, context.sends[0].path.id))?.archived, true);
  assert.equal((await context.runtime.ledger.get(item.id)).planApproval?.by, 'person');
});

test('unaddressed peer messages use general declared-workspace chat, never an unrelated recent work session', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_sender');
  const general = await context.addSession('homelab', 'ses_general', chatPath(context.runtime, 'homelab'));
  const work = await context.addSession('homelab', 'ses_unrelated_work');
  const session = await rememberedSession(context.runtime, work.sessionID);
  await rememberSession(context.runtime, { ...session!, item: 'w_unrelated', time: { created: 1, updated: 999 } });
  const notice = await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', text: 'General correction.' }, sender, 'msg_general');
  assert.deepEqual(notice.origin, general);
  await context.deliver();
  assert.equal(context.sends[0].path.id, general.sessionID);
  assert.equal(context.creates(), 0);
});

test('without a general chat, unaddressed messages use a fenced desk continuation instead of borrowing an active work session', async () => {
  const context = await messageFixture();
  const sender = await context.addSession('odrade', 'ses_sender');
  const work = await context.addSession('homelab', 'ses_unrelated_work', chatPath(context.runtime, 'homelab'));
  const session = await rememberedSession(context.runtime, work.sessionID);
  await rememberSession(context.runtime, { ...session!, item: 'w_unrelated' });
  const notice = await sendOwnerMessage(context.runtime, 'odrade', { to: 'homelab', text: 'General correction.' }, sender, 'msg_general');
  assert.equal(notice.origin, undefined);
  await context.deliver();
  assert.notEqual(context.sends[0].path.id, work.sessionID);
  assert.equal(context.sends[0].query.directory, chatPath(context.runtime, 'homelab'));
  assert.equal(context.creates(), 1);
});
