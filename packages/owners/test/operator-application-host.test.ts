import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { OperatorHandoffs } from '../src/operator-handoff-host.ts';
import { OperatorApplications } from '../src/operator-application-host.ts';
import { OperatorApplicationStore } from '../src/operator-application-store.ts';
import { OperatorApplication } from '../src/operator-application-types.ts';
import { operatorApplicationEffects } from '../src/operator-application-files.ts';
import { operatorApplicationHoldsWorkspace } from '../src/operator-write-state.ts';
import { operatorJobDigest } from '../src/operator-jobs.ts';
import { listAdmissions } from '../src/deployment-admission.ts';
import { acceptHandoffChildren, setupHandoffFixture } from './operator-handoff-fixture.ts';

async function applicationFixture(options: { combinedFails?: boolean; newFile?: boolean } = {}) {
  const setup = await setupHandoffFixture(options);
  const target = join(setup.workspace, 'destination');
  await setup.git(['worktree', 'add', '-q', '--detach', target, setup.head]);
  if (options.newFile) setup.input.tasks[0]!.createFiles = ['created.txt'];
  const context = await acceptHandoffChildren(setup, options.newFile ? {
    left: { 'a.mjs': 'export default 1;\n', 'created.txt': 'Approved new content\n' },
    right: { 'b.mjs': 'export default 2;\n' },
  } : undefined);
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes);
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  for (const check of prepared.artifact.checks) {
    await handoffs.check(context.origin, context.id, prepared.artifact.digest, check.id, context.parent());
    const expected = options.combinedFails ? 'failed' : 'ready';
    const deadline = Date.now() + 15_000;
    let status = (await handoffs.show(context.origin, context.id)).status;
    while (status !== expected && Date.now() < deadline) {
      await delay(20);
      status = (await handoffs.show(context.origin, context.id)).status;
    }
    assert.equal(status, expected, 'actual combined check must finish before application');
  }
  const sourceJob = await context.jobs.get(context.origin, context.id);
  return { ...context, target, handoffs, handoff: prepared.artifact, sourceJob };
}

type Fixture = Awaited<ReturnType<typeof applicationFixture>>;

