import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { revisePlan, cancelItem } from '../src/work-recovery.ts';
import { PLAN_REVISION_LIMITS, deliverPlanRevisions, planRevisionStatus, type PlanRevisionClient } from '../src/plan-revision.ts';
import { submitPlan } from '../src/plan-work.ts';

const origin = { sessionID: 'fixture-planning', directory: '/fixture/chat' };
const proposal = { title: 'Correct the check', goal: 'Check the correct version', rationale: 'Regression', acceptance: ['Version checked correctly'], size: 'small' as const };
async function setup(withOrigin = true) {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'plan-revision-')) });
  await runtime.notebook('clippy').ensure('# Test');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'awaiting-plan-approval',
    origin: withOrigin ? origin : undefined, planDocument: { markdown: 'Original approach', digest: 'original-plan' } });
  return { runtime, item };
}
function transport() {
  const messages: string[] = [];
  const calls: { id: string; text: string }[] = [];
  const state = { accept: true, fail: false, sessionExists: true };
  const client: PlanRevisionClient = {
    exists: async target => { assert.deepEqual(target, origin); return state.sessionExists; },
    messages: async () => messages,
    idle: async () => true,
    prompt: async (_target, _agent, text, id) => {
      calls.push({ id, text });
      if (state.accept) messages.push(id);
      if (state.fail) throw new Error('transport_lost');
    },
  };
  return { client, calls, messages, state };
}
function fail(_id: string, error: unknown): never { throw error; }

test('revision retains the goal, persists feedback once and delivers one stable prompt', async () => {
  const { runtime, item } = await setup();
  const first = await revisePlan(runtime, item.id, 'Brian', 'Use a smaller approach');
  const replay = await revisePlan(runtime, item.id, 'Brian', 'Use a smaller approach');
  assert.equal(first.status, 'planning');
  assert.deepEqual(replay.proposal, proposal);
  assert.equal(replay.humanNotes.length, 1);
  const fake = transport();
  await deliverPlanRevisions(runtime, fake.client, fail);
  await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /Keep the goal/);
  assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'delivered');
});

test('prepared intent recovers crashes before or after the ledger transition without duplicate feedback', async () => {
  for (const afterUpdate of [false, true]) {
    const { runtime, item } = await setup();
    const update = runtime.ledger.updateIfChanged.bind(runtime.ledger);
    runtime.ledger.updateIfChanged = async (...args) => {
      if (afterUpdate) await update(...args);
      throw new Error('crash_at_transition');
    };
    await assert.rejects(revisePlan(runtime, item.id, 'Brian', 'Simplify'), /crash_at_transition/);
    runtime.ledger.updateIfChanged = update;
    const fake = transport();
    await deliverPlanRevisions(runtime, fake.client, fail);
    assert.equal((await runtime.ledger.get(item.id)).humanNotes.length, 1);
    assert.equal(fake.calls.length, 1);
  }
});

test('accepted prompt with lost response reconciles after restart without a duplicate model wake', async () => {
  const { runtime, item } = await setup();
  await revisePlan(runtime, item.id, 'Brian', 'Simplify');
  const fake = transport();
  fake.state.fail = true;
  await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal((await planRevisionStatus(runtime, item.id))?.reason, 'plan_revision_delivery_uncertain');
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  await deliverPlanRevisions(reopened, fake.client, fail);
  assert.equal(fake.calls.length, 1);
  assert.equal((await planRevisionStatus(reopened, item.id))?.status, 'delivered');
});

test('uncertain unobserved submission stops safely and never blindly retries', async () => {
  const { runtime, item } = await setup();
  await revisePlan(runtime, item.id, 'Brian', 'Simplify');
  const fake = transport();
  fake.state.accept = false;
  fake.state.fail = true;
  for (let iteration = 0; iteration < 3; iteration++) await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 1);
  assert.equal((await planRevisionStatus(runtime, item.id))?.reason, 'plan_revision_delivery_uncertain');
  await cancelItem(runtime, item.id, 'Brian', 'Stop');
  await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'suppressed');
});

