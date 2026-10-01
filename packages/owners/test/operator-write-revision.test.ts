import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OperatorHandoffs } from '../src/operator-handoff-host.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { OPERATOR_CHECK_TOOL } from '../src/operator-write-call.ts';
import { fixture, start } from './operator-write-host-fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>> & { id: string; sequence: number };
const correction = 'Add the missing requested tests for regular and VIP discounts in the already approved discounts.test.mjs path; preserve scope and check command.';
const discountTest = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {discount} from './discounts.mjs'; test('discounts',()=>{assert.equal(discount(100,false),90);assert.equal(discount(100,true),80)});\n";
const shippingTest = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {shipping} from './shipping.mjs'; test('shipping',()=>assert.equal(shipping(),5));\n";

async function child(context: Fixture, id: string) {
  return (await context.jobs.get(context.origin, context.id)).children.find(candidate => candidate.id === id)!;
}

async function native(context: Fixture, id: string, kind: 'write' | 'check') {
  const current = await child(context, id);
  const messageID = `msg_revision_${context.sequence++}`;
  const callID = `call_revision_${context.sequence}`;
  context.client.tool(current.sessionID!, messageID, callID, kind === 'check' ? OPERATOR_CHECK_TOOL : undefined);
  return { current, callID, toolContext: { ...context.childContext(current.sessionID!, messageID), directory: current.directory } };
}

async function edit(context: Fixture, id: string, path: string, content: string) {
  const call = await native(context, id, 'write');
  const previous = call.current.write!.operations.filter(operation => operation.receipt?.path === path).at(-1)?.receipt;
  const baseline = call.current.write!.baseline.files.find(file => file.path === path);
  return context.writes.file(call.toolContext, call.callID, { path, content,
    expectedBeforeSha256: previous?.afterSha256 ?? baseline?.sha256 ?? 'absent' });
}

async function check(context: Fixture, id: string) {
  const call = await native(context, id, 'check');
  return context.writes.check(call.toolContext, call.callID, { checkID: 'unit' });
}

async function finish(context: Fixture, id: string) {
  const current = await child(context, id);
  context.client.finish(current.sessionID!);
  const final = context.client.sessions.get(current.sessionID!)!.snapshot.messages.at(-1)!;
  final.id = `msg_revision_final_${context.sequence++}`;
  final.text = `Finished ${id}; inspect the host artifact and configured check evidence.`;
  await context.supervisor.tick();
  return context.writes.review(context.origin, context.id, id);
}

async function siblings() {
  const context = await fixture();
  await writeFile(join(context.directory, 'discounts.mjs'), 'export const discount=price=>price;\n');
  await writeFile(join(context.directory, 'shipping.mjs'), 'export const shipping=()=>0;\n');
  await writeFile(join(context.directory, 'all.test.mjs'),
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readdirSync} from 'node:fs'; import {discount} from './discounts.mjs'; import {shipping} from './shipping.mjs'; test('baseline exports',()=>{assert.equal(typeof discount,'function');assert.equal(typeof shipping,'function')}); for (const path of readdirSync('.').filter(path=>path.endsWith('.test.mjs')&&path!=='all.test.mjs')) await import('./'+path);\n");
  await context.git(['add', '.']);
  await context.git(['commit', '-qm', 'discounts and shipping baseline']);
  const head = (await context.git(['rev-parse', 'HEAD'])).stdout.trim();
  const shipping = join(context.workspace, 'shipping');
  await context.git(['worktree', 'add', '-q', '--detach', shipping, head]);
  context.intake.text = 'Implement regular and VIP discounts, plus independent flat-rate shipping. Add tests for both; do not commit or publish.';
  context.input.goal = 'Implement both requested discount cases and independent shipping';
  context.input.tasks = [
    { id: 'discounts', goal: 'Regular discount 10%; VIP discount 20%', directory: context.directory,
      access: 'write', files: ['discounts.mjs'], createFiles: ['discounts.test.mjs'],
      checks: [{ id: 'unit', command: ['node', '--test', 'all.test.mjs'] }], dependsOn: [] },
    { id: 'shipping', goal: 'Flat-rate shipping costs 5', directory: shipping,
      access: 'write', files: ['shipping.mjs'], createFiles: ['shipping.test.mjs'],
      checks: [{ id: 'unit', command: ['node', '--test', 'all.test.mjs'] }], dependsOn: [] },
  ];
  const started = await start(context);
  const ready = { ...context, id: started.id, sequence: 0, shipping };
  await edit(ready, 'discounts', 'discounts.mjs', 'export const discount=(price,vip)=>price*(vip?0.8:0.9);\n');
  const initialCheck = await check(ready, 'discounts');
  assert.equal(initialCheck.exitCode, 0);
  await assert.rejects(readFile(join(ready.directory, 'discounts.test.mjs')), { code: 'ENOENT' });
  const review = await finish(ready, 'discounts');
  await edit(ready, 'shipping', 'shipping.mjs', 'export const shipping=()=>5;\n');
  await edit(ready, 'shipping', 'shipping.test.mjs', shippingTest);
  assert.equal((await check(ready, 'shipping')).exitCode, 0);
  const shippingReview = await finish(ready, 'shipping');
  await ready.writes.accept(ready.origin, ready.id, 'shipping', shippingReview.digest, ready.parent());
  return { ...ready, review, initialCheck };
}

