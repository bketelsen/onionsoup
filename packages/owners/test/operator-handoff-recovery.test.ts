import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { listAdmissions } from '../src/deployment-admission.ts';
import { OperatorHandoffs } from '../src/operator-handoff-host.ts';
import { OperatorJobs } from '../src/operator-jobs.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { OperatorHandoffRecovery } from '../src/operator-handoff-recovery.ts';
import { OperatorHandoffExecutionJournal, operatorHandoffPreparedDigest } from '../src/operator-handoff-execution.ts';
import { OperatorRecoveryPermissions } from '../src/operator-recovery-permission.ts';
import { operatorCheckProcessIdentity, readOperatorCheckOwner, type OperatorCheckWitness } from '../src/operator-check-execution.ts';
import type { OperatorCheckRun } from '../src/operator-check-runner.ts';
import { handoffFixture } from './operator-handoff-fixture.ts';

type Fixture = Awaited<ReturnType<typeof handoffFixture>>;
type RecoveryContext = Parameters<OperatorHandoffRecovery['recover']>[5];
const outcome: OperatorCheckRun = { exitCode: 0, output: 'Host observed combined check completion', outputTruncated: false };
const note = 'Release this proven-stopped check reservation; the result remains unverified and must not be replayed.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** Real, reaped fixture identities exercise the read-only process inspector without a production process. */
async function stoppedWitness(): Promise<OperatorCheckWitness> {
  const owner = await readOperatorCheckOwner();
  const process = spawn('/usr/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  await once(process, 'spawn');
  const identity = operatorCheckProcessIdentity(await readFile(`/proc/${process.pid}/stat`, 'utf8'));
  const ended = once(process, 'exit');
  process.kill('SIGTERM');
  await ended;
  return { version: 1, owner, launcher: { pid: identity.pid, started: identity.started },
    namespace: { pid: identity.pid, started: identity.started } };
}

function permissionFixture(context: Fixture) {
  const permissions = new OperatorRecoveryPermissions({ eventGraceMs: 20 });
  let asks = 0;
  function parent(reply = 'once', during?: () => Promise<void>): RecoveryContext {
    const current = { ...context.parent(), messageID: `msg_handoff_recovery_${asks}` };
    return { ...current, ask: async request => {
      asks++;
      const id = `permission_handoff_recovery_${asks}`;
      permissions.event({ type: 'permission.asked', properties: { id, sessionID: current.sessionID,
        ...request, tool: { messageID: current.messageID, callID: `call_handoff_recovery_${asks}` } } });
      await during?.();
      permissions.event({ type: 'permission.replied', properties: {
        sessionID: current.sessionID, requestID: id, reply } });
    } };
  }
  return { permissions, parent, asks: () => asks };
}

async function uncertain(context: Fixture, observedWitness?: OperatorCheckWitness | false) {
  const witness = observedWitness ?? await stoppedWitness();
  let launches = 0;
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes, {
    preflight: async () => {},
    run: async (_command, _source, hooks) => {
      launches++;
      if (witness) await hooks!.onWitness(witness);
      throw new Error('operator_check_process_uncertain');
    },
  });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const checkID = prepared.artifact.checks[0]!.id;
  await handoffs.check(context.origin, context.id, prepared.artifact.digest, checkID, context.parent());
  for (let count = 0; count < 100; count++) {
    const report = await handoffs.show(context.origin, context.id);
    if (report.status === 'uncertain') {
      const record = (await handoffs.store.read()).records.find(record => record.artifact.jobID === context.id)!;
      const receipt = record.checks[0]!;
      const execution = record.executions!.find(execution => execution.receiptID === receipt.id)!;
      const native = permissionFixture(context);
      const recovery = new OperatorHandoffRecovery(handoffs, native.permissions);
      return { handoffs, checkID, receipt, execution, recovery, native, prepared,
        journal: new OperatorHandoffExecutionJournal(context.jobs.home, execution), launches: () => launches };
    }
    await delay(10);
  }
  assert.fail('fixture did not persist uncertain check');
}