test('cancellation and a newly submitted plan suppress old feedback delivery', async () => {
  for (const cancel of [true, false]) {
    const { runtime, item } = await setup();
    await revisePlan(runtime, item.id, 'Brian', 'Simplify');
    if (cancel) await cancelItem(runtime, item.id, 'Brian', 'Stop');
    else await submitPlan(runtime, 'clippy', { item: item.id, title: proposal.title, goal: proposal.goal, plan: 'New smaller method' }, origin);
    const fake = transport();
    await deliverPlanRevisions(runtime, fake.client, fail);
    assert.equal(fake.calls.length, 0);
    assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'suppressed');
  }
});

test('missing origin and retired owner expose specific delivery blockers', async () => {
  const missing = await setup(false);
  await revisePlan(missing.runtime, missing.item.id, 'Brian', 'Simplify');
  const fake = transport();
  await deliverPlanRevisions(missing.runtime, fake.client, fail);
  assert.equal((await planRevisionStatus(missing.runtime, missing.item.id))?.reason, 'plan_revision_origin_missing');
  const retired = await setup();
  await revisePlan(retired.runtime, retired.item.id, 'Brian', 'Simplify');
  retired.runtime.declarations.owners.delete('clippy');
  await deliverPlanRevisions(retired.runtime, fake.client, fail);
  assert.equal((await planRevisionStatus(retired.runtime, retired.item.id))?.reason, 'plan_revision_owner_retired');
  assert.equal(fake.calls.length, 0);
});

test('restoring pre-send prerequisites safely resumes owner, persona, origin and session blockers', async () => {
  for (const prerequisite of ['owner', 'persona', 'origin', 'session']) {
    const { runtime, item } = await setup(prerequisite !== 'origin');
    const owner = runtime.declarations.owners.get('clippy')!;
    const persona = owner.persona;
    await revisePlan(runtime, item.id, 'Brian', 'Simplify');
    const fake = transport();
    if (prerequisite === 'owner') runtime.declarations.owners.delete('clippy');
    if (prerequisite === 'persona') owner.persona = undefined;
    if (prerequisite === 'session') fake.state.sessionExists = false;
    await deliverPlanRevisions(runtime, fake.client, fail);
    assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'blocked');
    assert.equal(fake.calls.length, 0);
    runtime.declarations.owners.set('clippy', owner);
    owner.persona = persona;
    fake.state.sessionExists = true;
    if (prerequisite === 'origin') await runtime.ledger.update(item.id, current => ({ ...current, origin }));
    await deliverPlanRevisions(runtime, fake.client, fail);
    await deliverPlanRevisions(runtime, fake.client, fail);
    assert.equal(fake.calls.length, 1);
    assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'delivered');
  }
});

test('losing and restoring prerequisites after uncertain submission never permits a second send', async () => {
  const { runtime, item } = await setup();
  const owner = runtime.declarations.owners.get('clippy')!;
  await revisePlan(runtime, item.id, 'Brian', 'Simplify');
  const fake = transport();
  fake.state.accept = false;
  fake.state.fail = true;
  await deliverPlanRevisions(runtime, fake.client, fail);
  runtime.declarations.owners.delete('clippy');
  await deliverPlanRevisions(runtime, fake.client, fail);
  runtime.declarations.owners.set('clippy', owner);
  fake.state.sessionExists = false;
  await deliverPlanRevisions(runtime, fake.client, fail);
  fake.state.sessionExists = true;
  fake.state.fail = false;
  fake.state.accept = true;
  await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal(fake.calls.length, 1);
  assert.equal((await planRevisionStatus(runtime, item.id))?.reason, 'plan_revision_delivery_uncertain');
});