async function emptyReview(options: { dependent?: boolean; check?: boolean } = {}) {
  const context = await fixture();
  if (options.dependent) {
    const directory = join(context.workspace, 'dependent');
    await mkdir(directory);
    context.input.tasks.push({ id: 'dependent', goal: 'Inspect the accepted result', directory,
      access: 'read-only', dependsOn: ['edit'] });
  }
  if (options.check) {
    context.input.tasks[0]!.createFiles = ['scope.test.mjs'];
    context.input.tasks[0]!.checks = [{ id: 'unit', command: ['node', '--test', 'scope.test.mjs'] }];
  }
  const started = await start(context);
  const ready = { ...context, id: started.id, sequence: 0 };
  const review = await finish(ready, 'edit');
  return { ...ready, review };
}

test('same-child revision adds the omitted approved discount test while preserving the accepted shipping sibling and original authority', async () => {
  const context = await siblings();
  const original = await context.jobs.get(context.origin, context.id);
  const originalChild = await child(context, 'discounts');
  const acceptedShipping = await child(context, 'shipping');
  const prompts = context.client.prompts;
  const asks = context.asks.length;
  await context.writes.revise(context.origin, context.id, 'discounts', context.review.digest, correction, context.parent());
  const queued = await child(context, 'discounts');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.sessionID, originalChild.sessionID);
  assert.deepEqual(queued.write!.approval, originalChild.write!.approval);
  assert.deepEqual(queued.write!.baseline, originalChild.write!.baseline);
  assert.deepEqual(queued.write!.operations, originalChild.write!.operations);
  assert.deepEqual(queued.write!.checks, originalChild.write!.checks);
  assert.equal(queued.evidence, undefined);
  assert.equal(queued.write!.artifact, undefined);
  const archived = queued.write!.revisions![0]!;
  assert.equal(archived.digest, context.review.digest);
  assert.equal(archived.text, correction);
  assert.equal(archived.attemptID, originalChild.attempts.at(-1)!.id);
  assert.deepEqual(archived.evidence, originalChild.evidence);
  assert.deepEqual(archived.artifact, originalChild.write!.artifact);
  assert.deepEqual(archived.checkIDs, originalChild.write!.checks!.map(record => record.id));
  await context.writes.revise(context.origin, context.id, 'discounts', context.review.digest, correction, context.parent());
  await assert.rejects(context.writes.revise(context.origin, context.id, 'discounts', context.review.digest, 'Different correction', context.parent()));
  await context.supervisor.tick();
  await context.supervisor.tick();
  assert.equal(context.client.prompts, prompts + 1);
  assert.equal(context.client.sessions.size, 2);
  assert.equal(context.asks.length, asks);
  const resumed = await child(context, 'discounts');
  assert.equal(resumed.attempts.length, originalChild.attempts.length + 1);
  assert.deepEqual(resumed.attempts.slice(0, -1), originalChild.attempts);
  assert.match(context.client.sessions.get(resumed.sessionID!)!.snapshot.messages.filter(message => message.role === 'user').at(-1)!.text, /VIP/);
  const prompt = context.client.sessions.get(resumed.sessionID!)!.snapshot.messages.filter(message => message.role === 'user').at(-1)!.text;
  assert.match(prompt, /discounts\.test\.mjs/);
  assert.doesNotMatch(prompt, /No[^\n.]*new files/i);
  await edit(context, 'discounts', 'discounts.test.mjs', discountTest);
  const successful = await check(context, 'discounts');
  assert.equal(successful.exitCode, 0);
  assert.notEqual(successful.id, context.initialCheck.id);
  const revisedReview = await finish(context, 'discounts');
  const accepted = await context.writes.accept(context.origin, context.id, 'discounts', revisedReview.digest, context.parent());
  assert.equal(accepted.children.find(candidate => candidate.id === 'discounts')!.status, 'completed');
  assert.deepEqual(await child(context, 'shipping'), acceptedShipping);
  assert.deepEqual(accepted.intake, original.intake);
  assert.equal(accepted.goal, original.goal);
  assert.deepEqual(accepted.constraints, original.constraints);
  assert.deepEqual((await child(context, 'discounts')).write!.revisions![0], archived);
  assert.equal(await readFile(join(context.shipping, 'shipping.mjs'), 'utf8'), 'export const shipping=()=>5;\n');
  assert.equal(context.asks.length, asks + 1, 'revision reuses scope; only final diff acceptance asks again');
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes);
  const handoff = await handoffs.prepare(context.origin, context.id, context.parent());
  for (const scope of handoff.artifact.checks) {
    await handoffs.check(context.origin, context.id, handoff.artifact.digest, scope.id, context.parent());
    const deadline = Date.now() + 15_000;
    while ((await handoffs.show(context.origin, context.id)).status === 'checking' && Date.now() < deadline) await delay(20);
  }
  assert.equal((await handoffs.show(context.origin, context.id)).status, 'ready');
});

