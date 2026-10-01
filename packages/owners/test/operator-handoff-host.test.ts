import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { listAdmissions } from '../src/deployment-admission.ts';
import { OperatorHandoffs } from '../src/operator-handoff-host.ts';
import { OperatorJobs, operatorJobDigest } from '../src/operator-jobs.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { operatorCheckRecordDigest } from '../src/operator-check-types.ts';
import type { OperatorCheckRun } from '../src/operator-check-runner.ts';
import { handoffFixture } from './operator-handoff-fixture.ts';

type Fixture = Awaited<ReturnType<typeof handoffFixture>>;
type Report = Awaited<ReturnType<OperatorHandoffs['show']>>;
const completed: OperatorCheckRun = { exitCode: 0, output: 'fixture completed', outputTruncated: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function host(context: Fixture, run?: () => Promise<OperatorCheckRun>, preflight = async () => {}) {
  return new OperatorHandoffs(context.jobs, context.client, context.writes,
    run ? { run, preflight } : undefined);
}

async function settled(handoffs: OperatorHandoffs, context: Fixture, expected: Report['status']) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const report = await handoffs.show(context.origin, context.id);
    if (report.status === expected) return report;
    await delay(20);
  }
  assert.fail(`handoff did not reach ${expected}`);
}

async function admissions(context: Fixture) {
  return (await listAdmissions(context.jobs.home)).filter(lease => lease.kind === 'plugin:operator-handoff' && lease.alive);
}

async function released(context: Fixture) {
  const deadline = Date.now() + 5_000;
  while ((await admissions(context)).length && Date.now() < deadline) await delay(20);
  assert.equal((await admissions(context)).length, 0);
}

async function launch(handoffs: OperatorHandoffs, context: Fixture) {
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const checkID = prepared.artifact.checks[0]!.id;
  const pending = await handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  return { prepared, checkID, pending };
}