async function aliveAdmissions(context: Fixture) {
  return (await listAdmissions(context.jobs.home)).filter(lease => lease.kind === 'plugin:operator-handoff' && lease.alive);
}

test('stopped check requires a native once decision, preserves prepared evidence, and never replays after reopening', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const original = structuredClone(fixture.receipt);
  const preview = await fixture.recovery.preview(context.origin, context.id, original.id);
  assert.equal(preview.eligible, true);
  assert.equal(preview.action, 'release-stopped-unverified');
  assert.equal((await aliveAdmissions(context)).length, 1);
  await fixture.recovery.recover(context.origin, context.id, original.id, preview.digest, note, fixture.native.parent());
  const record = (await fixture.handoffs.store.read()).records[0]!;
  assert.deepEqual(record.checks[0], original);
  assert.equal(record.resolutions!.length, 1);
  assert.equal(record.resolutions![0]!.kind, 'stopped-unverified');
  assert.ok(record.resolutions![0]!.proof);
  assert.equal(fixture.native.asks(), 1);
  assert.equal((await aliveAdmissions(context)).length, 0);
  const repeated = await fixture.recovery.recover(context.origin, context.id, original.id, preview.digest, note, fixture.native.parent());
  assert.ok(repeated);
  assert.equal(fixture.native.asks(), 1);
  const reopened = new OperatorHandoffs(context.jobs, context.client, context.writes, {
    preflight: async () => { throw new Error('unexpected_preflight'); },
    run: async () => { throw new Error('unexpected_replay'); },
  });
  const report = await reopened.check(context.origin, context.id, fixture.prepared.artifact.digest, fixture.checkID, context.parent());
  assert.equal(report.status, 'unverified');
  assert.equal(fixture.launches(), 1);
  assert.deepEqual((await reopened.store.read()).records[0]!.checks[0], original);
});

test('restart reconciles a durable completed archive without asking, rerunning, or replacing prepared history', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  await fixture.journal.finish(outcome);
  const reopened = new OperatorHandoffs(context.jobs, context.client, context.writes, {
    preflight: async () => { throw new Error('unexpected_preflight'); },
    run: async () => { throw new Error('unexpected_replay'); },
  });
  const recovery = new OperatorHandoffRecovery(reopened, fixture.native.permissions);
  const preview = await recovery.preview(context.origin, context.id, fixture.receipt.id);
  assert.equal(preview.action, 'reconcile-completed');
  assert.equal(preview.eligible, true);
  await recovery.recover(context.origin, context.id, fixture.receipt.id, preview.digest, 'Reconcile the exact durable host outcome.', fixture.native.parent());
  const report = await reopened.show(context.origin, context.id);
  assert.equal(report.status, 'ready');
  assert.equal(report.checks[0]!.exitCode, 0);
  assert.equal(fixture.native.asks(), 0);
  const record = (await reopened.store.read()).records[0]!;
  assert.deepEqual(record.checks[0], fixture.receipt);
  assert.equal(record.resolutions![0]!.kind, 'completed');
  assert.equal((await aliveAdmissions(context)).length, 0);
});

test('denial and blanket permission cannot release a stopped check or its admission', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  for (const reply of ['reject', 'always']) {
    await assert.rejects(fixture.recovery.recover(context.origin, context.id, fixture.receipt.id,
      preview.digest, note, fixture.native.parent(reply)));
    const record = (await fixture.handoffs.store.read()).records[0]!;
    assert.deepEqual(record.checks[0], fixture.receipt);
    assert.equal(record.resolutions?.length ?? 0, 0);
    assert.equal((await aliveAdmissions(context)).length, 1);
  }
});

test('running, foreign and unreadable execution evidence stay ineligible with no native ask or effects', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  for (const state of ['running', 'foreign', 'unavailable'] as const) {
    const recovery = new OperatorHandoffRecovery(fixture.handoffs, fixture.native.permissions, {
      owner: async () => ({ state, reason: `fixture_${state}` }),
      witness: async () => ({ state, reason: `fixture_${state}` }),
    });
    const preview = await recovery.preview(context.origin, context.id, fixture.receipt.id);
    assert.equal(preview.eligible, false);
    await assert.rejects(recovery.recover(context.origin, context.id, fixture.receipt.id,
      preview.digest, note, fixture.native.parent()));
  }
  assert.equal(fixture.native.asks(), 0);
  assert.equal(fixture.launches(), 1);
  assert.equal((await aliveAdmissions(context)).length, 1);
});

