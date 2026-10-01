import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { OperatorJobs } from '../src/operator-jobs.ts';
import { OperatorChecks } from '../src/operator-check-host.ts';
import { OPERATOR_CHECK_RUNNER_LIMITS } from '../src/operator-check-runner.ts';
import { OPERATOR_CHECK_TOOL } from '../src/operator-write-call.ts';
import { operatorChildHoldsWorkspace } from '../src/operator-write-state.ts';
import { prepareOperatorRecovery, operatorRecoveryDigest } from '../src/operator-job-recovery.ts';
import { fixture, start } from './operator-write-host-fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const testContent = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>assert.equal(sum(2,3),5));\n";

async function setup() {
  const context = await fixture();
  context.input.tasks[0]!.createFiles = ['sum.mjs', 'sum.test.mjs'];
  context.input.tasks[0]!.checks = [{ id: 'unit', command: ['node', '--test', 'sum.test.mjs'] }];
  const job = await start(context);
  return { ...context, id: job.id };
}

async function native(context: Fixture & { id: string }, kind: 'write' | 'check', sequence: number) {
  const child = (await context.jobs.get(context.origin, context.id)).children[0]!;
  const messageID = `msg_native_${kind}_${sequence}`;
  const callID = `call_${kind}_${sequence}`;
  context.client.tool(child.sessionID!, messageID, callID, kind === 'check' ? OPERATOR_CHECK_TOOL : undefined);
  return { child, callID, toolContext: context.childContext(child.sessionID!, messageID) };
}

async function createSources(context: Fixture & { id: string }, implementation = 'export const sum=(a,b)=>a+b;\n') {
  for (const [sequence, path, content] of [[1, 'sum.mjs', implementation], [2, 'sum.test.mjs', testContent]] as const) {
    const call = await native(context, 'write', sequence);
    await context.writes.file(call.toolContext, call.callID, { path, expectedBeforeSha256: 'absent', content });
  }
}

async function check(context: Fixture & { id: string }, sequence: number) {
  const call = await native(context, 'check', sequence);
  return context.writes.check(call.toolContext, call.callID, { checkID: 'unit' });
}

async function finish(context: Fixture & { id: string }) {
  const child = (await context.jobs.get(context.origin, context.id)).children[0]!;
  context.client.finish(child.sessionID!);
  await context.supervisor.tick();
  return context.writes.review(context.origin, context.id, child.id);
}

test('approved new files and real isolated test evidence survive restart and accept once without another scope prompt', async () => {
  const context = await setup();
  await createSources(context);
  const evidence = await check(context, 1);
  assert.equal(evidence.exitCode, 0);
  assert.match(evidence.output!, /sum/);
  assert.equal(context.asks.length, 1);
  const restarted = new OperatorWrites(new OperatorJobs(context.jobs.home, context.jobs.workspace, context.jobs.operator), context.client, context.permissions);
  const repeated = await native(context, 'check', 2);
  assert.deepEqual(await restarted.check(repeated.toolContext, repeated.callID, { checkID: 'unit' }), evidence);
  assert.equal((await context.jobs.get(context.origin, context.id)).children[0]!.write!.checks!.length, 1);
  const preview = await finish(context);
  assert.match(preview.artifact.diff, /new file mode/);
  assert.match(preview.artifact.diff, /sum.test.mjs/);
  const accepted = await restarted.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent());
  assert.equal(accepted.children[0]!.status, 'completed');
  assert.equal(operatorChildHoldsWorkspace(accepted.children[0]!), false);
  assert.equal(context.asks.length, 2, 'one original scope decision and one final diff decision');
  await restarted.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent());
  assert.equal(context.asks.length, 2);
  assert.deepEqual(accepted.intake, preview.job.intake);
  assert.equal((await context.git(['status', '--porcelain'])).stdout.includes('?? sum.mjs'), true);
});

test('failed checks are review-visible but never produce an acceptance prompt or release the workspace', async () => {
  const context = await setup();
  await createSources(context, 'export const sum=(a,b)=>a-b;\n');
  const evidence = await check(context, 1);
  assert.notEqual(evidence.exitCode, 0);
  const preview = await finish(context);
  assert.equal(preview.child.write!.checks![0]!.id, evidence.id);
  await assert.rejects(context.writes.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent()), /operator_write_check/);
  assert.equal(context.asks.length, 1);
  assert.equal(operatorChildHoldsWorkspace(preview.child), true);
});