test('two individually passing accepted changes produce a durable real combined-check failure without applying it', async () => {
  const context = await handoffFixture({ combinedFails: true });
  const handoffs = host(context);
  const before = await readFile(context.jobs.path, 'utf8');
  const { prepared, checkID, pending } = await launch(handoffs, context);
  assert.ok(['checking', 'failed'].includes(pending.status), 'a fast completed check must not appear uncertain');
  assert.equal(pending.application, 'not-applied');
  const failed = await settled(handoffs, context, 'failed');
  assert.equal(failed.checks.length, 1);
  assert.equal(failed.checks[0]!.status, 'completed');
  assert.notEqual(failed.checks[0]!.exitCode, 0);
  assert.match(failed.checks[0]!.output!, /combined contract/);
  assert.equal(failed.checks[0]!.digest, operatorCheckRecordDigest(failed.checks[0]!));
  assert.equal(failed.checks[0]!.artifactDigest, prepared.artifact.digest);
  const repeated = await handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  assert.deepEqual(repeated.checks, failed.checks);
  assert.equal(await readFile(context.jobs.path, 'utf8'), before, 'preview checks never rewrite job or mutation history');
  assert.equal(await readFile(join(context.directory, 'b.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await readFile(join(context.second, 'a.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal((await context.git(['rev-parse', 'HEAD'])).stdout.trim(), context.head);
  assert.equal(context.asks.length, 3, 'only existing scope and two exact child acceptances ask');
  await released(context);
});

test('a real passing combined check survives reopening and leaves both original worktrees unapplied', async () => {
  const context = await handoffFixture();
  const handoffs = host(context);
  await launch(handoffs, context);
  const ready = await settled(handoffs, context, 'ready');
  assert.equal(ready.checks[0]!.exitCode, 0);
  assert.match(ready.checks[0]!.output!, /combined contract/);
  assert.match(await readFile(ready.paths.patch, 'utf8'), /a\.mjs/);
  assert.match(await readFile(ready.paths.patch, 'utf8'), /b\.mjs/);
  const reopened = host(context, async () => { throw new Error('unexpected_ready_replay'); });
  const report = await reopened.show(context.origin, context.id);
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.checks, ready.checks);
  assert.equal(report.application, 'not-applied');
  assert.equal(await readFile(join(context.directory, 'b.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(await readFile(join(context.second, 'a.mjs'), 'utf8'), 'export default 0;\n');
  assert.equal(context.asks.length, 3);
  await released(context);
});

test('pending checks return promptly, keep independent admission, and reuse one durable claim while parent reads remain responsive', async () => {
  const context = await handoffFixture();
  const gate = deferred<OperatorCheckRun>();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return gate.promise; });
  try {
    const { prepared, checkID, pending } = await launch(handoffs, context);
    assert.equal(pending.status, 'checking');
    assert.equal(pending.checks[0]!.status, 'prepared');
    assert.equal((await admissions(context)).length, 1);
    const retries = await Promise.all(Array.from({ length: 4 }, () =>
      handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent())));
    assert.ok(retries.every(report => report.checks[0]!.id === pending.checks[0]!.id));
    await context.jobs.transaction(async (_ledger, _save) => {});
    assert.equal((await handoffs.show(context.origin, context.id)).status, 'checking');
    assert.equal(calls, 1);
    gate.resolve(completed);
    const ready = await settled(handoffs, context, 'ready');
    assert.equal(ready.checks[0]!.exitCode, 0);
    await released(context);
    const reopenedJobs = new OperatorJobs(context.jobs.home, context.jobs.workspace, context.jobs.operator);
    const reopened = new OperatorHandoffs(reopenedJobs, context.client, context.writes, {
      run: async () => { throw new Error('unexpected_replay'); },
      preflight: async () => { throw new Error('unexpected_reuse_preflight'); },
    });
    const reused = await reopened.check(context.origin, context.id, ready.artifact.digest, checkID, context.parent());
    assert.equal(reused.status, 'ready');
    assert.deepEqual(reused.checks, ready.checks);
    assert.equal(context.asks.length, 3);
  } finally { gate.resolve(completed); }
});

test('prepared evidence reopens as uncertain and never starts a replacement worker', async () => {
  const context = await handoffFixture();
  const gate = deferred<OperatorCheckRun>();
  const handoffs = host(context, () => gate.promise);
  try {
    const { prepared, checkID, pending } = await launch(handoffs, context);
    const reopened = host(context, async () => { throw new Error('unexpected_restart_replay'); });
    assert.equal((await reopened.show(context.origin, context.id)).status, 'uncertain');
    const reused = await reopened.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
    assert.equal(reused.status, 'uncertain');
    assert.deepEqual(reused.checks, pending.checks);
    gate.resolve(completed);
    await settled(handoffs, context, 'ready');
    await released(context);
  } finally { gate.resolve(completed); }
});

test('a known setup failure completes and is reused without preflight or implicit retry', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => {
    calls++;
    return { exitCode: 125, output: 'operator_check_setup_failed', outputTruncated: false };
  });
  const { prepared, checkID } = await launch(handoffs, context);
  const failed = await settled(handoffs, context, 'failed');
  assert.equal(failed.checks[0]!.exitCode, 125);
  assert.equal(failed.checks[0]!.digest, operatorCheckRecordDigest(failed.checks[0]!));
  const reused = await handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  assert.deepEqual(reused.checks, failed.checks);
  assert.equal(calls, 1);
  await released(context);
});

test('unproved process exit retains both durable prepared evidence and independent admission', async () => {
  const context = await handoffFixture();
  const gate = deferred<OperatorCheckRun>();
  const handoffs = host(context, () => gate.promise);
  const { prepared, checkID, pending } = await launch(handoffs, context);
  gate.reject(new Error('operator_check_process_uncertain'));
  const uncertain = await settled(handoffs, context, 'uncertain');
  assert.deepEqual(uncertain.checks, pending.checks);
  assert.equal((await admissions(context)).length, 1, 'deployment remains blocked without stop proof');
  const reused = await handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  assert.deepEqual(reused.checks, pending.checks);
});

test('tool cancellation after durable claim does not cancel host-owned completion', async () => {
  const context = await handoffFixture();
  const gate = deferred<OperatorCheckRun>();
  const handoffs = host(context, () => gate.promise);
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const controller = new AbortController();
  const toolContext = { ...context.parent(), abort: controller.signal };
  try {
    await handoffs.check(context.origin, context.id, prepared.artifact.digest, prepared.artifact.checks[0]!.id, toolContext);
    controller.abort();
    gate.resolve(completed);
    assert.equal((await settled(handoffs, context, 'ready')).checks[0]!.exitCode, 0);
    await released(context);
  } finally { gate.resolve(completed); }
});

