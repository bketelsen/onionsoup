import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { REQUEST_STATUS_LIMITS, requestProgressDetail, requestProgress, requestProgressSummary, requestProgressText, requestVisibleTo } from '../src/request-status.ts';

const proposal = { title: 'Repair svu', goal: 'Fix the version check', rationale: 'CI evidence', acceptance: ['Check succeeds'], size: 'small' as const };
const origin = { sessionID: 'odrade-origin', directory: '/fixture/chat/odrade' };
async function setup() {
  return Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'request-progress-')) });
}
async function open(runtime: Runtime, withOrigin = true) {
  return runtime.requests.open('odrade', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none', withOrigin ? origin : undefined);
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

test('a denial stays visible in the summary and is never converted to work', async () => {
  const runtime = await setup();
  const request = await open(runtime, false);
  await runtime.requests.update(request.id, current => ({ ...current, status: 'denied', reason: 'Not authorized' }));
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

test('request detail rejects traversal before attempting any filesystem lookup', async () => {
  const runtime = await setup();
  runtime.requests.get = async () => { throw new Error('unexpected_filesystem_lookup'); };
  for (const id of ['../private', 'r-../private', '/tmp/request', 'r-example/file', 'r-example\\file', 'r-.']) {
    assert.equal(await requestProgressDetail(runtime, 'odrade', id), 'request_id_invalid');
  }
});

test('scoped evidence is bounded and redacted; corrupt or mismatched evidence stays unknown', async () => {
  const { recordRequestWorkEvidence, REQUEST_EVIDENCE_LIMITS } = await import('../src/request-work-evidence.ts');
  const runtime = await setup();
  const request = await open(runtime);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { request: request.id, status: 'working' });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id }));
  await recordRequestWorkEvidence(runtime, item, { stage: 'reviewed', review: { reviewer: 'other-family', verdict: {
    decision: 'revise', summary: 'token=private-value ' + 'long '.repeat(1000),
    findings: Array.from({ length: REQUEST_EVIDENCE_LIMITS.findings + 1 }, () => ({ severity: 'blocker', file: 'file',
      issue: 'password=hidden-value', suggestion: 'Require evidence' })),
  } } });
  const text = await requestProgressDetail(runtime, 'odrade', request.id);
  assert.match(text, /abbreviated/);
  assert.match(text, /\[redacted\]/);
  assert.doesNotMatch(text, /private-value|hidden-value/);
  assert.ok(text.length < REQUEST_STATUS_LIMITS.summaryChars);
  await runtime.ledger.update(item.id, current => ({ ...current, planDocument: { markdown: 'First recorded plan', digest: 'new-digest' } }));
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /Host attempt: reviewed; superseded/);
  await runtime.ledger.update(item.id, current => ({ ...current, planDocument: undefined }));
  const directory = join(runtime.stateDirectory, 'request-work-evidence');
  const [name] = await readdir(directory);
  const path = join(directory, name!);
  const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...record, observedAt: '2020-01-01T00:00:00.000Z' }));
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /Host attempt: reviewed; stale/);
  await writeFile(path, JSON.stringify({ ...record, request: 'r-other' }));
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /Host tests\/review: unavailable/);
  await writeFile(path, '{broken');
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /Host tests\/review: unavailable/);
});

test('accepted assignment retains its original goal through feedback, revision, interruption recovery and cancellation', async () => {
  const { requestWork, decideWork, trackDelegatedWork } = await import('../src/delegation.ts');
  const { submitPlan, recordPlanFeedback, planningPrompt } = await import('../src/plan-work.ts');
  const { approvePlan, revisePlan, resumeItem, cancelItem } = await import('../src/work-recovery.ts');
  const runtime = await setup();
  for (const owner of ['odrade', 'clippy']) await runtime.notebook(owner).ensure('# Fixture');
  const request = await requestWork(runtime, 'odrade', 'clippy', proposal, undefined, origin);
  const accepted = await decideWork(runtime, request);
  const item = await runtime.ledger.get(accepted.workItem!);
  assert.match(planningPrompt(item), /accepted work handoff, distinct from an earlier consultation or status query/);
  assert.match(planningPrompt(item), /no permission to bypass plan approval or effect gates/);
  assert.ok(planningPrompt(item).includes(proposal.goal));
  await submitPlan(runtime, 'clippy', { item: item.id, title: proposal.title, goal: proposal.goal, plan: 'First approach' }, origin);
  await recordPlanFeedback(runtime, item.id, 'Brian', 'Reject this method; keep the goal');
  await revisePlan(runtime, item.id, 'Brian', 'Use a smaller approach');
  await submitPlan(runtime, 'clippy', { item: item.id, title: proposal.title, goal: proposal.goal, plan: 'Smaller approach' }, origin);
  await approvePlan(runtime, item.id, 'Brian');
  await runtime.ledger.update(item.id, current => ({ ...current, status: 'interrupted', reason: 'Fixture interrupted' }));
  await resumeItem(runtime, item.id, 'Brian', 'Continue approved work');
  const resumed = await runtime.ledger.get(item.id);
  assert.equal(resumed.status, 'working');
  assert.deepEqual(resumed.proposal, proposal);
  assert.ok(resumed.humanNotes.some(note => note.note.includes('keep the goal')));
  await cancelItem(runtime, item.id, 'Brian', 'Stop this attempt');
  await trackDelegatedWork(runtime, await runtime.requests.get(request.id));
  const cancelled = await runtime.ledger.get(item.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.proposal, proposal);
  const status = await requestProgressDetail(runtime, 'odrade', request.id);
  assert.ok(status.includes(`Goal: ${proposal.goal}`));
  assert.match(status, /Stop this attempt/);
  assert.equal((await runtime.requests.list()).length, 1);
});