test('later edits invalidate check acceptance and an unapproved check cannot execute', async () => {
  const context = await setup();
  await createSources(context);
  await check(context, 1);
  const call = await native(context, 'write', 3);
  const before = call.child.write!.baseline.files.find(file => file.path === 'README.md')!.sha256;
  await context.writes.file(call.toolContext, call.callID, { path: 'README.md', expectedBeforeSha256: before, content: '# Changed after checks\n' });
  const refused = await native(context, 'check', 2);
  await assert.rejects(context.writes.check(refused.toolContext, refused.callID, { checkID: 'invented' }), /operator_check_not_approved/);
  const preview = await finish(context);
  await assert.rejects(context.writes.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent()), /operator_write_check/);
  assert.equal(context.asks.length, 1);
});

test('crash after durable check intent is never replayed or inferred successful after restart', async () => {
  const context = await setup();
  await createSources(context);
  const transact = context.jobs.transaction.bind(context.jobs);
  context.jobs.transaction = action => transact(async (ledger, save) => action(ledger, async () => {
    await save();
    if (ledger.jobs.some(job => job.children.some(child => child.write?.checks?.some(record => record.status === 'prepared')))) {
      throw new Error('fixture_crash_after_real_check_intent');
    }
  }));
  await assert.rejects(check(context, 1), /fixture_crash_after_real_check_intent/);
  const restarted = new OperatorWrites(new OperatorJobs(context.jobs.home, context.jobs.workspace, context.jobs.operator), context.client, context.permissions);
  const retry = await native(context, 'check', 2);
  await assert.rejects(restarted.check(retry.toolContext, retry.callID, { checkID: 'unit' }), /operator_check_effect_uncertain/);
  const child = (await context.jobs.get(context.origin, context.id)).children[0]!;
  assert.equal(child.write!.checks!.length, 1);
  assert.equal(child.write!.checks![0]!.status, 'prepared');
  assert.equal(operatorChildHoldsWorkspace(child), true);
  assert.equal(await readFile(join(context.directory, 'sum.mjs'), 'utf8'), 'export const sum=(a,b)=>a+b;\n');
  assert.throws(() => OperatorChecks.assertEvidence(child, { status: 'idle', messages: [] }), /operator_check_effect_uncertain/);
});

test('recovery preview exposes new paths and commands and binds their exact scope', async () => {
  const context = await setup();
  const job = await context.jobs.get(context.origin, context.id);
  const child = structuredClone(job.children[0]!);
  const preview = await prepareOperatorRecovery(context.jobs, context.client, context.origin, job.id, child.id);
  assert.match(preview.warning, /new files.*sum.mjs/);
  assert.match(preview.warning, /checks.*node.*--test.*sum.test.mjs/);
  const digest = operatorRecoveryDigest(job, child);
  child.createFiles = ['different.mjs'];
  assert.notEqual(operatorRecoveryDigest(job, child), digest);
  child.createFiles = job.children[0]!.createFiles;
  const beforeCommand = operatorRecoveryDigest(job, child);
  child.checks = [{ id: 'unit', command: ['node', '--test', 'different.test.mjs'] }];
  assert.notEqual(operatorRecoveryDigest(job, child), beforeCommand);
});

test('a proved-stopped timeout records failure and permits an explicit bounded retry on corrected source', async () => {
  const context = await setup();
  await createSources(context);
  const edit = await native(context, 'write', 3);
  const before = edit.child.write!.operations.find(operation => operation.mutation.path === 'sum.test.mjs')!.receipt!.afterSha256;
  const hanging = "import {test} from 'node:test'; test('wait',async()=>await new Promise(resolve=>setTimeout(resolve,5000)));\n";
  const receipt = await context.writes.file(edit.toolContext, edit.callID,
    { path: 'sum.test.mjs', expectedBeforeSha256: before, content: hanging });
  const originalLimit = OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs;
  try {
    OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = 500;
    const failed = await check(context, 1);
    assert.equal(failed.status, 'completed');
    assert.equal(failed.exitCode, 124);
    assert.match(failed.output!, /operator_check_timeout/);
  } finally { OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = originalLimit; }
  const changed = await native(context, 'write', 4);
  await context.writes.file(changed.toolContext, changed.callID,
    { path: 'sum.test.mjs', expectedBeforeSha256: receipt.afterSha256, content: testContent });
  assert.equal((await check(context, 2)).exitCode, 0);
  const preview = await finish(context);
  assert.equal(preview.child.write!.checks!.length, 2, 'original failed check remains in durable history');
  assert.equal(preview.child.write!.checks![0]!.exitCode, 124);
  assert.equal(operatorChildHoldsWorkspace(preview.child), true, 'successful retry still needs exact diff acceptance');
  const accepted = await context.writes.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent());
  assert.equal(accepted.children[0]!.status, 'completed');
});