test('source changed before launch is stale and creates no runner or admission effects', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  await writeFile(join(context.directory, 'a.mjs'), 'export default 99;\n');
  await assert.rejects(handoffs.check(context.origin, context.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, context.parent()), /stale|changed|mismatch/);
  const stale = await handoffs.show(context.origin, context.id);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.current, false);
  assert.equal(stale.checks.length, 0);
  assert.equal(calls, 0);
  await released(context);
});

test('source changed during preflight is rejected before a durable check claim', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; }, async () => {
    await writeFile(join(context.second, 'b.mjs'), 'export default 99;\n');
  });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  await assert.rejects(handoffs.check(context.origin, context.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, context.parent()), /stale|changed|mismatch/);
  assert.equal((await handoffs.show(context.origin, context.id)).checks.length, 0);
  assert.equal(calls, 0);
  await released(context);
});

test('foreign parent origin and an unconfigured check cannot acquire a claim', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  await assert.rejects(handoffs.check({ ...context.origin, sessionID: 'ses_foreign' }, context.id,
    prepared.artifact.digest, prepared.artifact.checks[0]!.id, context.parent()));
  await assert.rejects(handoffs.check(context.origin, context.id, prepared.artifact.digest, 'unconfigured', context.parent()));
  assert.equal((await handoffs.show(context.origin, context.id)).checks.length, 0);
  assert.equal(calls, 0);
  await released(context);
});

test('receipt persistence failure releases proved-stopped admission but keeps the prepared claim unreplayable', async () => {
  const context = await handoffFixture();
  const gate = deferred<OperatorCheckRun>();
  const handoffs = host(context, () => gate.promise);
  const { prepared, checkID, pending } = await launch(handoffs, context);
  const path = join(context.jobs.home, 'operator-handoffs', 'records.json');
  const backup = `${path}.fixture-backup`;
  await rename(path, backup);
  await mkdir(path);
  try {
    gate.resolve(completed);
    await released(context);
  } finally {
    gate.resolve(completed);
    await rm(path, { recursive: true, force: true });
    await rename(backup, path);
  }
  const reopened = host(context, async () => { throw new Error('unexpected_persistence_failure_replay'); });
  const report = await reopened.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  assert.equal(report.status, 'uncertain');
  assert.deepEqual(report.checks, pending.checks);
});

test('already aborted requests create no durable prepared check', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(handoffs.check(context.origin, context.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, { ...context.parent(), abort: controller.signal }));
  assert.equal((await handoffs.show(context.origin, context.id)).checks.length, 0);
  assert.equal(calls, 0);
  await released(context);
});

test('two durable prepared checks bound concurrent work across handoffs in one state directory', async () => {
  const contexts = [await handoffFixture(), await handoffFixture(), await handoffFixture()];
  const jobs = new OperatorJobs(contexts[0]!.jobs.home, dirname(contexts[0]!.workspace), 'operator');
  const additional = await Promise.all(contexts.slice(1).map(context => context.jobs.get(context.origin, context.id)));
  await jobs.transaction(async (ledger, save) => {
    ledger.jobs.push(...additional);
    await save();
  });
  const gate = deferred<OperatorCheckRun>();
  let calls = 0;
  const shared = contexts.map(context => ({ ...context, jobs,
    writes: new OperatorWrites(jobs, context.client, context.permissions) }));
  const hosts = shared.map(context => host(context, async () => { calls++; return gate.promise; }));
  try {
    await launch(hosts[0]!, shared[0]!);
    await launch(hosts[1]!, shared[1]!);
    const third = await hosts[2]!.prepare(shared[2]!.origin, shared[2]!.id, shared[2]!.parent());
    await assert.rejects(hosts[2]!.check(shared[2]!.origin, shared[2]!.id,
      third.artifact.digest, third.artifact.checks[0]!.id, shared[2]!.parent()));
    assert.equal(calls, 2);
    assert.equal((await hosts[2]!.show(shared[2]!.origin, shared[2]!.id)).checks.length, 0);
    assert.equal((await admissions(shared[0]!)).length, 2);
    gate.resolve(completed);
    await Promise.all(shared.slice(0, 2).map((context, index) => settled(hosts[index]!, context, 'ready')));
    await released(shared[0]!);
  } finally { gate.resolve(completed); }
});