test('completion arriving during human approval invalidates unknown-outcome release and remains reconcilable', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  await assert.rejects(fixture.recovery.recover(context.origin, context.id, fixture.receipt.id,
    preview.digest, note, fixture.native.parent('once', () => fixture.journal.finish(outcome))));
  assert.equal((await fixture.handoffs.store.read()).records[0]!.resolutions?.length ?? 0, 0);
  const completed = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  assert.equal(completed.action, 'reconcile-completed');
  await fixture.recovery.recover(context.origin, context.id, fixture.receipt.id, completed.digest,
    'Reconcile the host completion that arrived while permission was pending.', fixture.native.parent());
  assert.equal((await fixture.handoffs.show(context.origin, context.id)).status, 'ready');
  assert.equal(fixture.native.asks(), 1);
});

test('slow process inspection does not hold jobs or handoff locks, and concurrent job change rejects stale approval', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const entered = deferred<void>();
  const continueInspection = deferred<void>();
  const recovery = new OperatorHandoffRecovery(fixture.handoffs, fixture.native.permissions, {
    owner: async () => ({ state: 'running', reason: 'fixture_owner_running' }),
    witness: async witness => {
      entered.resolve();
      await continueInspection.promise;
      return { state: 'stopped', reason: 'fixture_stopped', proof: { owner: witness.owner,
        launcher: witness.launcher, namespace: witness.namespace, observedAt: new Date().toISOString() } };
    },
  });
  const pending = recovery.preview(context.origin, context.id, fixture.receipt.id);
  await entered.promise;
  try {
    await Promise.race([Promise.all([context.jobs.list(context.origin), fixture.handoffs.store.transaction(async () => {})]),
      delay(1_000).then(() => { throw new Error('inspection_held_ledger_lock'); })]);
    await context.supervisor.intervene(context.origin, context.id, 'pause');
  } finally { continueInspection.resolve(); }
  await assert.rejects(pending, /stale/);
});

test('source drift does not strand a proven-stopped reservation, but recovery cannot make that handoff current', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  await writeFile(join(context.directory, 'a.mjs'), 'export default 999;\n');
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  assert.equal(preview.eligible, true);
  await fixture.recovery.recover(context.origin, context.id, fixture.receipt.id, preview.digest, note, fixture.native.parent());
  const report = await fixture.handoffs.show(context.origin, context.id);
  assert.equal(report.status, 'stale');
  assert.equal(report.current, false);
  assert.equal((await aliveAdmissions(context)).length, 0);
  assert.equal(await readFile(join(context.directory, 'a.mjs'), 'utf8'), 'export default 999;\n');
});

test('foreign parent and wrong preview digest cannot release a claim', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  await assert.rejects(fixture.recovery.preview({ ...context.origin, sessionID: 'ses_foreign' }, context.id, fixture.receipt.id));
  await assert.rejects(fixture.recovery.recover(context.origin, context.id, fixture.receipt.id, '0'.repeat(64), note, fixture.native.parent()));
  assert.equal(fixture.native.asks(), 0);
  assert.equal((await aliveAdmissions(context)).length, 1);
});

