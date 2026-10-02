import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { readFrictionTriage, type FrictionTriage } from '../src/friction-work.ts';
import { effectiveProposalDigest, frictionInvestigationView, frictionPromotionHistory, frictionPromotionView, frictionProposalDigest, promoteFriction,
  recoverFrictionPromotions, retryFrictionPromotion } from '../src/friction-promotion.ts';
import { frictionFreshness, investigationDirectory, readRevisions, revalidateFriction, writeRevision } from '../src/friction-revalidation.ts';

const id = 'fr_012345678901234567890123';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'friction-promotion-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  runtime.declarations.root = root;
  runtime.preflightHire = async () => {};
  const workspace = join(root, 'source');
  await mkdir(workspace);
  runtime.declarations.owners.get('clippy')!.workspace = workspace;
  execFileSync('git', ['init', '--quiet', workspace]);
  await writeFile(join(workspace, 'check.ts'), 'export const check = true;\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  const commit = (message: string) => {
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', message]);
    return execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const first = commit('A');
  const triage: FrictionTriage = { version: 1, id, state: 'investigated', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    policy: { version: 1, owner: 'clippy', repository: 'example/clippy', enabledSince: '2026-01-01T00:00:00.000Z', intervalMs: 3600000 },
    sourceCommit: first, investigation: { observed: ['src/check.ts'], inferred: [], unknown: [], disposition: 'propose-fix',
      proposedWork: { title: 'Fix check', goal: 'Useful check', rationale: 'Evidence missing', size: 'small', repository: 'example/clippy', acceptance: ['Regression passes'] } } };
  const directory = join(runtime.stateDirectory, 'friction/investigations');
  await mkdir(directory, { recursive: true });
  const save = () => writeFile(join(directory, `${id}.json`), JSON.stringify(triage));
  await save();
  return { root, workspace, commit, runtime, triage, save, digest: frictionProposalDigest(triage)! };
}
function fail(_id: string, error: unknown): never { throw error; }

test('proposal digest survives schema parsing and property order changes', async () => {
  const { runtime, triage, digest } = await fixture();
  assert.equal(frictionProposalDigest((await readFrictionTriage(runtime, id))!), digest);
  triage.investigation!.proposedWork = Object.fromEntries(Object.entries(triage.investigation!.proposedWork!).reverse()) as NonNullable<FrictionTriage['investigation']>['proposedWork'];
  assert.equal(frictionProposalDigest(triage), digest);
  triage.investigation = Object.fromEntries(Object.entries(triage.investigation!).reverse()) as FrictionTriage['investigation'];
  assert.equal(frictionProposalDigest(triage), digest);
  triage.investigation!.proposedWork!.acceptance.push('Second criterion');
  const ordered = frictionProposalDigest(triage);
  triage.investigation!.proposedWork!.acceptance.reverse();
  assert.notEqual(frictionProposalDigest(triage), ordered);
  triage.investigation!.proposedWork!.goal = 'Changed goal';
  assert.notEqual(frictionProposalDigest(triage), digest);
});

test('investigation alone is inert; explicit concurrent promotion creates one gated human request', async () => {
  const { runtime, digest } = await fixture();
  await recoverFrictionPromotions(runtime, fail);
  assert.equal((await runtime.requests.list()).length, 0);
  const requests = await Promise.all([promoteFriction(runtime, id, digest, 'Brian'), promoteFriction(runtime, id, digest, 'Brian')]);
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(requests[0].status, 'pending-owner');
  assert.equal(requests[0].from, 'clippy');
  assert.equal(requests[0].to, 'clippy');
  assert.equal(requests[0].ask.kind, 'work');
  if (requests[0].ask.kind === 'work') assert.deepEqual(requests[0].ask.operatorAssignment, { by: 'Brian', source: { kind: 'friction', id } });
  assert.deepEqual(requests[0].approvals, []);
  assert.equal((await runtime.ledger.list()).length, 0);
  assert.equal((await frictionPromotionView(runtime, id))?.requestID, requests[0].id);
});