test('concurrent duplicate revision records one transition and dispatches one same-session turn', async () => {
  const context = await emptyReview();
  const sessionID = context.review.child.sessionID;
  await Promise.all([0, 1].map(() => context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent())));
  await context.supervisor.tick();
  const revised = await child(context, 'edit');
  assert.equal(revised.write!.revisions!.length, 1);
  assert.equal(revised.attempts.length, 2);
  assert.equal(revised.sessionID, sessionID);
  assert.equal(context.client.prompts, 2);
  assert.equal(context.client.sessions.size, 1);
  assert.equal(context.asks.length, 1);
});

test('stale digest, foreign origin and live or foreign child turns cannot revise a completed result', async () => {
  const context = await emptyReview();
  const original = await context.jobs.get(context.origin, context.id);
  await assert.rejects(context.writes.revise(context.origin, context.id, 'edit', '0'.repeat(64), correction, context.parent()));
  await assert.rejects(context.writes.revise({ ...context.origin, sessionID: 'ses_foreign' }, context.id, 'edit', context.review.digest, correction, context.parent()));
  const snapshot = context.client.sessions.get(context.review.child.sessionID!)!.snapshot;
  snapshot.status = 'busy';
  await assert.rejects(context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent()));
  snapshot.status = 'idle';
  snapshot.messages.push({ id: 'msg_foreign', role: 'user', text: 'Independent user work', tools: [] });
  await assert.rejects(context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent()));
  assert.deepEqual(await context.jobs.get(context.origin, context.id), original);
  assert.equal(context.client.prompts, 1);
  assert.equal(context.asks.length, 1);
});