test('two stopped uncertain slots expose individual recovery and release capacity for a third distinct check without replay', async () => {
  const contexts = [await handoffFixture(), await handoffFixture(), await handoffFixture()];
  const jobs = new OperatorJobs(contexts[0]!.jobs.home, dirname(contexts[0]!.workspace), 'operator');
  const additional = await Promise.all(contexts.slice(1).map(context => context.jobs.get(context.origin, context.id)));
  await jobs.transaction(async (ledger, save) => {
    ledger.jobs.push(...additional);
    await save();
  });
  const shared = contexts.map(context => ({ ...context, jobs,
    writes: new OperatorWrites(jobs, context.client, context.permissions) }));
  const first = await uncertain(shared[0]!);
  const second = await uncertain(shared[1]!);
  let calls = 0;
  const thirdContext = shared[2]!;
  const third = new OperatorHandoffs(jobs, thirdContext.client, thirdContext.writes, {
    preflight: async () => {}, run: async () => { calls++; return outcome; },
  });
  const prepared = await third.prepare(thirdContext.origin, thirdContext.id, thirdContext.parent());
  await assert.rejects(third.check(thirdContext.origin, thirdContext.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, thirdContext.parent()), /capacity/);
  assert.equal(calls, 0);
  for (const [fixture, context] of [[first, shared[0]!], [second, shared[1]!]] as const) {
    const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
    assert.equal(preview.eligible, true);
  }
  const preview = await first.recovery.preview(shared[0]!.origin, shared[0]!.id, first.receipt.id);
  await first.recovery.recover(shared[0]!.origin, shared[0]!.id, first.receipt.id,
    preview.digest, note, first.native.parent());
  await third.check(thirdContext.origin, thirdContext.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, thirdContext.parent());
  assert.equal(calls, 1);
  assert.equal(first.launches(), 1);
  assert.equal(second.launches(), 1);
  assert.equal((await second.handoffs.show(shared[1]!.origin, shared[1]!.id)).status, 'uncertain');
  assert.equal((await first.handoffs.show(shared[0]!.origin, shared[0]!.id)).status, 'unverified');
});

test('legacy prepared receipts lacking execution identity stay ineligible instead of guessing from a missing worker', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  await fixture.handoffs.store.transaction(async (ledger, save) => {
    delete ledger.records[0]!.executions;
    await save();
  });
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  assert.equal(preview.eligible, false);
  await assert.rejects(fixture.recovery.recover(context.origin, context.id, fixture.receipt.id,
    preview.digest, note, fixture.native.parent()));
  assert.equal(fixture.native.asks(), 0);
  assert.deepEqual((await fixture.handoffs.store.read()).records[0]!.checks[0], fixture.receipt);
});

test('an outcome archived after stopped-unverified resolution cannot silently upgrade or erase that decision', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  await fixture.recovery.recover(context.origin, context.id, fixture.receipt.id, preview.digest, note, fixture.native.parent());
  const before = structuredClone((await fixture.handoffs.store.read()).records[0]!);
  await fixture.journal.finish(outcome);
  const reopened = new OperatorHandoffRecovery(fixture.handoffs, fixture.native.permissions);
  await reopened.recover(context.origin, context.id, fixture.receipt.id, preview.digest, note, fixture.native.parent());
  const after = (await fixture.handoffs.store.read()).records[0]!;
  assert.deepEqual(after.checks, before.checks);
  assert.deepEqual(after.resolutions, before.resolutions);
  assert.equal((await fixture.handoffs.show(context.origin, context.id)).status, 'unverified');
  assert.equal(fixture.native.asks(), 1);
});

test('recovery never deletes a lease whose exact durable binding was replaced', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  const path = join(context.jobs.home, 'deploy', 'leases', `${fixture.execution.admission.id}.json`);
  const foreign = { ...fixture.execution.admission, kind: 'fixture:unrelated-work' };
  await writeFile(path, JSON.stringify(foreign));
  await assert.rejects(fixture.recovery.recover(context.origin, context.id, fixture.receipt.id,
    preview.digest, note, fixture.native.parent()));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), foreign);
  assert.deepEqual((await fixture.handoffs.store.read()).records[0]!.checks[0], fixture.receipt);
});

test('explicit-permit launch with no witness requires proven stopped owner before human release, never assumes missing means safe', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context, false);
  const running = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  assert.equal(running.eligible, false, 'live owner could still launch the recorded work');
  const recovery = new OperatorHandoffRecovery(fixture.handoffs, fixture.native.permissions, {
    owner: async owner => ({ state: 'stopped', reason: 'fixture_owner_stopped',
      proof: { owner, observedAt: new Date().toISOString() } }),
    witness: async () => { throw new Error('unexpected_witness_inspection'); },
  });
  const stopped = await recovery.preview(context.origin, context.id, fixture.receipt.id);
  assert.equal(stopped.eligible, true);
  assert.equal(stopped.action, 'release-stopped-unverified');
  await recovery.recover(context.origin, context.id, fixture.receipt.id, stopped.digest, note, fixture.native.parent());
  assert.equal(fixture.native.asks(), 1);
  assert.equal((await fixture.handoffs.show(context.origin, context.id)).status, 'unverified');
  assert.equal(fixture.launches(), 1);
});

