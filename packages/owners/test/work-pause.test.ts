import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Runtime, humanWorkActor, pauseItem, resumeItem, settleItemPause, workPauseClient } from '@onionsoup/owners';
import { trackDelegatedWork } from '../src/delegation.ts';
import { isRunnable } from '../src/work-recovery.ts';
import { isFinished } from '../src/ledger.ts';
import { neededSession, openNeededSessions } from '../src/owner-sessions.ts';
import { pendingNotices } from '../src/notices.ts';
import { managerWorkActor, pausedSessionItem, stoppedRunnerPause } from '../src/work-pause.ts';
import { SessionOpeningStore } from '../src/session-opening-store.ts';
import { rememberSession } from '../src/session-history.ts';
import { advanceDeskPublication } from '../src/desk-changes.ts';
import { requestProgress } from '../src/request-status.ts';
import { reconcileRequest } from '../src/request-recovery.ts';
import { submitPlan } from '../src/plan-work.ts';

const proposal = {
  title: 'Original approved work', goal: 'Preserve this original outcome', rationale: 'Regression',
  acceptance: ['Original acceptance criteria'], size: 'small' as const,
};

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(process.cwd(), '.pause-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  await runtime.notebook('clippy').ensure('# Charter\n');
  return { runtime, root };
}

test('intentional pause preserves approved intent and rejects forged human names and prose', async context => {
  const { runtime } = await fixture(context);
  const approved = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', planDocument: { markdown: '1. Carry out the original work', digest: 'original' },
    planApproval: { by: 'original-human', at: '2026-10-01T00:00:00Z' },
  });
  await assert.rejects(pauseItem(runtime, approved.id, { by: 'person', authority: 'human' }, 'Stop'), /human_required/);
  const paused = await pauseItem(runtime, approved.id, humanWorkActor(), 'Intentional stop');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.activeRunner, undefined);
  assert.equal(isRunnable(paused), false);
  assert.equal(isFinished(paused), false);
  assert.equal(neededSession(paused), undefined);
  assert.equal(paused.pauses[0]?.resumeStatus, 'working');
  assert.ok(paused.pauses[0]?.stoppedAt);
  const repeated = await pauseItem(runtime, approved.id, humanWorkActor(), 'Do not duplicate');
  assert.equal(repeated.pauses.length, 1);
  await assert.rejects(resumeItem(runtime, approved.id, 'person says resume'), /human_required/);
  let created = false;
  await openNeededSessions(runtime, {
    create: async () => { created = true; throw new Error('unexpected_create'); },
    prompt: async () => { throw new Error('unexpected_prompt'); },
    remove: async () => {}, activity: async () => ({ isBusy: false, updatedAt: 1 }),
  }, () => {});
  assert.equal(created, false);
  const resumed = await resumeItem(runtime, approved.id, humanWorkActor());
  assert.equal(resumed.status, 'working');
  assert.deepEqual(resumed.proposal, approved.proposal);
  assert.deepEqual(resumed.planDocument, approved.planDocument);
  assert.deepEqual(resumed.planApproval, approved.planApproval);
  assert.deepEqual(resumed.humanNotes.map(note => note.kind), ['pause', 'resume']);
  assert.equal((await resumeItem(runtime, approved.id, humanWorkActor())).pauses.length, 1);
});

test('restart repairs a crash before request pause projection without reporting paused work as running', async context => {
  const { runtime } = await fixture(context);
  await runtime.notebook('homelab').ensure('# Requester charter\n');
  const request = await runtime.requests.open('homelab', 'clippy', {
    kind: 'work', purpose: proposal.goal, proposal,
  }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    id: `w-request-${request.id}`, status: 'working', request: request.id,
  });
  const linked = await runtime.requests.save({ ...request, status: 'work-running', workItem: item.id });
  await pauseItem(runtime, item.id, humanWorkActor(), 'Intentionally stopped before restart');
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  for (const stage of ['work-running', 'pending-owner'] as const) {
    await runtime.requests.save({
      ...linked, status: 'interrupted',
      operation: { id: `pre-pause-${stage}`, stage, startedAt: new Date().toISOString() },
    });
    const recovered = await reconcileRequest(reopened, request.id);
    assert.equal(recovered.status, 'work-paused');
    assert.equal(requestProgress(recovered, await reopened.ledger.get(item.id)).workStatus, 'paused');
  }
  assert.equal((await reopened.ledger.get(item.id)).status, 'paused');
  assert.equal(neededSession(await reopened.ledger.get(item.id)), undefined);
});