test('accepted children cannot be revised after their workspace reservation was released', async () => {
  const context = await emptyReview();
  await context.writes.accept(context.origin, context.id, 'edit', context.review.digest, context.parent());
  const accepted = await context.jobs.get(context.origin, context.id);
  await assert.rejects(context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent()));
  assert.deepEqual(await context.jobs.get(context.origin, context.id), accepted);
  assert.equal(context.client.prompts, 1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('revision invalidates old successful checks even for an identical artifact and restart reuses only fresh receipts', async () => {
  const setup = await fixture();
  setup.input.tasks[0]!.createFiles = ['scope.test.mjs'];
  setup.input.tasks[0]!.checks = [{ id: 'unit', command: ['node', '--test', 'scope.test.mjs'] }];
  const started = await start(setup);
  const context = { ...setup, id: started.id, sequence: 0 };
  await edit(context, 'edit', 'scope.test.mjs', "import {test} from 'node:test'; test('scope',()=>{});\n");
  const oldCheck = await check(context, 'edit');
  const original = await finish(context, 'edit');
  await context.writes.revise(context.origin, context.id, 'edit', original.digest, correction, context.parent());
  await context.supervisor.tick();
  const noCheck = await finish(context, 'edit');
  assert.equal(noCheck.artifact.digest, original.artifact.digest);
  await assert.rejects(context.writes.accept(context.origin, context.id, 'edit', noCheck.digest, context.parent()), /check_missing|check_stale/);
  assert.equal(context.asks.length, 1);
  await context.writes.revise(context.origin, context.id, 'edit', noCheck.digest, 'Run the already approved check before resubmitting.', context.parent());
  await context.supervisor.tick();
  const freshCheck = await check(context, 'edit');
  assert.equal(freshCheck.exitCode, 0);
  assert.equal(freshCheck.artifactDigest, oldCheck.artifactDigest);
  assert.notEqual(freshCheck.id, oldCheck.id);
  const restarted = new OperatorWrites(context.jobs, context.client, context.permissions);
  const repeatedCall = await native(context, 'edit', 'check');
  assert.deepEqual(await restarted.check(repeatedCall.toolContext, repeatedCall.callID, { checkID: 'unit' }), freshCheck);
  const final = await finish(context, 'edit');
  await restarted.accept(context.origin, context.id, 'edit', final.digest, context.parent());
  assert.deepEqual((await child(context, 'edit')).write!.checks, [oldCheck, freshCheck]);
  assert.equal(context.asks.length, 2);
});

test('revision wins against an outstanding acceptance without overwriting its history or accepting the old result', async () => {
  const context = await emptyReview();
  const asked = deferred();
  const reply = deferred();
  const pendingAcceptance = context.writes.accept(context.origin, context.id, 'edit', context.review.digest,
    context.parent(async () => { asked.resolve(); await reply.promise; }));
  const rejection = assert.rejects(pendingAcceptance);
  await asked.promise;
  try {
    await context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent());
  } finally { reply.resolve(); }
  await rejection;
  const revised = await child(context, 'edit');
  assert.equal(revised.status, 'queued');
  assert.equal(revised.write!.acceptance, undefined);
  assert.equal(revised.write!.revisions!.length, 1);
  await context.supervisor.tick();
  assert.equal(context.client.prompts, 2);
});

test('parent pause during slow revision inspection stays responsive and invalidates the pending transition', async () => {
  const context = await emptyReview();
  const entered = deferred();
  const release = deferred();
  const read = context.client.readSession.bind(context.client);
  context.client.readSession = async (directory, sessionID) => {
    entered.resolve();
    await release.promise;
    return read(directory, sessionID);
  };
  const pending = context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent());
  const rejection = assert.rejects(pending);
  await entered.promise;
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      context.supervisor.intervene(context.origin, context.id, 'pause'),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('revision_held_parent_lock')), 2_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    release.resolve();
  }
  await rejection;
  const job = await context.jobs.get(context.origin, context.id);
  assert.equal(job.status, 'paused');
  assert.equal(job.children[0]!.write!.revisions, undefined);
  assert.equal(job.children[0]!.status, 'needs-review');
  assert.equal(context.client.prompts, 1);
});