test('late original worker completion retains its archive without replacing an already approved unverified resolution', async () => {
  const context = await handoffFixture();
  const witness = await stoppedWitness();
  const gate = deferred<OperatorCheckRun>();
  const witnessed = deferred<void>();
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes, {
    preflight: async () => {},
    run: async (_command, _source, hooks) => {
      await hooks!.onWitness(witness);
      witnessed.resolve();
      return gate.promise;
    },
  });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  await handoffs.check(context.origin, context.id, prepared.artifact.digest, prepared.artifact.checks[0]!.id, context.parent());
  await witnessed.promise;
  const native = permissionFixture(context);
  const recovery = new OperatorHandoffRecovery(handoffs, native.permissions);
  const record = (await handoffs.store.read()).records[0]!;
  const receipt = record.checks[0]!;
  const binding = record.executions![0]!;
  const journal = new OperatorHandoffExecutionJournal(context.jobs.home, binding);
  try {
    const preview = await recovery.preview(context.origin, context.id, receipt.id);
    assert.equal(preview.eligible, true, 'process stop proof is distinct from a delayed host result callback');
    const resolution = await recovery.recover(context.origin, context.id, receipt.id, preview.digest, note, native.parent());
    const savedResolutions = structuredClone((await handoffs.store.read()).records[0]!.resolutions);
    assert.equal(savedResolutions![0]!.digest, resolution.digest);
    gate.resolve(outcome);
    for (let count = 0; count < 100; count++) {
      if ((await journal.read())?.outcome) break;
      await delay(10);
    }
    assert.deepEqual((await journal.read())?.outcome, outcome);
    await delay(20);
    const after = (await handoffs.store.read()).records[0]!;
    assert.deepEqual(after.checks[0], receipt);
    assert.deepEqual(after.resolutions, savedResolutions);
    assert.equal((await handoffs.show(context.origin, context.id)).status, 'unverified');
    assert.equal((await aliveAdmissions(context)).length, 0);
  } finally { gate.resolve(outcome); }
});