test('stale evidence, incomplete investigation, invalid actor and changed authority cannot create intent', async () => {
  const { runtime, triage, save, digest } = await fixture();
  await assert.rejects(promoteFriction(runtime, id, digest, ' '));
  triage.investigation!.observed.push('New evidence');
  await save();
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /friction_proposal_stale/);
  triage.state = 'running';
  await save();
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /friction_proposal_unavailable/);
  triage.state = 'investigated';
  triage.investigation!.proposedWork!.repository = 'foreign/repo';
  await save();
  await assert.rejects(promoteFriction(runtime, id, frictionProposalDigest(triage)!, 'Brian'), /wrong_repository/);
  triage.investigation!.proposedWork!.repository = 'example/clippy';
  await save();
  runtime.declarations.owners.get('clippy')!.persona = undefined;
  await assert.rejects(promoteFriction(runtime, id, frictionProposalDigest(triage)!, 'Brian'), /owner_cannot_change/);
  assert.equal(await frictionPromotionView(runtime, id), undefined);
});

test('saved intent with changed investigation blocks rather than reusing consent', async () => {
  const { runtime, triage, save, digest } = await fixture();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  runtime.requests.openIdentified = async () => { throw new Error('Bearer PRIVATE'); };
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /friction_promotion_routing_failed/);
  assert.doesNotMatch(JSON.stringify(await frictionPromotionView(runtime, id)), /PRIVATE/);
  runtime.requests.openIdentified = open;
  triage.investigation!.proposedWork!.goal = 'Changed later';
  await save();
  await recoverFrictionPromotions(runtime, (_id, error) => assert.match(String(error), /friction_source_stale/));
  assert.equal((await runtime.requests.list()).length, 0);
  assert.equal((await frictionPromotionView(runtime, id))?.reason, 'friction_source_stale');
});

test('lost creation reply adopts request after authority retirement and never reopens terminal work', async () => {
  const { runtime, digest } = await fixture();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  runtime.requests.openIdentified = async (...args) => { await open(...args); throw new Error('reply lost'); };
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /routing_failed/);
  const [created] = await runtime.requests.list();
  await runtime.requests.update(created.id, request => ({ ...request, status: 'denied', reason: 'Stop' }));
  runtime.requests.openIdentified = open;
  runtime.declarations.owners.delete('clippy');
  await recoverFrictionPromotions(runtime, fail);
  assert.equal((await promoteFriction(runtime, id, digest, 'Another display name')).status, 'denied');
  assert.equal((await runtime.requests.list()).length, 1);
  assert.equal((await frictionPromotionView(runtime, id))?.by, 'Brian');
  await assert.rejects(promoteFriction(runtime, id, 'b'.repeat(64), 'Brian'), /friction_promotion_conflict/);
});

test('recovery attempts are bounded and authority is rechecked before a new request', async () => {
  const { runtime, digest } = await fixture();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  let attempts = 0;
  runtime.requests.openIdentified = async () => { attempts++; throw new Error('storage unavailable'); };
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'));
  for (let index = 0; index < 4; index++) await recoverFrictionPromotions(runtime, () => {});
  assert.equal(attempts, 3);
  assert.equal((await frictionPromotionView(runtime, id))?.status, 'blocked');
  runtime.requests.openIdentified = open;
  const request = await retryFrictionPromotion(runtime, id, digest, 'Brian');
  assert.equal(request.status, 'pending-owner');
  await runtime.requests.update(request.id, current => ({ ...current, status: 'denied' }));
  assert.equal((await retryFrictionPromotion(runtime, id, digest, 'Brian')).status, 'denied');
  assert.equal((await runtime.requests.list()).length, 1);
});

test('rescoping the captured owner blocks a pending intent as an authority denial, not source unavailability', async () => {
  const state = await fixture();
  const open = state.runtime.requests.openIdentified.bind(state.runtime.requests);
  state.runtime.requests.openIdentified = async () => { throw new Error('routing paused'); };
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /routing_failed/);
  state.runtime.requests.openIdentified = open;
  const owner = state.runtime.declarations.owners.get('clippy')!;
  state.runtime.declarations.owners.set('clippy', {
    ...owner, domain: { ...owner.domain, name: 'example/other' },
  } as typeof owner);
  const errors: string[] = [];
  await recoverFrictionPromotions(state.runtime, (_id, error) => errors.push(String(error)));
  assert.deepEqual(errors, ['Error: not_your_repository']);
  const view = await frictionPromotionView(state.runtime, id);
  assert.equal(view?.status, 'blocked');
  assert.equal(view.reason, 'not_your_repository');
  assert.equal(view.by, 'Brian');
  const intent = join(state.runtime.stateDirectory, 'friction', 'promotions', `${id}.json`);
  assert.equal(JSON.parse(await readFile(intent, 'utf8')).attempts, 2);
  await recoverFrictionPromotions(state.runtime, (_id, error) => errors.push(String(error)));
  assert.deepEqual(errors, ['Error: not_your_repository']);
  assert.equal((await state.runtime.requests.list()).length, 0);
});