test('request recovery commits a fresh paused projection when human pause races its earlier running snapshot', { timeout: 10_000 }, async context => {
  const { runtime } = await fixture(context);
  await runtime.notebook('homelab').ensureJournal();
  const request = await runtime.requests.open('homelab', 'clippy', {
    kind: 'work', purpose: proposal.goal, proposal,
  }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', request: request.id,
  });
  await runtime.requests.update(request.id, current => ({
    ...current, status: 'interrupted', workItem: item.id,
    operation: { id: 'original-interrupted-operation', stage: 'work-running', startedAt: current.createdAt },
  }));
  let pause: ReturnType<typeof pauseItem> | undefined;
  let pauseRecorded!: () => void;
  const recorded = new Promise<void>(resolve => { pauseRecorded = resolve; });
  const update = runtime.ledger.updateIfChanged.bind(runtime.ledger);
  runtime.ledger.updateIfChanged = async (id, change) => {
    const updated = await update(id, change);
    if (id === item.id && updated.status === 'pausing') pauseRecorded();
    return updated;
  };
  const inspect = runtime.ledger.inspectLocked.bind(runtime.ledger);
  runtime.ledger.inspectLocked = async (id, commit) => {
    pause = pauseItem(runtime, item.id, humanWorkActor(), 'Pause before the guarded request commit');
    await recorded;
    return inspect(id, commit);
  };
  const recovered = await reconcileRequest(runtime, request.id);
  await pause;
  assert.equal(recovered.status, 'work-paused');
  assert.equal((await runtime.requests.get(request.id)).status, 'work-paused');
  const paused = await runtime.ledger.get(item.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauses.length, 1);
  assert.equal(paused.pauses[0]?.resumeStatus, 'working');
  assert.deepEqual(paused.proposal, item.proposal);
});

test('stopping aborts busy descendants and requires positive idle proof before becoming paused', async context => {
  const { runtime, root } = await fixture(context);
  const session = { sessionID: 'ses_parent', directory: root };
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', session });
  let isChildBusy = true;
  const aborts: string[] = [];
  const client = workPauseClient({
    sessions: async () => [{ id: session.sessionID }, { id: 'ses_child', parentID: session.sessionID }],
    statuses: async () => isChildBusy ? { ses_child: { type: 'busy' } } : {},
    abort: async (_directory, id) => { aborts.push(id); },
  });
  assert.equal((await pauseItem(runtime, item.id, humanWorkActor(), 'Stop the actual execution')).status, 'pausing');
  assert.equal((await settleItemPause(runtime, item.id, client)).status, 'pausing');
  assert.deepEqual(aborts, ['ses_child']);
  await assert.rejects(resumeItem(runtime, item.id, humanWorkActor()), /work_not_paused/);
  isChildBusy = false;
  assert.equal((await settleItemPause(runtime, item.id, client)).status, 'paused');
  await rememberSession(runtime, {
    id: 'ses_child', parentID: session.sessionID, owner: 'clippy', directory: root,
    title: 'Child', time: { created: 1, updated: 1 },
  });
  assert.equal((await pausedSessionItem(runtime, 'ses_child'))?.id, item.id);
  await resumeItem(runtime, item.id, humanWorkActor());
  const notices = await pendingNotices(runtime);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.origin?.sessionID, session.sessionID);
  assert.match(notices[0]!.text, /ORIGINAL work/);
  await resumeItem(runtime, item.id, humanWorkActor());
  assert.equal((await pendingNotices(runtime)).length, 1, 'lost resume replies cannot duplicate the wake');
});