test('a real exited host with a durable explicit-permit journal and no witness is recoverable only by native once approval', async () => {
  const context = await handoffFixture();
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes, {
    preflight: async () => { throw new Error('unexpected_preflight'); },
    run: async () => { throw new Error('unexpected_replay'); },
  });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  const moduleURL = (name: string) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);
  // This disposable host persists the same pre-execution seam, then exits before any untrusted command is started.
  const script = `
    import { randomUUID } from 'node:crypto';
    import { beginAdmission } from ${moduleURL('deployment-admission')};
    import { readOperatorCheckOwner } from ${moduleURL('operator-check-execution')};
    import { OperatorHandoffExecutionJournal, operatorHandoffPreparedDigest } from ${moduleURL('operator-handoff-execution')};
    import { OperatorHandoffStore } from ${moduleURL('operator-handoff-store')};
    const [home, jobID] = process.argv.slice(1);
    const store = new OperatorHandoffStore(home);
    const original = (await store.read()).records.find(record => record.artifact.jobID === jobID);
    const check = original.artifact.checks[0];
    const lease = await beginAdmission(home, 'plugin:operator-handoff');
    const receipt = { id: 'check_' + randomUUID(), checkID: check.id, command: check.command,
      callID: 'handoff_' + lease.id, messageID: 'msg_fixture_crash', artifactDigest: original.artifact.digest,
      status: 'prepared', startedAt: new Date().toISOString() };
    const admission = { id: lease.id, kind: lease.kind, pid: lease.pid, startTime: lease.startTime };
    const binding = { receiptID: receipt.id, token: lease.id, receiptDigest: operatorHandoffPreparedDigest(receipt),
      artifactDigest: receipt.artifactDigest, owner: await readOperatorCheckOwner(), admission };
    await new OperatorHandoffExecutionJournal(home, binding).start();
    await store.transaction(async (ledger, save) => {
      const record = ledger.records.find(record => record.artifact.jobID === jobID);
      if (record.checks.length) throw new Error('fixture_claim_conflict');
      record.checks.push(receipt);
      (record.executions ??= []).push(binding);
      await save();
    });
    process.stdout.write(JSON.stringify({ receiptID: receipt.id }));
  `;
  const child = await promisify(execFile)(process.execPath,
    ['--conditions=onionsoup-source', '--import', 'tsx', '--input-type=module', '-e', script, context.jobs.home, context.id],
    { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 15_000 });
  const receiptID = JSON.parse(child.stdout).receiptID as string;
  const native = permissionFixture(context);
  const recovery = new OperatorHandoffRecovery(handoffs, native.permissions);
  const preview = await recovery.preview(context.origin, context.id, receiptID);
  assert.equal(preview.reason, 'operator_handoff_recovery_never_started');
  assert.equal(preview.eligible, true);
  assert.equal(preview.inspection?.state, 'stopped');
  const prior = structuredClone((await handoffs.store.read()).records[0]!.checks[0]!);
  await recovery.recover(context.origin, context.id, receiptID, preview.digest, note, native.parent());
  assert.equal(native.asks(), 1);
  assert.equal((await handoffs.show(context.origin, context.id)).status, 'unverified');
  assert.deepEqual((await handoffs.store.read()).records[0]!.checks[0], prior);
  assert.equal((await listAdmissions(context.jobs.home)).length, 0);
  const repeated = await handoffs.check(context.origin, context.id, prepared.artifact.digest,
    prepared.artifact.checks[0]!.id, context.parent());
  assert.equal(repeated.status, 'unverified');
});

test('corrupted execution evidence cannot authorize recovery or native approval', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const original = await readFile(fixture.journal.path, 'utf8');
  const corrupted = JSON.parse(original);
  corrupted.witness.namespace.started = `${corrupted.witness.namespace.started}0`;
  await writeFile(fixture.journal.path, JSON.stringify(corrupted));
  await assert.rejects(fixture.recovery.preview(context.origin, context.id, fixture.receipt.id));
  assert.equal(fixture.native.asks(), 0);
  assert.equal((await aliveAdmissions(context)).length, 1);
  assert.deepEqual((await fixture.handoffs.store.read()).records[0]!.checks[0], fixture.receipt);
});

test('durable resolution survives admission cleanup failure and exact retry only completes cleanup', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const preview = await fixture.recovery.preview(context.origin, context.id, fixture.receipt.id);
  const path = join(context.jobs.home, 'deploy', 'leases', `${fixture.execution.admission.id}.json`);
  const foreign = { ...fixture.execution.admission, kind: 'fixture:replacement' };
  const transaction = fixture.handoffs.store.transaction.bind(fixture.handoffs.store);
  let disruptCleanup = true;
  fixture.handoffs.store.transaction = async action => transaction(async (ledger, save) => action(ledger, async () => {
    await save();
    if (disruptCleanup && ledger.records[0]!.resolutions?.length) {
      disruptCleanup = false;
      await writeFile(path, JSON.stringify(foreign));
    }
  }));
  await assert.rejects(fixture.recovery.recover(context.origin, context.id, fixture.receipt.id,
    preview.digest, note, fixture.native.parent()));
  const recorded = structuredClone((await fixture.handoffs.store.read()).records[0]!);
  assert.equal(recorded.resolutions!.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), foreign);
  await writeFile(path, JSON.stringify(fixture.execution.admission));
  await fixture.recovery.recover(context.origin, context.id, fixture.receipt.id, preview.digest, note, fixture.native.parent());
  assert.deepEqual((await fixture.handoffs.store.read()).records[0], recorded);
  assert.equal(fixture.native.asks(), 1);
  assert.equal((await aliveAdmissions(context)).length, 0);
  assert.equal(fixture.launches(), 1);
});

