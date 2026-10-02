import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { humanWorkActor, pauseItem, settleItemPause } from '../src/work-pause.ts';
import { resumeItem } from '../src/work-recovery.ts';
import { workPauseClient } from '../src/work-pause-client.ts';
import { OWNER_SESSIONS, openOwnerSession, ownerSessionClient, type OwnerSessionKind } from '../src/owner-sessions.ts';
import type { WorkItem } from '../src/ledger.ts';
import { SessionOpeningStore } from '../src/session-opening-store.ts';
import { pendingNotices, readNotice } from '../src/notices.ts';
import { git } from '../src/workspace.ts';
import { messageFixture } from './owner-message-fixture.ts';

const proposal = {
  title: 'The original requested outcome', goal: 'Keep the declared runtime healthy',
  rationale: 'Its original requester depends on this runtime',
  acceptance: ['The original configured check passes', 'The exact gated resources are cleaned up'],
  size: 'small' as const,
};
const INITIAL_WORK: Record<OwnerSessionKind, Partial<WorkItem>> = {
  planning: { status: 'planning' },
  execution: {
    status: 'working', planDocument: { markdown: 'The original approved steps', digest: 'original-plan' },
    planApproval: { by: 'original-human', at: '2026-10-01T00:00:00Z' },
    humanNotes: [{ kind: 'approval', by: 'original-human', at: '2026-10-01T00:00:00Z', note: 'Preserve the approved scope' }],
  },
};
const ASSERT_CONTEXT: Record<OwnerSessionKind, (text: string, item: WorkItem) => void> = {
  planning: (text, item) => {
    assert.ok(text.includes(`request ${item.request}`));
    assert.ok(text.includes(`onionsoup_submit_plan with item "${item.id}"`));
    assert.ok(text.includes(item.proposal.rationale));
    assert.ok(item.proposal.acceptance.every(criterion => text.includes(criterion)));
  },
  execution: (text, item) => {
    assert.ok(text.includes(item.planWorktree!));
    assert.ok(text.includes(item.planDocument!.markdown));
    assert.ok(text.includes('Preserve the approved scope'));
    assert.ok(text.includes(`onionsoup_propose_changes with item "${item.id}"`));
    assert.ok(text.includes(`onionsoup_complete_work item "${item.id}"`));
    assert.ok(text.includes('onionsoup_request_instance and onionsoup_release_instance'));
  },
};

async function fixture(context: TestContext, kind: OwnerSessionKind) {
  const transport = await messageFixture();
  context.after(() => rm(transport.root, { recursive: true, force: true }));
  const { runtime } = transport;
  const owner = runtime.repositoryOwner('homelab');
  const remote = join(transport.root, 'origin.git');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  await git(owner.workspace, ['remote', 'add', 'origin', remote]);
  await git(owner.workspace, ['push', '-qu', 'origin', 'main']);
  runtime.declarations.owners.set(owner.id, { ...owner, domain: { ...owner.domain, remote, verify: [] } });
  const request = await runtime.requests.open('bellonda', owner.id, { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create(owner.id, 'owner-change', proposal, {
    ...INITIAL_WORK[kind], request: request.id,
  });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id }));
  const client = ownerSessionClient(transport.sdk);
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const key = { entity: 'owner-item' as const, id: item.id, owner: item.owner, kind };
  const stop = workPauseClient({
    sessions: async directory => [...transport.sessions.values()].filter(session => session.directory === directory),
    statuses: async () => ({}),
    abort: async () => { throw new Error('must_not_abort_idle_session'); },
  });
  return { ...transport, item, request, client, store, key, stop };
}

