import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { listAttention, changeAttention, humanAttentionActor } from '../src/attention.ts';
import { assignAttention, attentionAssignmentView, recoverAttentionAssignments, retryAttentionAssignment } from '../src/attention-assignment.ts';

const input = { owner: 'clippy', repository: 'example/clippy', title: 'Repair check', goal: 'Make check work', acceptance: ['Regression check passes'] };
async function setup() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'attention-assignment-')) });
  await runtime.notebook('homelab').ensure('# Test');
  await runtime.notebook('homelab').journal({ kind: 'attention', note: 'Version check is broken' });
  const [attention] = await listAttention(runtime);
  return { runtime, attention };
}
function fail(_id: string, error: unknown): never { throw error; }

test('Seen remains inert and explicit double assignment creates one gated request with human evidence', async () => {
  const { runtime, attention } = await setup();
  await changeAttention(runtime, attention.id, 'acknowledged', humanAttentionActor(), 'fix this');
  await recoverAttentionAssignments(runtime, fail);
  assert.equal((await runtime.requests.list()).length, 0);
  const requests = await Promise.all([assignAttention(runtime, attention.id, input, 'Brian'), assignAttention(runtime, attention.id, input, 'Brian')]);
  assert.equal(requests[0].id, requests[1].id);
  const request = requests[0];
  assert.equal(request.from, 'clippy');
  assert.equal(request.to, 'clippy');
  assert.equal(request.status, 'pending-owner');
  assert.equal(request.ask.kind, 'work');
  if (request.ask.kind === 'work') assert.deepEqual(request.ask.operatorAssignment, { by: 'Brian', source: { kind: 'attention', id: attention.id } });
  assert.deepEqual(request.approvals, []);
  assert.equal((await runtime.ledger.list()).length, 0);
  assert.equal((await listAttention(runtime))[0].status, 'acknowledged');
  assert.equal((await attentionAssignmentView(runtime, attention.id))?.status, 'pending-owner');
});

test('source, actor, criteria and declared repository are validated before durable assignment', async () => {
  const { runtime, attention } = await setup();
  await assert.rejects(assignAttention(runtime, 'missing', input, 'Brian'), /attention_not_found/);
  await assert.rejects(assignAttention(runtime, attention.id, { ...input, acceptance: [] }, 'Brian'));
  await assert.rejects(assignAttention(runtime, attention.id, input, ' '));
  await assert.rejects(assignAttention(runtime, attention.id, { ...input, repository: 'foreign/repo' }, 'Brian'), /not_your_repository/);
  await assert.rejects(assignAttention(runtime, attention.id, { ...input, owner: 'moneo' }, 'Brian'), /owner_cannot_change/);
  assert.equal(await attentionAssignmentView(runtime, attention.id), undefined);
  await changeAttention(runtime, attention.id, 'resolved', humanAttentionActor(), 'Not needed');
  await assert.rejects(assignAttention(runtime, attention.id, input, 'Brian'), /attention_already_resolved/);
  assert.equal((await runtime.requests.list()).length, 0);
});

test('crash before request creation recovers intent with current scope checks', async () => {
  const { runtime, attention } = await setup();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  runtime.requests.openIdentified = async () => { throw new Error('storage_unavailable'); };
  await assert.rejects(assignAttention(runtime, attention.id, input, 'Brian'), /storage_unavailable/);
  runtime.requests.openIdentified = open;
  runtime.declarations.owners.get('clippy')!.persona = undefined;
  const errors: unknown[] = [];
  await recoverAttentionAssignments(runtime, (_id, error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.equal((await attentionAssignmentView(runtime, attention.id))?.status, 'blocked');
  assert.equal((await runtime.requests.list()).length, 0);
});

test('crash after request creation adopts exact existing identity even if owner is retired', async () => {
  const { runtime, attention } = await setup();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  runtime.requests.openIdentified = async (...args) => { await open(...args); throw new Error('reply_lost'); };
  await assert.rejects(assignAttention(runtime, attention.id, input, 'Brian'), /reply_lost/);
  runtime.requests.openIdentified = open;
  runtime.declarations.owners.delete('clippy');
  await recoverAttentionAssignments(runtime, fail);
  assert.equal((await runtime.requests.list()).length, 1);
  assert.equal((await attentionAssignmentView(runtime, attention.id))?.status, 'pending-owner');
});

test('changed assignment conflicts, and repeated submission never restarts a denied request', async () => {
  const { runtime, attention } = await setup();
  const request = await assignAttention(runtime, attention.id, input, 'Brian');
  await runtime.requests.update(request.id, current => ({ ...current, status: 'denied', reason: 'Stop' }));
  assert.equal((await assignAttention(runtime, attention.id, input, 'Brian')).status, 'denied');
  await assert.rejects(assignAttention(runtime, attention.id, { ...input, goal: 'Different goal' }, 'Brian'), /attention_assignment_conflict/);
  assert.equal((await runtime.requests.list()).length, 1);
});

test('transient routing stops after its budget and explicit retry recovers the same assignment', async () => {
  const { runtime, attention } = await setup();
  const open = runtime.requests.openIdentified.bind(runtime.requests);
  let attempts = 0;
  runtime.requests.openIdentified = async () => { attempts++; throw new Error('storage_unavailable'); };
  await assert.rejects(assignAttention(runtime, attention.id, input, 'Brian'));
  const errors: unknown[] = [];
  for (let tick = 0; tick < 5; tick++) await recoverAttentionAssignments(runtime, (_id, error) => errors.push(error));
  assert.equal(attempts, 3);
  assert.equal((await attentionAssignmentView(runtime, attention.id))?.status, 'blocked');
  runtime.requests.openIdentified = open;
  const request = await retryAttentionAssignment(runtime, attention.id, 'Brian');
  assert.equal(request.status, 'pending-owner');
  assert.equal((await runtime.requests.list()).length, 1);
  await runtime.requests.update(request.id, current => ({ ...current, status: 'denied', reason: 'No' }));
  assert.equal((await retryAttentionAssignment(runtime, attention.id, 'Brian')).status, 'denied');
});