test('unavailable source consumes routing budget without opening a request, then explicit retry can route', async () => {
  const state = await fixture();
  const open = state.runtime.requests.openIdentified.bind(state.runtime.requests);
  state.runtime.requests.openIdentified = async () => { throw new Error('routing paused'); };
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /routing_failed/);
  state.runtime.requests.openIdentified = open;
  await writeFile(join(state.workspace, 'check.ts'), 'dirty source\n');
  const errors: string[] = [];
  await recoverFrictionPromotions(state.runtime, (_id, error) => errors.push(String(error)));
  assert.deepEqual(errors, ['Error: friction_source_unavailable']);
  assert.equal((await frictionPromotionView(state.runtime, id))?.status, 'pending');
  assert.equal((await frictionPromotionView(state.runtime, id))?.reason, 'friction_source_unavailable');
  assert.equal((await state.runtime.requests.list()).length, 0);
  const intent = join(state.runtime.stateDirectory, 'friction', 'promotions', `${id}.json`);
  assert.equal(JSON.parse(await readFile(intent, 'utf8')).attempts, 2);
  await recoverFrictionPromotions(state.runtime, (_id, error) => errors.push(String(error)));
  assert.equal((await frictionPromotionView(state.runtime, id))?.status, 'blocked');
  assert.equal(JSON.parse(await readFile(intent, 'utf8')).attempts, 3);
  await recoverFrictionPromotions(state.runtime, fail);
  assert.equal(JSON.parse(await readFile(intent, 'utf8')).attempts, 3);
  assert.equal((await state.runtime.requests.list()).length, 0);
  await writeFile(join(state.workspace, 'check.ts'), 'export const check = true;\n');
  assert.equal((await state.runtime.requests.list()).length, 0);
  const request = await retryFrictionPromotion(state.runtime, id, state.digest, 'Brian');
  assert.equal(request.ask.kind === 'work' && request.ask.operatorAssignment?.by, 'Brian');
  assert.equal((await state.runtime.requests.list()).length, 1);
});

test('unavailable source at promotion creates no intent; clean source at same HEAD recovers pending consent once', async () => {
  const state = await fixture();
  await writeFile(join(state.workspace, 'check.ts'), 'dirty source\n');
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /friction_source_unavailable/);
  assert.equal(await frictionPromotionView(state.runtime, id), undefined);
  await writeFile(join(state.workspace, 'check.ts'), 'export const check = true;\n');
  const open = state.runtime.requests.openIdentified.bind(state.runtime.requests);
  state.runtime.requests.openIdentified = async () => { throw new Error('routing paused'); };
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /routing_failed/);
  state.runtime.requests.openIdentified = open;
  await writeFile(join(state.workspace, 'check.ts'), 'dirty again\n');
  await recoverFrictionPromotions(state.runtime, (_id, error) => assert.match(String(error), /friction_source_unavailable/));
  assert.equal((await frictionPromotionView(state.runtime, id))?.status, 'pending');
  await writeFile(join(state.workspace, 'check.ts'), 'export const check = true;\n');
  await recoverFrictionPromotions(state.runtime, fail);
  await recoverFrictionPromotions(state.runtime, fail);
  assert.equal((await state.runtime.requests.list()).length, 1);
  assert.equal((await frictionPromotionView(state.runtime, id))?.by, 'Brian');
  assert.equal((await frictionPromotionView(state.runtime, id))?.status, 'pending-owner');
});


test('missing previously routed request is a blocker, never recreated as fresh work', async () => {
  const { runtime, digest } = await fixture();
  const request = await promoteFriction(runtime, id, digest, 'Brian');
  await rm(join(runtime.requests.directory, `${request.id}.json`));
  assert.equal((await frictionPromotionView(runtime, id))?.reason, 'friction_promotion_request_missing');
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /friction_promotion_request_missing/);
  await assert.rejects(retryFrictionPromotion(runtime, id, digest, 'Brian'), /friction_promotion_request_missing/);
  assert.equal((await runtime.requests.list()).length, 0);
});