for (const kind of ['planning', 'execution'] as const) {
  test(`a blank ${kind} session receives its exact original workflow prompt once through a durable resume notice`, async context => {
    const fixtureState = await fixture(context, kind);
    const { runtime, item, client, store, key } = fixtureState;
    const create = client.create.bind(client);
    client.create = async (...args) => {
      const sessionID = await create(...args);
      await pauseItem(runtime, item.id, humanWorkActor(), 'Pause before the initial stage prompt');
      return sessionID;
    };
    await assert.rejects(openOwnerSession(runtime, client, item.id), /work_item_paused/);
    const opening = await store.read(key);
    assert.equal(opening?.disposition, 'not-prompted');
    assert.deepEqual(fixtureState.transcripts.get(opening!.origin!.sessionID) ?? [], []);
    assert.equal(fixtureState.sends.length, 0);
    assert.equal((await settleItemPause(runtime, item.id, fixtureState.stop)).status, 'paused');
    const retainedOpening = await readFile(store.path(key), 'utf8');
    const resumed = await resumeItem(runtime, item.id, humanWorkActor());
    const expectedPrompt = OWNER_SESSIONS[kind].prompt(resumed);
    const notice = (await pendingNotices(runtime))[0]!;
    assert.equal(notice.change, 'human-resume');
    assert.equal(notice.workItem, item.id);
    assert.deepEqual(notice.origin, opening!.origin);
    assert.ok(notice.text.endsWith(expectedPrompt));
    ASSERT_CONTEXT[kind](notice.text, resumed);
    await resumeItem(runtime, item.id, humanWorkActor());
    assert.equal((await pendingNotices(runtime)).length, 1);
    assert.deepEqual(await readNotice(runtime, notice.id), notice);
    fixtureState.setMode('lost-reply');
    await assert.rejects(fixtureState.deliver(), /plugin_maintenance_effect_uncertain/);
    const receipt = (await fixtureState.receipts())[0]!;
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.noticeID, notice.id);
    assert.notEqual(receipt.messageID, opening!.messageID);
    assert.deepEqual(receipt.origin, opening!.origin);
    assert.ok(receipt.text!.endsWith(expectedPrompt));
    ASSERT_CONTEXT[kind](receipt.text!, resumed);
    await pauseItem(runtime, item.id, humanWorkActor(), 'Pause before the uncertain introduction reconciles');
    assert.equal((await settleItemPause(runtime, item.id, fixtureState.stop)).status, 'paused');
    await resumeItem(runtime, item.id, humanWorkActor());
    assert.equal((await pendingNotices(runtime)).length, 1);
    assert.equal((await pendingNotices(runtime))[0]!.id, notice.id);
    assert.deepEqual(await readNotice(runtime, notice.id), notice);
    const restarted = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
    await resumeItem(restarted, item.id, humanWorkActor());
    await Promise.all([fixtureState.deliver(restarted), fixtureState.deliver(restarted)]);
    await fixtureState.deliver(restarted);
    assert.deepEqual(await pendingNotices(restarted), []);
    assert.equal((await fixtureState.receipts()).length, 1);
    assert.equal((await fixtureState.receipts())[0]!.status, 'sent');
    assert.equal(fixtureState.sends.length, 1);
    assert.equal(fixtureState.sends[0]!.path.id, opening!.origin!.sessionID);
    assert.equal(fixtureState.sends[0]!.query.directory, opening!.origin!.directory);
    assert.equal(fixtureState.sends[0]!.body.messageID, receipt.messageID);
    assert.equal(fixtureState.sends[0]!.body.parts[0]!.text, receipt.text);
    assert.equal(fixtureState.creates(), 1);
    assert.equal(fixtureState.sessions.size, 1);
    assert.equal(await readFile(store.path(key), 'utf8'), retainedOpening);
    const persisted = await restarted.ledger.get(item.id);
    assert.equal(persisted.status, INITIAL_WORK[kind].status);
    assert.deepEqual(persisted.proposal, item.proposal);
    assert.deepEqual(persisted.planApproval, item.planApproval);
    assert.deepEqual(persisted.planDocument, item.planDocument);
    assert.equal(persisted.request, fixtureState.request.id);
    await pauseItem(runtime, item.id, humanWorkActor(), 'Pause after the introduction was positively received');
    assert.equal((await settleItemPause(runtime, item.id, fixtureState.stop)).status, 'paused');
    await resumeItem(runtime, item.id, humanWorkActor());
    const laterNotice = (await pendingNotices(runtime))[0]!;
    assert.notEqual(laterNotice.id, notice.id);
    assert.equal(laterNotice.text.includes(expectedPrompt), false);
    fixtureState.setMode('accept');
    await fixtureState.deliver();
    await fixtureState.deliver();
    assert.equal(fixtureState.sends.length, 2);
    assert.equal(fixtureState.sends.filter(send => send.body.parts[0]!.text.includes(expectedPrompt)).length, 1);
    assert.equal(fixtureState.creates(), 1);
  });
}

test('an already prompted execution receives only generic resume, never another initial workflow prompt', async context => {
  const fixtureState = await fixture(context, 'execution');
  const { runtime, item, client, store, key } = fixtureState;
  await openOwnerSession(runtime, client, item.id);
  const opening = await store.read(key);
  assert.equal(opening?.phase, 'opened');
  assert.equal(fixtureState.sends.length, 1);
  await pauseItem(runtime, item.id, humanWorkActor(), 'Pause previously started execution');
  assert.equal((await settleItemPause(runtime, item.id, fixtureState.stop)).status, 'paused');
  const resumed = await resumeItem(runtime, item.id, humanWorkActor());
  const notice = (await pendingNotices(runtime))[0]!;
  assert.equal(notice.text.includes(OWNER_SESSIONS.execution.prompt(resumed)), false);
  assert.equal(notice.text.includes('subagent-driven-development'), false);
  await Promise.all([fixtureState.deliver(), fixtureState.deliver()]);
  await resumeItem(runtime, item.id, humanWorkActor());
  await fixtureState.deliver();
  assert.equal(fixtureState.sends.length, 2);
  assert.equal((await fixtureState.receipts()).length, 1);
  assert.equal(fixtureState.creates(), 1);
  assert.deepEqual((await runtime.ledger.get(item.id)).session, opening!.origin);
});