test('uncertain stop and session opening retain receipts and cannot become stopped by assertion', async context => {
  const { runtime, root } = await fixture(context);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', session: { sessionID: 'ses_uncertain', directory: root },
  });
  await pauseItem(runtime, item.id, humanWorkActor(), 'Pause with unavailable server');
  await assert.rejects(settleItemPause(runtime, item.id, { stop: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await runtime.ledger.get(item.id)).pauses[0]?.stopAttempt, 'uncertain');
  const opening = new SessionOpeningStore(runtime.stateDirectory);
  const claim = await opening.reserve({ entity: 'owner-item', id: item.id, owner: item.owner, kind: 'execution' });
  assert.ok(claim);
  await opening.advance(claim, 'creating', { directory: root });
  await opening.failed(claim);
  const before = await readFile(opening.path(claim.key), 'utf8');
  let observed = false;
  await settleItemPause(runtime, item.id, { stop: async () => { observed = true; return true; } });
  assert.equal(observed, false);
  assert.equal((await runtime.ledger.get(item.id)).status, 'pausing');
  assert.equal(await readFile(opening.path(claim.key), 'utf8'), before);
});

test('host step completion conserves the runner claim until its exact next checkpoint is saved', async context => {
  const { runtime } = await fixture(context);
  const item = await runtime.ledger.create('clippy', 'rebase', proposal, { status: 'reviewing', activeRunner: process.pid });
  const requested = await pauseItem(runtime, item.id, humanWorkActor(), 'Stop at a safe checkpoint');
  assert.equal(requested.status, 'pausing');
  assert.equal(requested.activeRunner, process.pid);
  await runtime.ledger.markInterrupted();
  assert.equal((await runtime.ledger.get(item.id)).activeRunner, process.pid);
  await runtime.ledger.update(item.id, current => stoppedRunnerPause(current, {
    ...item, status: 'awaiting-push-approval', verdicts: [{ decision: 'approve', summary: 'Approved', findings: [] }],
  }, item));
  const paused = await settleItemPause(runtime, item.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.activeRunner, undefined);
  assert.equal(paused.verdicts.length, 1);
  assert.equal(paused.pauses[0]?.resumeStatus, 'awaiting-push-approval');
  assert.equal((await resumeItem(runtime, item.id, humanWorkActor())).status, 'awaiting-push-approval');
  const publication = await runtime.ledger.create('clippy', 'desk-publication', proposal, { status: 'landing' });
  await pauseItem(runtime, publication.id, humanWorkActor(), 'Do not publish');
  await assert.rejects(advanceDeskPublication(runtime, publication.id), /work_item_paused/);
  assert.equal((await runtime.ledger.get(publication.id)).activeRunner, undefined);
});

test('stale runner snapshots cannot overwrite pause or release a newer claim owned by the same PID', async context => {
  const { runtime } = await fixture(context);
  const original = await runtime.ledger.create('clippy', 'rebase', proposal, {
    status: 'reviewing', activeRunner: process.pid, runnerClaim: randomUUID(),
  });
  await runtime.ledger.update(original.id, current => stoppedRunnerPause(current, current, original));
  const claimed = await runtime.ledger.update(original.id, current => ({
    ...current, activeRunner: process.pid, runnerClaim: randomUUID(),
  }));
  const pausing = await pauseItem(runtime, claimed.id, humanWorkActor(), 'Stop only the current claim');
  assert.equal(pausing.activeRunner, process.pid);
  assert.equal(pausing.runnerClaim, claimed.runnerClaim);
  await assert.rejects(runtime.ledger.save({ ...original, status: 'landed', activeRunner: undefined, runnerClaim: undefined }),
    /work_item_pause_changed/);
  await assert.rejects(runtime.ledger.update(original.id, current => stoppedRunnerPause(current, {
    ...original, status: 'landed',
  }, original)), /work_item_runner_changed/);
  await assert.rejects(runtime.ledger.save({ ...pausing, activeRunner: undefined, runnerClaim: undefined }),
    /work_item_runner_changed/);
  assert.deepEqual(await runtime.ledger.get(original.id), pausing);
  await runtime.ledger.markInterrupted();
  assert.equal((await runtime.ledger.get(original.id)).runnerClaim, claimed.runnerClaim);
  await runtime.ledger.update(original.id, current => ({ ...current, replans: current.replans + 1 }));
  await runtime.ledger.update(original.id, current => stoppedRunnerPause(current, {
    ...claimed, status: 'awaiting-push-approval',
  }, claimed));
  const paused = await settleItemPause(runtime, original.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.activeRunner, undefined);
  assert.equal(paused.runnerClaim, undefined);
  assert.equal(paused.replans, 1, 'the runner applies its checkpoint delta, not a stale whole-record snapshot');
  assert.equal(paused.pauses[0]?.resumeStatus, 'awaiting-push-approval');
  await assert.rejects(runtime.ledger.save(pausing), /work_item_pause_changed/);
  assert.equal((await resumeItem(runtime, original.id, humanWorkActor())).status, 'awaiting-push-approval');
});