async function pendingAtA(state: Awaited<ReturnType<typeof fixture>>) {
  const open = state.runtime.requests.openIdentified.bind(state.runtime.requests);
  state.runtime.requests.openIdentified = async () => { throw new Error('routing paused'); };
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /routing_failed/);
  state.runtime.requests.openIdentified = open;
  assert.equal((await frictionPromotionView(state.runtime, id))?.status, 'pending');
  const second = state.commit('B');
  await recoverFrictionPromotions(state.runtime, (_id, error) => assert.match(String(error), /friction_source_stale/));
  assert.equal((await frictionPromotionView(state.runtime, id))?.reason, 'friction_source_stale');
  assert.equal((await state.runtime.requests.list()).length, 0);
  await writeFile(join(state.root, 'friction-triage.json'), JSON.stringify(state.triage.policy));
  return second;
}

test('stale pending intent blocks; revised proposal requires new approval and archives old consent', async () => {
  const state = await fixture();
  const second = await pendingAtA(state);
  let hires = 0;
  state.runtime.hire = async (_owner, request) => {
    hires++;
    return { value: request.schema.parse({ observed: ['check.ts:1 still needs work'], inferred: [], unknown: [],
      disposition: 'propose-fix', proposedWork: { ...state.triage.investigation!.proposedWork!, goal: 'Revised goal' } }),
    sessionID: 'revised', cost: 0, startedAt: state.triage.createdAt, finishedAt: state.triage.createdAt };
  };
  const revised = await revalidateFriction(state.runtime, id);
  if (revised.state === 'disabled') throw new Error('expected revalidation');
  assert.equal(revised.state, 'done');
  assert.equal(revised.revision?.state, 'revised');
  assert.equal(hires, 1);
  assert.deepEqual(await frictionFreshness(state.runtime, id), {
    investigatedCommit: second, referenceCommit: second, stale: false, scope: 'local-checkout-not-fetched',
  });
  const revisedDigest = await effectiveProposalDigest(state.runtime, id);
  assert.ok(revisedDigest);
  assert.notEqual(revisedDigest, state.digest);
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Old approval'), /friction_proposal_stale/);
  assert.equal((await frictionPromotionView(state.runtime, id))?.by, 'Brian');
  assert.deepEqual(await frictionPromotionHistory(state.runtime, id), []);
  const [first, duplicate] = await Promise.all([
    promoteFriction(state.runtime, id, revisedDigest, 'Second person'),
    promoteFriction(state.runtime, id, revisedDigest, 'Second person'),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal((await state.runtime.requests.list()).length, 1);
  assert.equal(first.ask.kind === 'work' && first.ask.proposal.goal, 'Revised goal');
  assert.equal((await frictionPromotionView(state.runtime, id))?.by, 'Second person');
  const history = await frictionPromotionHistory(state.runtime, id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.digest, state.digest);
  assert.equal(history[0]?.by, 'Brian');
  assert.equal(JSON.parse(await readFile(join(state.runtime.stateDirectory, 'friction', 'promotions', id,
    'superseded-1.json'), 'utf8')).digest, state.digest);
});

test('approval after archive write but before intent save reuses the archived intent', async () => {
  const state = await fixture();
  const second = await pendingAtA(state);
  await writeRevision(state.runtime, { version: 1, id, revision: 1, previousCommit: state.triage.sourceCommit!,
    sourceCommit: second, reason: 'source_stale', state: 'revised', at: state.triage.createdAt,
    investigation: { ...state.triage.investigation!,
      proposedWork: { ...state.triage.investigation!.proposedWork!, goal: 'Revised goal' } } });
  const revisedDigest = await effectiveProposalDigest(state.runtime, id);
  assert.ok(revisedDigest);
  const promotions = join(state.runtime.stateDirectory, 'friction', 'promotions');
  const oldIntent = await readFile(join(promotions, `${id}.json`), 'utf8');
  await mkdir(join(promotions, id));
  await writeFile(join(promotions, id, 'superseded-1.json'), oldIntent, { flag: 'wx' });

  const request = await promoteFriction(state.runtime, id, revisedDigest, 'Second person');
  const history = await frictionPromotionHistory(state.runtime, id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.digest, state.digest);
  assert.equal(history[0]?.by, 'Brian');
  assert.equal((await frictionPromotionView(state.runtime, id))?.digest, revisedDigest);
  assert.equal((await frictionPromotionView(state.runtime, id))?.by, 'Second person');
  assert.equal((await state.runtime.requests.list()).length, 1);
  assert.equal((await state.runtime.requests.list())[0]?.id, request.id);
});

test('an interrupted archive temp file is ignored and re-approval creates one complete archive', async () => {
  const state = await fixture();
  const second = await pendingAtA(state);
  await writeRevision(state.runtime, { version: 1, id, revision: 1, previousCommit: state.triage.sourceCommit!,
    sourceCommit: second, reason: 'source_stale', state: 'revised', at: state.triage.createdAt,
    investigation: { ...state.triage.investigation!,
      proposedWork: { ...state.triage.investigation!.proposedWork!, goal: 'Revised goal' } } });
  const revisedDigest = await effectiveProposalDigest(state.runtime, id);
  assert.ok(revisedDigest);
  const folder = join(state.runtime.stateDirectory, 'friction', 'promotions', id);
  await mkdir(folder);
  const leftover = join(folder, 'superseded-1.json.interrupted.tmp');
  await writeFile(leftover, '{"version":');
  assert.deepEqual(await frictionPromotionHistory(state.runtime, id), []);

  const request = await promoteFriction(state.runtime, id, revisedDigest, 'Second person');
  const history = await frictionPromotionHistory(state.runtime, id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.digest, state.digest);
  assert.equal(history[0]?.by, 'Brian');
  assert.equal((await frictionPromotionView(state.runtime, id))?.digest, revisedDigest);
  assert.equal((await state.runtime.requests.list()).length, 1);
  assert.equal((await state.runtime.requests.list())[0]?.id, request.id);
  assert.equal(await readFile(leftover, 'utf8'), '{"version":');
});

test('source-only already-fixed revision cannot retire or promote and retains blocked old intent', async () => {
  const state = await fixture();
  const second = await pendingAtA(state);
  state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
    observed: ['check.ts:1 fixed'], inferred: [], unknown: [], disposition: 'already-fixed', fixedBy: second,
  }), sessionID: 'fixed', cost: 0, startedAt: state.triage.createdAt, finishedAt: state.triage.createdAt });
  const revised = await revalidateFriction(state.runtime, id);
  if (revised.state === 'disabled') throw new Error('expected revalidation');
  assert.equal(revised.state, 'done');
  assert.equal(revised.revision?.state, 'blocked');
  assert.equal(revised.revision?.blockedReason, 'friction_operational_condition_unverified');
  assert.equal(await effectiveProposalDigest(state.runtime, id), undefined);
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /friction_source_stale/);
  assert.equal((await frictionPromotionView(state.runtime, id))?.reason, 'friction_source_stale');
  assert.equal((await state.runtime.requests.list()).length, 0);
  assert.deepEqual(await frictionPromotionHistory(state.runtime, id), []);
});

