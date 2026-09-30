import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { readFrictionTriage, type FrictionTriage } from '../src/friction-work.ts';
import { frictionPromotionView, frictionProposalDigest, promoteFriction, recoverFrictionPromotions, retryFrictionPromotion } from '../src/friction-promotion.ts';

const id = 'fr_012345678901234567890123';
async function fixture() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'friction-promotion-')) });
  const triage: FrictionTriage = { version: 1, id, state: 'investigated', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    policy: { version: 1, owner: 'clippy', repository: 'example/clippy', enabledSince: '2026-01-01T00:00:00.000Z', intervalMs: 3600000 },
    sourceCommit: 'a'.repeat(40), investigation: { observed: ['src/check.ts'], inferred: [], unknown: [], disposition: 'propose-fix',
      proposedWork: { title: 'Fix check', goal: 'Useful check', rationale: 'Evidence missing', size: 'small', repository: 'example/clippy', acceptance: ['Regression passes'] } } };
  const directory = join(runtime.stateDirectory, 'friction/investigations');
  await mkdir(directory, { recursive: true });
  const save = () => writeFile(join(directory, `${id}.json`), JSON.stringify(triage));
  await save();
  return { runtime, triage, save, digest: frictionProposalDigest(triage)! };
}
function fail(_id: string, error: unknown): never { throw error; }

test('proposal digest survives schema parsing and property order changes', async () => {
  const { runtime, triage, digest } = await fixture();
  assert.equal(frictionProposalDigest((await readFrictionTriage(runtime, id))!), digest);
  triage.investigation!.proposedWork = Object.fromEntries(Object.entries(triage.investigation!.proposedWork!).reverse()) as NonNullable<FrictionTriage['investigation']>['proposedWork'];
  assert.equal(frictionProposalDigest(triage), digest);
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

test('saved human intent recovers without rereading a changed investigation or requiring a second decision', async () => {
  const { runtime, triage, save, digest } = await fixture();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  runtime.requests.openIdentified = async () => { throw new Error('Bearer PRIVATE'); };
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /friction_promotion_routing_failed/);
  assert.doesNotMatch(JSON.stringify(await frictionPromotionView(runtime, id)), /PRIVATE/);
  runtime.requests.openIdentified = open;
  triage.investigation!.proposedWork!.goal = 'Changed later';
  await save();
  await recoverFrictionPromotions(runtime, fail);
  const [request] = await runtime.requests.list();
  assert.equal(request.ask.kind === 'work' && request.ask.proposal.goal, 'Useful check');
  assert.equal((await frictionPromotionView(runtime, id))?.status, 'pending-owner');
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


test('missing previously routed request is a blocker, never recreated as fresh work', async () => {
  const { runtime, digest } = await fixture();
  const request = await promoteFriction(runtime, id, digest, 'Brian');
  await rm(join(runtime.requests.directory, `${request.id}.json`));
  assert.equal((await frictionPromotionView(runtime, id))?.reason, 'friction_promotion_request_missing');
  await assert.rejects(promoteFriction(runtime, id, digest, 'Brian'), /friction_promotion_request_missing/);
  await assert.rejects(retryFrictionPromotion(runtime, id, digest, 'Brian'), /friction_promotion_request_missing/);
  assert.equal((await runtime.requests.list()).length, 0);
});