test('a job changed immediately before claim fails the compare-and-swap without starting a check', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const transact = context.jobs.transaction.bind(context.jobs);
  let changed = false;
  context.jobs.transaction = action => transact(async (ledger, save) => {
    if (!changed) {
      ledger.jobs.find(job => job.id === context.id)!.goal = 'A concurrently revised goal';
      await save();
      changed = true;
    }
    return action(ledger, save);
  });
  await assert.rejects(handoffs.check(context.origin, context.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, context.parent()), /operator_handoff_job_stale/);
  assert.equal(calls, 0);
  assert.equal((await handoffs.store.read()).records[0]!.checks.length, 0);
  await released(context);
});

test('an accepted artifact without configured commands is explicitly unchecked', async () => {
  const context = await handoffFixture({ checks: false });
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; });
  const report = await handoffs.prepare(context.origin, context.id, context.parent());
  assert.equal(report.status, 'unchecked');
  assert.equal(report.application, 'not-applied');
  assert.deepEqual(report.artifact.checks, []);
  assert.deepEqual(report.checks, []);
  await assert.rejects(handoffs.check(context.origin, context.id, report.artifact.digest, 'unit', context.parent()));
  assert.equal(calls, 0);
  assert.equal(context.asks.length, 3);
});

test('a stored receipt with altered output cannot be shown or reused as passing evidence', async () => {
  const context = await handoffFixture();
  const handoffs = host(context, async () => completed);
  const { checkID } = await launch(handoffs, context);
  const ready = await settled(handoffs, context, 'ready');
  await released(context);
  const ledger = await handoffs.store.read();
  ledger.records[0]!.checks[0]!.output = 'Altered after digest was signed';
  await writeFile(handoffs.store.path, JSON.stringify(ledger));
  const reopened = host(context, async () => { throw new Error('unexpected_corrupt_receipt_replay'); });
  await assert.rejects(reopened.show(context.origin, context.id), /operator_handoff_record_invalid/);
  await assert.rejects(reopened.check(context.origin, context.id, ready.artifact.digest, checkID, context.parent()), /operator_handoff_record_invalid/);
});

test('a concurrent pause during live metadata validation makes the shown handoff stale', async () => {
  const context = await handoffFixture();
  const handoffs = host(context, async () => completed);
  await launch(handoffs, context);
  await settled(handoffs, context, 'ready');
  await released(context);
  const entered = deferred<void>();
  const gate = deferred<void>();
  const read = context.client.readSession.bind(context.client);
  let blocked = false;
  context.client.readSession = async (...args) => {
    if (!blocked) {
      blocked = true;
      entered.resolve();
      await gate.promise;
    }
    return read(...args);
  };
  const showing = handoffs.show(context.origin, context.id);
  try {
    await entered.promise;
    await context.supervisor.intervene(context.origin, context.id, 'pause');
    gate.resolve();
    const report = await showing;
    assert.equal(report.status, 'stale');
    assert.equal(report.current, false);
    assert.equal(report.reason, 'operator_handoff_job_stale');
    assert.equal(report.checks[0]!.exitCode, 0, 'historical passing evidence remains visible');
  } finally { gate.resolve(); }
});


test('synthesis after prepare preserves handoff binding and completed-job history through checking and reuse', async () => {
  const context = await handoffFixture();
  let calls = 0;
  const handoffs = host(context, async () => { calls++; return completed; });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const job = await context.jobs.get(context.origin, context.id);
  const originalDigest = operatorJobDigest(job);
  const synthesized = await context.jobs.synthesize(context.origin, context.id, originalDigest,
    job.children.map(child => child.evidence!.messageID), 'Both accepted edits retain their individual evidence. Combined checks remain separate.');
  assert.equal(synthesized.status, 'completed');
  assert.equal(operatorJobDigest(synthesized), originalDigest, 'status, events and synthesis do not alter the input/evidence digest');
  const savedJob = await readFile(context.jobs.path, 'utf8');
  const reprepared = await handoffs.prepare(context.origin, context.id, context.parent());
  assert.equal(reprepared.artifact.digest, prepared.artifact.digest);
  assert.equal(reprepared.status, 'needs-checks');
  const checkID = prepared.artifact.checks[0]!.id;
  await handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  const ready = await settled(handoffs, context, 'ready');
  const reopened = host(context, async () => { throw new Error('unexpected_completed_job_replay'); });
  const reused = await reopened.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  assert.equal(reused.current, true);
  assert.equal(reused.status, 'ready');
  assert.deepEqual(reused.checks, ready.checks);
  assert.equal(calls, 1);
  assert.equal(await readFile(context.jobs.path, 'utf8'), savedJob);
  await released(context);
});