test('execution owner, admission token and original call must share one exact durable identity', async () => {
  const context = await handoffFixture();
  const fixture = await uncertain(context);
  const original = await fixture.handoffs.store.read();
  const mutations: Array<(record: typeof original.records[number]) => void> = [
    record => { record.executions![0]!.owner.pid++; },
    record => { record.executions![0]!.owner.started += '0'; },
    record => { record.executions![0]!.token = '00000000-0000-4000-8000-000000000000'; },
    record => {
      record.checks[0]!.callID = 'handoff_00000000-0000-4000-8000-000000000000';
      record.executions![0]!.receiptDigest = operatorHandoffPreparedDigest(record.checks[0]!);
    },
  ];
  try {
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed.records[0]!);
      await writeFile(fixture.handoffs.store.path, JSON.stringify(changed));
      await assert.rejects(fixture.handoffs.store.read());
      await assert.rejects(fixture.recovery.preview(context.origin, context.id, fixture.receipt.id));
      assert.equal((await aliveAdmissions(context)).length, 1);
    }
  } finally { await writeFile(fixture.handoffs.store.path, JSON.stringify(original)); }
  assert.equal(fixture.native.asks(), 0);
  assert.equal(fixture.launches(), 1);
});

test('a normally completed check with a retained exact admission reconciles cleanup once without changing its receipt or asking', async () => {
  const context = await handoffFixture();
  const gate = deferred<OperatorCheckRun>();
  const entered = deferred<void>();
  let launches = 0;
  const handoffs = new OperatorHandoffs(context.jobs, context.client, context.writes, {
    preflight: async () => {},
    run: async () => {
      launches++;
      entered.resolve();
      return gate.promise;
    },
  });
  const prepared = await handoffs.prepare(context.origin, context.id, context.parent());
  await handoffs.check(context.origin, context.id, prepared.artifact.digest, prepared.artifact.checks[0]!.id, context.parent());
  await entered.promise;
  const pending = (await handoffs.store.read()).records[0]!;
  const binding = pending.executions![0]!;
  const path = join(context.jobs.home, 'deploy', 'leases', `${binding.admission.id}.json`);
  const transaction = handoffs.store.transaction.bind(handoffs.store);
  let disruptCleanup = true;
  handoffs.store.transaction = async action => transaction(async (ledger, save) => action(ledger, async () => {
    await save();
    if (disruptCleanup && ledger.records[0]!.checks[0]!.status === 'completed') {
      disruptCleanup = false;
      await writeFile(path, JSON.stringify({ ...binding.admission, kind: 'fixture:transient-cleanup-mismatch' }));
    }
  }));
  try {
    gate.resolve(outcome);
    for (let count = 0; count < 100; count++) {
      if (!disruptCleanup) break;
      await delay(10);
    }
    assert.equal(disruptCleanup, false);
    await delay(50);
    const completed = structuredClone((await handoffs.store.read()).records[0]!.checks[0]!);
    assert.equal(completed.status, 'completed');
    await writeFile(path, JSON.stringify(binding.admission));
    const native = permissionFixture(context);
    const recovery = new OperatorHandoffRecovery(handoffs, native.permissions);
    const preview = await recovery.preview(context.origin, context.id, completed.id);
    assert.equal(preview.eligible, true);
    assert.equal(preview.action, 'reconcile-completed');
    const cleanupNote = 'Reconcile the exact completed host receipt and release its retained admission.';
    const resolution = await recovery.recover(context.origin, context.id, completed.id, preview.digest, cleanupNote, native.parent());
    assert.equal(resolution.kind, 'completed');
    assert.equal(resolution.prepared.status, 'prepared');
    assert.deepEqual(resolution.completed, completed);
    assert.deepEqual((await handoffs.store.read()).records[0]!.checks[0], completed);
    assert.equal((await aliveAdmissions(context)).length, 0);
    await recovery.recover(context.origin, context.id, completed.id, preview.digest, cleanupNote, native.parent());
    assert.equal(native.asks(), 0);
    assert.equal(launches, 1);
    assert.equal((await handoffs.show(context.origin, context.id)).status, 'ready');
  } finally { gate.resolve(outcome); }
});