test('per-pass bound includes blocked-record inspections', async () => {
  const { runtime, item } = await setup(false);
  const ids = [item.id];
  for (let index = 0; index < PLAN_REVISION_LIMITS.perPass; index++) {
    const another = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'awaiting-plan-approval', planDocument: { markdown: 'Original', digest: 'original' },
    });
    ids.push(another.id);
  }
  for (const id of ids) await revisePlan(runtime, id, 'Brian', 'Simplify');
  const fake = transport();
  await deliverPlanRevisions(runtime, fake.client, fail);
  const statuses = await Promise.all(ids.map(id => planRevisionStatus(runtime, id)));
  assert.equal(statuses.filter(status => status?.status === 'blocked').length, PLAN_REVISION_LIMITS.perPass);
  assert.equal(statuses.filter(status => status?.status === 'pending').length, 1);
  const inspected = new Set<string>();
  const get = runtime.ledger.get.bind(runtime.ledger);
  runtime.ledger.get = async id => { inspected.add(id); return get(id); };
  await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal(inspected.size, PLAN_REVISION_LIMITS.perPass, 'the limit counts records, including journal repair of the same record');
  const after = await Promise.all(ids.map(id => planRevisionStatus(runtime, id)));
  assert.equal(after.filter(status => status?.status === 'pending').length, 0, 'blocked records cannot starve a later pending revision');
});


test('message identity is minted at dispatch after observed native message IDs and retained on restart', async () => {
  const { runtime, item } = await setup();
  await revisePlan(runtime, item.id, 'Brian', 'Simplify');
  assert.equal((await planRevisionStatus(runtime, item.id))?.messageID, undefined);
  const fake = transport();
  const laterTime = ((BigInt(Date.now() + 60_000) * 0x1000n) & 0xffffffffffffn).toString(16).padStart(12, '0');
  const existing = `msg_${laterTime}zzzzzzzzzzzzzz`;
  fake.messages.push(existing);
  await deliverPlanRevisions(runtime, fake.client, fail);
  const sent = fake.calls[0].id;
  assert.match(sent, /^msg_[a-f0-9]{12}[a-zA-Z0-9]{14}$/);
  assert.ok(sent > existing);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  await deliverPlanRevisions(reopened, fake.client, fail);
  assert.equal((await planRevisionStatus(reopened, item.id))?.messageID, sent);
  assert.equal(fake.calls.length, 1);
});

test('feedback journal repairs append-before-marker failure without stranding delivery or duplicating feedback', async () => {
  const { runtime, item } = await setup();
  await revisePlan(runtime, item.id, 'Brian', 'Simplify');
  const notebook = runtime.notebook('clippy');
  const original = notebook.journalOnce.bind(notebook);
  notebook.journalOnce = async (...args) => { await original(...args); throw new Error('journal_marker_crash'); };
  const notebookFor = runtime.notebook.bind(runtime);
  runtime.notebook = owner => owner === 'clippy' ? notebook : notebookFor(owner);
  const fake = transport();
  const failures: unknown[] = [];
  await deliverPlanRevisions(runtime, fake.client, (_id, error) => failures.push(error));
  assert.equal(failures.length, 1);
  assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'delivered');
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  await deliverPlanRevisions(reopened, fake.client, fail);
  await deliverPlanRevisions(reopened, fake.client, fail);
  const journal = join(notebook.directory, 'journal');
  const contents = await Promise.all((await readdir(journal)).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(journal, name), 'utf8')));
  const feedback = contents.join('\n').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.kind === 'plan-feedback');
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].note, 'Brian: Simplify');
  assert.equal(fake.calls.length, 1);
});

test('a late prompt completion cannot overwrite cancellation suppression', async () => {
  const { runtime, item } = await setup();
  await revisePlan(runtime, item.id, 'Brian', 'Simplify');
  const fake = transport();
  const send = fake.client.prompt;
  fake.client.prompt = async (...args) => {
    await cancelItem(runtime, item.id, 'Brian', 'Stop');
    await deliverPlanRevisions(runtime, fake.client, fail);
    await send(...args);
  };
  await deliverPlanRevisions(runtime, fake.client, fail);
  assert.equal((await planRevisionStatus(runtime, item.id))?.status, 'suppressed');
  assert.equal(fake.calls.length, 1);
});

test('an unreadable revision directory reports its failure without rejecting the other notice pass', async () => {
  const { runtime } = await setup();
  await writeFile(join(runtime.stateDirectory, 'plan-revisions'), 'not a directory');
  const failures: string[] = [];
  await deliverPlanRevisions(runtime, transport().client, id => { failures.push(id); });
  assert.deepEqual(failures, ['plan-revisions']);
});