test('restart clears only a dead runner claim while preserving intentional pause and original stage', async context => {
  const { runtime } = await fixture(context);
  const item = await runtime.ledger.create('clippy', 'rebase', proposal, {
    status: 'reviewing', activeRunner: 999999, runnerClaim: randomUUID(),
  });
  const pausing = await pauseItem(runtime, item.id, humanWorkActor(), 'Remain intentionally stopped after restart');
  assert.equal(pausing.status, 'pausing');
  assert.equal(await runtime.ledger.markInterrupted(), 1);
  const recovered = await runtime.ledger.get(item.id);
  assert.equal(recovered.status, 'pausing');
  assert.equal(recovered.activeRunner, undefined);
  assert.equal(recovered.runnerClaim, undefined);
  assert.deepEqual(recovered.pauses, pausing.pauses);
  const paused = await settleItemPause(runtime, item.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauses[0]?.resumeStatus, 'reviewing');
  assert.equal((await resumeItem(runtime, item.id, humanWorkActor())).status, 'reviewing');
});

test('delegated projections remain paused even after external merge; only configured authority resumes original work', async context => {
  const { runtime } = await fixture(context);
  const request = await runtime.requests.open('odrade', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', request: request.id, planDocument: { markdown: 'Original plan', digest: 'approved' },
    planApproval: { by: 'human', at: '2026-10-01T00:00:00Z' },
  });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id }));
  await pauseItem(runtime, item.id, humanWorkActor(), 'Defer this request');
  await runtime.ledger.update(item.id, current => ({
    ...current, publication: { url: 'https://github.com/example/clippy/pull/1', branch: 'original', by: 'runtime', at: '', state: 'merged' },
  }));
  const projected = await trackDelegatedWork(runtime, await runtime.requests.get(request.id));
  const paused = await runtime.ledger.get(item.id);
  assert.equal(projected.status, 'work-paused');
  assert.equal(requestProgress(projected, paused).workStatus, 'paused');
  await assert.rejects(managerWorkActor(runtime, 'bellonda', paused), /grant_required/);
  const actor = await managerWorkActor(runtime, 'odrade', paused);
  const declared = runtime.owner('clippy');
  runtime.declarations.owners.set('clippy', { ...declared, grants: [] });
  await assert.rejects(resumeItem(runtime, item.id, actor), /grant_required/);
  runtime.declarations.owners.set('clippy', declared);
  const resumed = await resumeItem(runtime, item.id, actor, 'Continue the approved plan');
  assert.equal(resumed.status, 'working');
  assert.equal(resumed.request, request.id);
  assert.equal(resumed.pauses[0]?.resumedAuthority, 'standing-grant');
  assert.equal((await runtime.requests.get(request.id)).status, 'work-running');
});

test('an edited goal or approval cannot be resumed under an older pause receipt', async context => {
  const { runtime } = await fixture(context);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working' });
  await pauseItem(runtime, item.id, humanWorkActor(), 'Stop');
  await runtime.ledger.update(item.id, current => ({ ...current, proposal: { ...current.proposal, goal: 'Replacement goal' } }));
  await assert.rejects(resumeItem(runtime, item.id, humanWorkActor()), /work_pause_binding_changed/);
  assert.equal((await runtime.ledger.get(item.id)).status, 'paused');
});