test('queued descendants stay queued through revision and start only after the revised result is accepted', async () => {
  const context = await emptyReview({ dependent: true });
  const pending = await child(context, 'dependent');
  assert.equal(pending.status, 'queued');
  assert.equal(pending.sessionID, undefined);
  await context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent());
  await context.supervisor.tick();
  assert.deepEqual(await child(context, 'dependent'), pending);
  const revised = await finish(context, 'edit');
  assert.deepEqual(await child(context, 'dependent'), pending);
  await context.writes.accept(context.origin, context.id, 'edit', revised.digest, context.parent());
  await context.supervisor.tick();
  assert.equal((await child(context, 'dependent')).status, 'running');
  assert.equal(context.client.prompts, 3);
});

test('changed approved scope, a started descendant and an uncertain check each refuse revision without mutation', async () => {
  const cases = {
    scope: async (context: Awaited<ReturnType<typeof emptyReview>>) => {
      await context.jobs.transaction(async (ledger, save) => {
        context.jobs.bound(ledger, context.origin, context.id).children[0]!.goal = 'An unrelated expanded goal';
        await save();
      });
    },
    descendant: async (context: Awaited<ReturnType<typeof emptyReview>>) => {
      await context.jobs.transaction(async (ledger, save) => {
        const dependent = context.jobs.bound(ledger, context.origin, context.id).children.find(candidate => candidate.id === 'dependent')!;
        dependent.status = 'blocked';
        dependent.sessionID = 'ses_previous_dependent';
        await save();
      });
    },
    uncertain: async (context: Awaited<ReturnType<typeof emptyReview>>) => {
      await context.jobs.transaction(async (ledger, save) => {
        context.jobs.bound(ledger, context.origin, context.id).children[0]!.write!.checks = [{
          id: 'check_unresolved', checkID: 'unit', command: ['node', '--test', 'scope.test.mjs'],
          callID: 'call_unresolved', messageID: 'msg_unresolved', artifactDigest: context.review.artifact.digest,
          status: 'prepared', startedAt: new Date().toISOString(),
        }];
        await save();
      });
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    const context = await emptyReview({ dependent: true, check: true });
    await change(context);
    const before = await context.jobs.get(context.origin, context.id);
    await assert.rejects(context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent()),
      /scope_changed|dependent_started|effect_uncertain/, name);
    assert.deepEqual(await context.jobs.get(context.origin, context.id), before);
    assert.equal(context.client.prompts, 1);
  }
});

test('an identical revision completed during a slow artifact read is still an idempotent success', async () => {
  const context = await emptyReview();
  const inspected = deferred();
  const release = deferred();
  const inspect = context.writes.inspect.bind(context.writes);
  let first = true;
  context.writes.inspect = async (...args) => {
    const artifact = await inspect(...args);
    if (first) {
      first = false;
      inspected.resolve();
      await release.promise;
    }
    return artifact;
  };
  const pending = context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent());
  await inspected.promise;
  try {
    await context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent());
  } finally { release.resolve(); }
  await pending;
  assert.equal((await child(context, 'edit')).write!.revisions!.length, 1);
  await context.supervisor.tick();
  assert.equal(context.client.prompts, 2);
  assert.equal(context.asks.length, 1);
});

test('foreign work arriving after revision is queued stays fenced without another child prompt', async () => {
  const context = await emptyReview();
  await context.writes.revise(context.origin, context.id, 'edit', context.review.digest, correction, context.parent());
  const queued = await child(context, 'edit');
  const snapshot = context.client.sessions.get(queued.sessionID!)!.snapshot;
  snapshot.messages.push({ id: 'msg_later_genuine_work', role: 'user', text: 'A later genuine request in this session', tools: [] });
  const transcript = structuredClone(snapshot.messages);
  await context.supervisor.tick();
  const blocked = await child(context, 'edit');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker, 'operator_child_foreign_work');
  await context.supervisor.tick();
  assert.equal((await child(context, 'edit')).blocker, 'operator_child_foreign_work');
  assert.deepEqual(snapshot.messages, transcript);
  assert.deepEqual(blocked.write!.revisions, queued.write!.revisions);
  assert.deepEqual(blocked.attempts, queued.attempts);
  assert.equal(context.client.prompts, 1);
});