test('routed request remains untouched after HEAD moves, regardless of submitted digest', async () => {
  const state = await fixture();
  const request = await promoteFriction(state.runtime, id, state.digest, 'Brian');
  state.commit('B');
  assert.equal((await promoteFriction(state.runtime, id, state.digest, 'Brian')).id, request.id);
  await assert.rejects(promoteFriction(state.runtime, id, 'b'.repeat(64), 'Other'), /friction_source_stale|friction_promotion_conflict/);
  assert.equal((await state.runtime.requests.get(request.id)).ask.kind, request.ask.kind);
  assert.equal((await state.runtime.requests.get(request.id)).status, request.status);
  assert.equal((await state.runtime.requests.list()).length, 1);
  assert.deepEqual(await frictionPromotionHistory(state.runtime, id), []);
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

function revisedProposal(state: Awaited<ReturnType<typeof fixture>>) {
  return { version: 1 as const, id, revision: 1, previousCommit: state.triage.sourceCommit!,
    sourceCommit: state.triage.sourceCommit!, reason: 'source_stale' as const, state: 'revised' as const,
    at: state.triage.createdAt, investigation: { ...state.triage.investigation!,
      proposedWork: { ...state.triage.investigation!.proposedWork!, goal: 'Freshly revised goal' } } };
}

test('request creation holds the report lock until persisted; concurrent revision publication waits', async () => {
  const state = await fixture();
  const entered = barrier();
  const release = barrier();
  const order: string[] = [];
  const open = state.runtime.requests.openIdentified.bind(state.runtime.requests);
  state.runtime.requests.openIdentified = async (...args) => {
    entered.resolve();
    await release.promise;
    const request = await open(...args);
    order.push('request persisted');
    return request;
  };
  const promotion = promoteFriction(state.runtime, id, state.digest, 'Brian');
  let publication: Promise<void> | undefined;
  try {
    await entered.promise;
    const lock = join(investigationDirectory(state.runtime, id), 'revisions.lock');
    assert.equal(spawnSync('flock', ['--nonblock', lock, 'true']).status, 1,
      'the kernel proves the publication lock is held inside request creation');
    publication = writeRevision(state.runtime, revisedProposal(state)).then(() => { order.push('revision published'); });
    assert.deepEqual(await readRevisions(state.runtime, id), []);
    release.resolve();
    const request = await promotion;
    await publication;
    assert.deepEqual(order, ['request persisted', 'revision published']);
    assert.equal((await promoteFriction(state.runtime, id, state.digest, 'Brian')).id, request.id);
    assert.equal((await state.runtime.requests.list()).length, 1, 'replay adopts the existing request after revision');
  } finally {
    release.resolve();
    await Promise.allSettled([promotion, publication]);
    state.runtime.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('revision publication wins before final routing validation and invalidates the saved approval', async () => {
  const state = await fixture();
  const entered = barrier();
  const release = barrier();
  const open = state.runtime.requests.openIdentified.bind(state.runtime.requests);
  state.runtime.requests.openIdentified = async () => { throw new Error('pause routing'); };
  await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /routing_failed/);
  state.runtime.requests.openIdentified = open;
  const get = state.runtime.requests.get.bind(state.runtime.requests);
  state.runtime.requests.get = async requestID => {
    entered.resolve();
    await release.promise;
    return get(requestID);
  };
  const failures: unknown[] = [];
  const routing = recoverFrictionPromotions(state.runtime, (_id, error) => failures.push(error));
  try {
    await entered.promise;
    await writeRevision(state.runtime, revisedProposal(state));
    release.resolve();
    await routing;
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /friction_source_stale/);
    assert.equal((await state.runtime.requests.list()).length, 0);
    assert.equal((await frictionPromotionView(state.runtime, id))?.status, 'blocked');
    assert.equal((await readRevisions(state.runtime, id)).length, 1);
  } finally {
    release.resolve();
    await routing;
    state.runtime.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('CLI investigation read model supplies effective approval and separately labeled original evidence', async () => {
  const state = await fixture();
  try {
    const second = state.commit('New reference');
    const stale = await frictionInvestigationView(state.runtime, id);
    assert.equal(stale.freshness?.stale, true);
    assert.equal(stale.proposalDigest, undefined);
    await writeRevision(state.runtime, { ...revisedProposal(state), sourceCommit: second });
    const displayed = JSON.parse(JSON.stringify(await frictionInvestigationView(state.runtime, id)));
    assert.equal(displayed.revision, 1);
    assert.equal(displayed.triage.investigation.proposedWork.goal, 'Freshly revised goal');
    assert.equal(displayed.triage.sourceCommit, second);
    assert.equal(displayed.originalTriage.investigation.proposedWork.goal, state.triage.investigation!.proposedWork!.goal);
    assert.equal(displayed.originalTriage.sourceCommit, state.triage.sourceCommit);
    assert.equal(displayed.freshness.stale, false);
    assert.notEqual(displayed.proposalDigest, state.digest);
    const request = await promoteFriction(state.runtime, id, displayed.proposalDigest, 'Brian');
    assert.equal(request.ask.kind, 'work');
    if (request.ask.kind === 'work') assert.equal(request.ask.proposal.goal, 'Freshly revised goal');
  } finally {
    state.runtime.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('CLI investigation read model omits digest for already-fixed while preserving original proposal', async () => {
  const state = await fixture();
  try {
    await writeRevision(state.runtime, { ...revisedProposal(state), investigation: {
      disposition: 'already-fixed', fixedBy: state.triage.sourceCommit!, observed: ['check.ts:1 fixed'], inferred: [], unknown: [],
    } });
    const displayed = JSON.parse(JSON.stringify(await frictionInvestigationView(state.runtime, id)));
    assert.equal(displayed.triage.investigation.disposition, 'already-fixed');
    assert.equal(displayed.freshness.stale, false);
    assert.equal(Object.hasOwn(displayed, 'proposalDigest'), false);
    assert.equal(displayed.originalTriage.investigation.disposition, 'propose-fix');
    await assert.rejects(promoteFriction(state.runtime, id, state.digest, 'Brian'), /friction_proposal_unavailable/);
    assert.equal((await state.runtime.requests.list()).length, 0);
  } finally {
    state.runtime.close();
    await rm(state.root, { recursive: true, force: true });
  }
});