test('pausing submitted plans and publications without execution never stops or fences their shared desk origin', async context => {
  const { runtime, root } = await fixture(context);
  const origin = { sessionID: 'ses_shared_desk', directory: root };
  const plan = await submitPlan(runtime, 'clippy', {
    title: proposal.title, goal: proposal.goal, plan: 'The original unapproved plan',
  }, origin);
  const publication = await runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'landing', origin,
  });
  await rememberSession(runtime, {
    id: 'ses_other_desk_child', parentID: origin.sessionID, owner: 'clippy', directory: root,
    title: 'Unrelated desk work', time: { created: 1, updated: 1 },
  });
  for (const created of [plan, publication]) {
    const original = await runtime.ledger.get(created.id);
    assert.equal(original.session, undefined);
    const paused = await pauseItem(runtime, original.id, humanWorkActor(), 'Pause only this item');
    assert.equal(paused.status, 'paused');
    assert.equal((await settleItemPause(runtime, original.id, {
      stop: async () => { throw new Error('must_not_abort_shared_desk'); },
    })).status, 'paused');
    assert.equal(await pausedSessionItem(runtime, origin.sessionID), undefined);
    assert.equal(await pausedSessionItem(runtime, 'ses_other_desk_child'), undefined);
    const resumed = await resumeItem(runtime, original.id, humanWorkActor());
    assert.equal(resumed.status, original.status);
    assert.deepEqual(resumed.proposal, original.proposal);
    assert.deepEqual(resumed.planDocument, original.planDocument);
  }
  assert.deepEqual(await pendingNotices(runtime), []);
});

test('an obsolete uncertain planning opening cannot wedge a later exact approved execution pause', async context => {
  const { runtime, root } = await fixture(context);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'planning',
  });
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const reservation = await store.reserve({ entity: 'owner-item', id: item.id, owner: item.owner, kind: 'planning' });
  assert.ok(reservation);
  await store.advance(reservation, 'creating', { directory: root });
  await store.failed(reservation);
  const uncertain = await readFile(store.path(reservation.key), 'utf8');
  const session = { sessionID: 'ses_later_approved_execution', directory: root };
  await runtime.ledger.update(item.id, current => ({
    ...current, status: 'working', session, planApproval: { by: 'person', at: current.createdAt },
  }));
  await pauseItem(runtime, item.id, humanWorkActor(), 'Stop the exact later execution');
  const stopped: string[] = [];
  const paused = await settleItemPause(runtime, item.id, { stop: async target => {
    stopped.push(target.sessionID);
    return true;
  } });
  assert.equal(paused.status, 'paused');
  assert.deepEqual(stopped, [session.sessionID]);
  assert.deepEqual(await pausedSessionItem(runtime, session.sessionID), paused);
  assert.equal(await readFile(store.path(reservation.key), 'utf8'), uncertain);
  assert.equal((await resumeItem(runtime, item.id, humanWorkActor())).status, 'working');
});

test('an uncertain planning prompt stays fenced without proof of a distinct later execution', async context => {
  const { runtime, root } = await fixture(context);
  const origin = { sessionID: 'ses_uncertain_planning', directory: root };
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'planning' });
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const reservation = await store.reserve({ entity: 'owner-item', id: item.id, owner: item.owner, kind: 'planning' });
  assert.ok(reservation);
  await store.advance(reservation, 'creating', { directory: root });
  await store.advance(reservation, 'created', { origin });
  await store.advance(reservation, 'prompting');
  await store.failed(reservation);
  const uncertain = await readFile(store.path(reservation.key), 'utf8');
  await runtime.ledger.update(item.id, current => ({
    ...current, status: 'working', session: origin, planApproval: { by: 'person', at: current.createdAt },
  }));
  await pauseItem(runtime, item.id, humanWorkActor(), 'Keep the unknown prompt fenced');
  for (const session of [origin, undefined]) {
    await runtime.ledger.update(item.id, current => ({ ...current, session }));
    assert.equal((await settleItemPause(runtime, item.id, {
      stop: async () => { throw new Error('unknown_prompt_is_not_idle_proof'); },
    })).status, 'pausing');
    assert.equal((await pausedSessionItem(runtime, origin.sessionID))?.id, item.id);
    assert.equal(await readFile(store.path(reservation.key), 'utf8'), uncertain);
  }
});