async function assertOriginalWorkPreserved(context: Fixture) {
  const current = await context.jobs.get(context.origin, context.id);
  assert.deepEqual(current.intake, context.sourceJob.intake);
  assert.equal(current.goal, context.sourceJob.goal);
  assert.deepEqual(current.constraints, context.sourceJob.constraints);
  assert.deepEqual(current.children, context.sourceJob.children);
  assert.equal(operatorJobDigest(current), operatorJobDigest(context.sourceJob));
  assert.equal(await readFile(join(context.directory, 'a.mjs'), 'utf8'), 'export default 1;\n');
  assert.equal(await readFile(join(context.directory, 'b.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await readFile(join(context.second, 'a.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await readFile(join(context.second, 'b.mjs'), 'utf8'), 'export default 2;\n');
  assert.equal((await context.git(['--no-optional-locks', '-C', context.target, 'rev-parse', 'HEAD'])).stdout.trim(), context.head);
}

async function assertDestinationBefore(context: Fixture) {
  assert.equal(await readFile(join(context.target, 'a.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await readFile(join(context.target, 'b.mjs'), 'utf8'), 'export default 0;\n');
}

async function settled(applications: OperatorApplications, context: Fixture, expected: 'applied' | 'blocked') {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const report = await applications.show(context.origin, context.id);
    if (report.status === expected) return report;
    await delay(20);
  }
  assert.fail(`application did not become ${expected}: ${JSON.stringify(await applications.show(context.origin, context.id))}`);
}

async function released(context: Fixture) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await context.jobs.get(context.origin, context.id);
    const claimed = job.applicationClaims?.some(operatorApplicationHoldsWorkspace);
    const active = (await listAdmissions(context.jobs.home)).some(lease => lease.kind === 'plugin:operator-application' && lease.alive);
    const record = await new OperatorApplicationStore(context.jobs.home).read(context.id);
    if (!claimed && !active && record?.workers.every(worker => worker.endedAt)) return;
    await delay(20);
  }
  assert.fail('application reservation or exact worker admission was not released');
}

async function assertClaimHeld(context: Fixture) {
  const job = await context.jobs.get(context.origin, context.id);
  assert.equal(job.applicationClaims?.filter(operatorApplicationHoldsWorkspace).length, 1);
  await assert.rejects(context.jobs.create(context.origin, { messageID: 'msg_conflict', text: 'Inspect this destination' },
    { key: 'blocked_reader', goal: 'Read destination', constraints: [], tasks: [{ id: 'read', directory: context.target,
      access: 'read-only', goal: 'Read destination', dependsOn: [] }] }), /workspace_conflict/);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('native once applies the real checked union including a new file only to its exact destination and preserves original accepted work', async () => {
  const context = await applicationFixture({ newFile: true });
  const applications = new OperatorApplications(context.handoffs, context.permissions);
  const preview = await applications.preview(context.origin, context.id, context.target);
  assert.equal(context.asks.length, 3, 'read-only preview must not ask or apply');
  await assertDestinationBefore(context);
  const pending = await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  assert.ok(['approved', 'applying', 'applied'].includes(pending.status));
  const report = await settled(applications, context, 'applied');
  await released(context);
  assert.equal(await readFile(join(context.target, 'a.mjs'), 'utf8'), 'export default 1;\n');
  assert.equal(await readFile(join(context.target, 'b.mjs'), 'utf8'), 'export default 2;\n');
  assert.equal(await readFile(join(context.target, 'created.txt'), 'utf8'), 'Approved new content\n');
  assert.equal(await readFile(join(context.directory, 'created.txt'), 'utf8'), 'Approved new content\n');
  await assert.rejects(readFile(join(context.second, 'created.txt')), { code: 'ENOENT' });
  assert.equal(report.result!.sourceDigest, context.handoff.sourceDigest);
  const record = (await applications.store.read(context.id))!;
  assert.equal(record.scope.digest, preview.digest);
  assert.equal(record.approval.proof.reply, 'once');
  assert.equal(record.operations.length, 3);
  assert.ok(record.operations.every(operation => operation.status === 'applied' && operation.receipt && operation.attempts.length === 1));
  assert.equal(context.asks.length, 4);
  const ask = context.asks.at(-1)!;
  assert.equal(ask.metadata.mode, 'apply-handoff');
  assert.equal(ask.metadata.approvalScope, 'once');
  assert.equal(ask.metadata.directory, context.target);
  assert.equal(ask.metadata.digest, preview.digest);
  assert.deepEqual(ask.always, []);
  await assertOriginalWorkPreserved(context);
  const originalRecord = await readFile(applications.store.path(context.id), 'utf8');
  const reopened = new OperatorApplications(context.handoffs, context.permissions, {
    ...operatorApplicationEffects,
    run: async () => { throw new Error('unexpected_completed_replay'); },
  });
  await reopened.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await reopened.reconcile();
  await delay(50);
  assert.equal((await reopened.show(context.origin, context.id)).status, 'applied');
  assert.equal(await readFile(applications.store.path(context.id), 'utf8'), originalRecord);
  assert.equal(context.asks.length, 4);
  await assert.rejects(reopened.apply(context.origin, context.id, context.second, preview.digest, context.parent()), /scope_mismatch/);
  const tampered = structuredClone(record);
  const attempt = tampered.operations[0]!.attempts[0]!;
  const otherWitness = tampered.operations[1]!.attempts[0]!.witness!;
  assert.notDeepEqual(attempt.witness!.namespace, otherWitness.namespace);
  attempt.inspection!.proof!.namespace = otherWitness.namespace;
  assert.equal(OperatorApplication.safeParse(tampered).success, false, 'another stopped publisher cannot prove this attempt stopped');
  try {
    await writeFile(applications.store.path(context.id), JSON.stringify(tampered));
    await assert.rejects(applications.store.read(context.id), /stop_proof_mismatch/);
  } finally { await writeFile(applications.store.path(context.id), originalRecord); }
});

test('denial and blanket permission leave destination and application history untouched', async () => {
  const context = await applicationFixture();
  const applications = new OperatorApplications(context.handoffs, context.permissions);
  const preview = await applications.preview(context.origin, context.id, context.target);
  for (const reply of ['reject', 'always']) {
    await assert.rejects(applications.apply(context.origin, context.id, context.target, preview.digest, context.parent(undefined, reply)));
    assert.equal(await applications.store.read(context.id), undefined);
    assert.equal((await context.jobs.get(context.origin, context.id)).applicationClaims, undefined);
    await assertDestinationBefore(context);
  }
  await assertOriginalWorkPreserved(context);
});

test('target drift while native approval is pending prevents publication and preserves intervening bytes', async () => {
  const context = await applicationFixture();
  const applications = new OperatorApplications(context.handoffs, context.permissions);
  const preview = await applications.preview(context.origin, context.id, context.target);
  await assert.rejects(applications.apply(context.origin, context.id, context.target, preview.digest,
    context.parent(async () => { await writeFile(join(context.target, 'a.mjs'), 'export default 777;\n'); })));
  assert.equal(await readFile(join(context.target, 'a.mjs'), 'utf8'), 'export default 777;\n');
  assert.equal(await readFile(join(context.target, 'b.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await applications.store.read(context.id), undefined);
  assert.equal((await context.jobs.get(context.origin, context.id)).applicationClaims, undefined);
  await assertOriginalWorkPreserved(context);
});

test('failed combined checks and foreign origin cannot become an application approval', async () => {
  const context = await applicationFixture({ combinedFails: true });
  const applications = new OperatorApplications(context.handoffs, context.permissions);
  await assert.rejects(applications.preview(context.origin, context.id, context.target), /checks_not_ready/);
  await assert.rejects(applications.preview({ ...context.origin, sessionID: 'ses_foreign' }, context.id, context.target));
  assert.equal(context.asks.length, 3);
  await assertDestinationBefore(context);
});

test('wrong digest, original child destination and stale accepted source refuse before native application approval', async () => {
  const context = await applicationFixture();
  const applications = new OperatorApplications(context.handoffs, context.permissions);
  const preview = await applications.preview(context.origin, context.id, context.target);
  await assert.rejects(applications.apply(context.origin, context.id, context.target, '0'.repeat(64), context.parent()), /scope_stale/);
  await assert.rejects(applications.preview(context.origin, context.id, context.directory), /target_invalid/);
  await writeFile(join(context.directory, 'a.mjs'), 'export default 999;\n');
  await assert.rejects(applications.apply(context.origin, context.id, context.target, preview.digest, context.parent()), /checks_not_ready|source_stale/);
  assert.equal(context.asks.length, 3);
  await assertDestinationBefore(context);
});

test('an active destination reader blocks the application with an actionable conflict and no file effects', async () => {
  const context = await applicationFixture();
  const applications = new OperatorApplications(context.handoffs, context.permissions);
  const preview = await applications.preview(context.origin, context.id, context.target);
  const reader = await context.jobs.create(context.origin, { messageID: 'msg_reader', text: 'Investigate target before changing it' },
    { key: 'active_reader', goal: 'Investigate destination', constraints: [], tasks: [{ id: 'read', directory: context.target,
      goal: 'Inspect target', access: 'read-only', dependsOn: [] }] });
  await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  const blocked = await settled(applications, context, 'blocked');
  assert.match(blocked.reason!, /operator_workspace_conflict/);
  assert.deepEqual(await context.jobs.get(context.origin, reader.id), reader);
  assert.equal((await context.jobs.get(context.origin, context.id)).applicationClaims, undefined);
  await assertDestinationBefore(context);
  await assertOriginalWorkPreserved(context);
});

test('a slow real publisher keeps status and other intake responsive while its exact target remains reserved', async () => {
  const context = await applicationFixture();
  const entered = deferred();
  const continuePublish = deferred();
  let runs = 0;
  const applications = new OperatorApplications(context.handoffs, context.permissions, {
    ...operatorApplicationEffects,
    run: async (intent, hooks) => {
      runs++;
      if (runs === 1) {
        entered.resolve();
        await continuePublish.promise;
      }
      return operatorApplicationEffects.run(intent, hooks);
    },
  });
  const preview = await applications.preview(context.origin, context.id, context.target);
  try {
    await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
    await Promise.race([entered.promise, delay(15_000).then(() => { throw new Error('application_publisher_not_entered'); })]);
    assert.equal((await applications.show(context.origin, context.id)).status, 'applying');
    await assertClaimHeld(context);
    await Promise.race([context.jobs.list(context.origin), delay(1_000).then(() => { throw new Error('application_held_jobs_lock'); })]);
    assert.ok(await context.jobs.create(context.origin, { messageID: 'msg_parallel', text: 'Inspect separate work' },
      { key: 'parallel_reader', goal: 'Inspect separate work', constraints: [], tasks: [{ id: 'read', goal: 'Read accepted source',
        directory: context.directory, access: 'read-only', dependsOn: [] }] }));
    continuePublish.resolve();
    await settled(applications, context, 'applied');
    await released(context);
    assert.equal(runs, 2);
    await assertOriginalWorkPreserved(context);
  } finally { continuePublish.resolve(); }
});

test('restart after real publication but lost return adopts the exact postimage without repeating that file', async () => {
  const context = await applicationFixture();
  const runs: string[] = [];
  let loseReturn = true;
  const effects = { ...operatorApplicationEffects, run: async (...args: Parameters<typeof operatorApplicationEffects.run>) => {
    runs.push(args[0].mutation.path);
    const result = await operatorApplicationEffects.run(...args);
    if (loseReturn) {
      loseReturn = false;
      throw new Error('operator_application_fixture_lost_return');
    }
    return result;
  } };
  const applications = new OperatorApplications(context.handoffs, context.permissions, effects);
  const preview = await applications.preview(context.origin, context.id, context.target);
  await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await settled(applications, context, 'blocked');
  await assertClaimHeld(context);
  const interrupted = (await applications.store.read(context.id))!;
  assert.equal(interrupted.operations[0]!.attempts.length, 1);
  assert.ok(interrupted.operations[0]!.attempts[0]!.witness);
  const originalAttempt = structuredClone(interrupted.operations[0]!.attempts[0]!);
  const reopened = new OperatorApplications(context.handoffs, context.permissions, effects);
  await reopened.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await settled(reopened, context, 'applied');
  await released(context);
  const recovered = (await reopened.store.read(context.id))!;
  assert.equal(recovered.operations[0]!.attempts.length, 1);
  assert.equal(recovered.operations[0]!.attempts[0]!.id, originalAttempt.id);
  assert.deepEqual(recovered.operations[0]!.attempts[0]!.witness, originalAttempt.witness);
  assert.equal(runs.filter(path => path === recovered.scope.mutations[0]!.path).length, 1);
  assert.equal(runs.length, 2);
  assert.equal(context.asks.length, 4);
  await assertOriginalWorkPreserved(context);
});

test('restart after cleanup failure verifies existing publication and cleans only its stage without duplicate execution', async () => {
  const context = await applicationFixture();
  let cleanups = 0;
  const runs: string[] = [];
  const effects = { ...operatorApplicationEffects,
    run: async (...args: Parameters<typeof operatorApplicationEffects.run>) => {
      runs.push(args[0].mutation.path);
      return operatorApplicationEffects.run(...args);
    },
    cleanup: async (...args: Parameters<typeof operatorApplicationEffects.cleanup>) => {
      cleanups++;
      if (cleanups === 1) throw new Error('operator_application_fixture_cleanup_failed');
      return operatorApplicationEffects.cleanup(...args);
    },
  };
  const applications = new OperatorApplications(context.handoffs, context.permissions, effects);
  const preview = await applications.preview(context.origin, context.id, context.target);
  await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await settled(applications, context, 'blocked');
  await assertClaimHeld(context);
  assert.equal((await applications.store.read(context.id))!.operations[0]!.status, 'published');
  const reopened = new OperatorApplications(context.handoffs, context.permissions, effects);
  await reopened.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await settled(reopened, context, 'applied');
  await released(context);
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs).size, 2);
  assert.equal(context.asks.length, 4);
  await assertOriginalWorkPreserved(context);
});

test('foreign bytes after interrupted publication remain untouched and keep the destination reservation', async () => {
  const context = await applicationFixture();
  let runs = 0;
  const applications = new OperatorApplications(context.handoffs, context.permissions, {
    ...operatorApplicationEffects,
    run: async (...args: Parameters<typeof operatorApplicationEffects.run>) => {
      runs++;
      await operatorApplicationEffects.run(...args);
      throw new Error('operator_application_fixture_interrupted');
    },
  });
  const preview = await applications.preview(context.origin, context.id, context.target);
  await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await settled(applications, context, 'blocked');
  const interrupted = (await applications.store.read(context.id))!;
  const first = interrupted.scope.mutations[0]!;
  await writeFile(join(context.target, first.path), 'export default 777;\n');
  const reopened = new OperatorApplications(context.handoffs, context.permissions, {
    ...operatorApplicationEffects,
    run: async () => { runs++; throw new Error('unexpected_foreign_replay'); },
  });
  await reopened.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  const deadline = Date.now() + 15_000;
  let record = (await reopened.store.read(context.id))!;
  while (record.workers.length === interrupted.workers.length && Date.now() < deadline) {
    await delay(20);
    record = (await reopened.store.read(context.id))!;
  }
  const blocked = await settled(reopened, context, 'blocked');
  assert.match(blocked.reason!, /partial|foreign/);
  assert.equal(await readFile(join(context.target, first.path), 'utf8'), 'export default 777;\n');
  const second = interrupted.scope.mutations[1]!;
  assert.equal(await readFile(join(context.target, second.path), 'utf8'), 'export default 0;\n');
  await assertClaimHeld(context);
  assert.equal(runs, 1);
  assert.equal(context.asks.length, 4);
  await assertOriginalWorkPreserved(context);
});


test('restart finishes a failed post-result reservation release without replay or another approval', async () => {
  const context = await applicationFixture();
  const runs: string[] = [];
  const effects = { ...operatorApplicationEffects, run: async (...args: Parameters<typeof operatorApplicationEffects.run>) => {
    runs.push(args[0].mutation.path);
    return operatorApplicationEffects.run(...args);
  } };
  const releaseApplication = context.jobs.releaseApplication.bind(context.jobs);
  let failRelease = true;
  context.jobs.releaseApplication = async (...args) => {
    if (failRelease) {
      failRelease = false;
      throw new Error('operator_application_fixture_release_failed');
    }
    return releaseApplication(...args);
  };
  const applications = new OperatorApplications(context.handoffs, context.permissions, effects);
  const preview = await applications.preview(context.origin, context.id, context.target);
  await applications.apply(context.origin, context.id, context.target, preview.digest, context.parent());
  await settled(applications, context, 'applied');
  const deadline = Date.now() + 5_000;
  let interrupted = (await applications.store.read(context.id))!;
  while ((failRelease || interrupted.workers.some(worker => !worker.endedAt)) && Date.now() < deadline) {
    await delay(20);
    interrupted = (await applications.store.read(context.id))!;
  }
  assert.equal(failRelease, false);
  assert.ok(interrupted.workers.every(worker => worker.endedAt), 'known stopped execution releases its admission despite claim-release failure');
  assert.ok(interrupted.result);
  assert.equal(interrupted.claimReleasedAt, undefined);
  assert.equal((await listAdmissions(context.jobs.home)).filter(lease => lease.kind === 'plugin:operator-application' && lease.alive).length, 0);
  await assertClaimHeld(context);
  assert.equal(runs.length, 2);
  const reopened = new OperatorApplications(context.handoffs, context.permissions, {
    ...operatorApplicationEffects,
    run: async () => { runs.push('unexpected_replay'); throw new Error('unexpected_release_replay'); },
  });
  await reopened.reconcile();
  await released(context);
  const recovered = (await reopened.store.read(context.id))!;
  assert.ok(recovered.claimReleasedAt);
  assert.equal(recovered.status, 'applied');
  assert.deepEqual(recovered.result, interrupted.result);
  assert.deepEqual(recovered.operations, interrupted.operations);
  assert.deepEqual(recovered.workers, interrupted.workers);
  assert.equal(runs.length, 2);
  assert.equal(context.asks.length, 4);
  await assertOriginalWorkPreserved(context);
});
