import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { OperatorJobs, operatorJobDigest } from '../src/operator-jobs.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { OperatorChecks } from '../src/operator-check-host.ts';
import { OperatorSupervisor, OPERATOR_SUPERVISOR_LIMITS } from '../src/operator-supervisor.ts';
import { OPERATOR_CHECK_TOOL } from '../src/operator-write-call.ts';
import type { OperatorJob } from '../src/operator-jobs-types.ts';
import { operatorCheckRecordDigest, type OperatorCheckRecord } from '../src/operator-check-types.ts';
import { operatorChildHoldsWorkspace } from '../src/operator-write-state.ts';
import { fixture, start } from './operator-write-host-fixture.ts';

const failingImplementation = 'package arithmetic\n\nfunc Sum(left, right int) int { return left - right }\n';
const fixedImplementation = 'package arithmetic\n\nfunc Sum(left, right int) int { return left + right }\n';
const testSource = `package arithmetic

import "testing"

func TestSum(t *testing.T) {
	if got := Sum(2, 3); got != 5 {
		t.Fatalf("Sum(2, 3) = %d, want 5", got)
	}
}
`;
type GoFixture = Awaited<ReturnType<typeof fixture>> & { id: string };

async function setup(): Promise<GoFixture> {
  const context = await fixture();
  await writeFile(join(context.directory, 'go.mod'), 'module example.invalid/operator-check\n\ngo 1.25.0\n');
  await context.git(['add', 'go.mod']);
  await context.git(['commit', '-qm', 'Go module fixture']);
  context.intake = { messageID: 'msg_go_request', text: 'Add Sum and its Go test, run local package tests, and keep the result uncommitted for review.' };
  context.input.key = 'go-sum';
  context.input.goal = 'Provide a verified Sum implementation in this Go module';
  context.input.tasks = [{ id: 'edit', goal: 'Create Sum and a representative Go test', directory: context.directory,
    access: 'write', files: [], createFiles: ['sum.go', 'sum_test.go'], dependsOn: [],
    checks: [{ id: 'go-unit', command: ['go', 'test', './...'] }] }];
  const job = await start(context);
  return { ...context, id: job.id };
}

async function native(context: GoFixture, kind: 'write' | 'check', sequence: number) {
  const child = (await context.jobs.get(context.origin, context.id)).children[0]!;
  const messageID = `msg_go_${kind}_${sequence}`;
  const callID = `call_go_${kind}_${sequence}`;
  context.client.tool(child.sessionID!, messageID, callID, kind === 'check' ? OPERATOR_CHECK_TOOL : undefined);
  return { child, callID, toolContext: context.childContext(child.sessionID!, messageID) };
}

async function createSources(context: GoFixture) {
  for (const [sequence, path, content] of [[1, 'sum.go', failingImplementation], [2, 'sum_test.go', testSource]] as const) {
    const call = await native(context, 'write', sequence);
    await context.writes.file(call.toolContext, call.callID, { path, expectedBeforeSha256: 'absent', content });
  }
}

async function check(context: GoFixture, sequence: number) {
  const call = await native(context, 'check', sequence);
  return context.writes.check(call.toolContext, call.callID, { checkID: 'go-unit' });
}

function reopen(context: GoFixture): GoFixture {
  const jobs = new OperatorJobs(context.jobs.home, context.jobs.workspace, context.jobs.operator);
  const writes = new OperatorWrites(jobs, context.client, context.permissions);
  const supervisor = new OperatorSupervisor(jobs, context.client, { ...OPERATOR_SUPERVISOR_LIMITS, receiptGraceMs: 0 }, writes);
  return { ...context, jobs, writes, supervisor };
}

async function reuseWithoutToolchain(context: GoFixture) {
  const configured = process.env.ONIONSOUP_HOST_GO_ROOT;
  try {
    process.env.ONIONSOUP_HOST_GO_ROOT = join(context.workspace, 'deliberately-missing-toolchain');
    return await check(context, 3);
  } finally {
    if (configured === undefined) delete process.env.ONIONSOUP_HOST_GO_ROOT;
    else process.env.ONIONSOUP_HOST_GO_ROOT = configured;
  }
}

async function finish(context: GoFixture) {
  const child = (await context.jobs.get(context.origin, context.id)).children[0]!;
  context.client.finish(child.sessionID!);
  const snapshot = context.client.sessions.get(child.sessionID!)!.snapshot;
  snapshot.messages.at(-1)!.text = 'Created Sum and its Go test. The real host Go test failed, the function was corrected, and the current artifact passed. Review the host diff and receipts.';
  await context.supervisor.tick();
  return context.writes.review(context.origin, context.id, child.id);
}

async function acceptAndSynthesize(context: GoFixture, original: OperatorJob,
  failed: OperatorCheckRecord, passed: OperatorCheckRecord) {
  const preview = await finish(context);
  assert.equal(preview.child.status, 'needs-review');
  assert.equal(preview.artifact.digest, passed.artifactDigest);
  assert.match(preview.artifact.diff, /new file mode/);
  assert.match(preview.artifact.diff, /sum_test\.go/);
  assert.equal(operatorChildHoldsWorkspace(preview.child), true);
  const accepted = await context.writes.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent());
  assert.equal(accepted.children[0]!.status, 'completed');
  assert.equal(accepted.status, 'needs-synthesis');
  assert.equal(operatorChildHoldsWorkspace(accepted.children[0]!), false);
  assert.deepEqual(accepted.children[0]!.write!.checks, [failed, passed]);
  assert.deepEqual(accepted.children[0]!.write!.approval, original.children[0]!.write!.approval);
  assert.equal(accepted.children[0]!.write!.acceptance!.proof.reply, 'once');
  assert.deepEqual(accepted.intake, original.intake);
  assert.equal(accepted.goal, original.goal);
  assert.deepEqual(accepted.constraints, original.constraints);
  assert.equal(context.asks.length, 2, 'only original file/check scope and final exact-diff approval ask the human');
  await context.writes.accept(context.origin, context.id, preview.child.id, preview.digest, context.parent());
  assert.equal(context.asks.length, 2);
  const completed = await context.jobs.synthesize(context.origin, context.id, operatorJobDigest(accepted),
    [accepted.children[0]!.evidence!.messageID], 'Sum and its representative Go test are implemented. Current host Go tests passed after a retained earlier failure; the person accepted the exact diff.');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.synthesis!.evidenceIDs, [accepted.children[0]!.evidence!.messageID]);
  assert.deepEqual((await reopen(context).jobs.get(context.origin, context.id)).children[0]!.write!.checks, [failed, passed]);
}

test('real Go failure and fix survive host restart, reuse current evidence, and accept the original goal once', async () => {
  const context = await setup();
  const original = await context.jobs.get(context.origin, context.id);
  const originalHead = (await context.git(['rev-parse', 'HEAD'])).stdout.trim();
  await createSources(context);
  const failed = await check(context, 1);
  assert.equal(failed.status, 'completed');
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.command, ['go', 'test', './...']);
  assert.match(failed.output!, /TestSum/);
  assert.match(failed.output!, /want 5/);
  assert.equal(failed.digest, operatorCheckRecordDigest(failed));
  const edit = await native(context, 'write', 3);
  const before = edit.child.write!.operations.find(operation => operation.mutation.path === 'sum.go')!.receipt!.afterSha256;
  await context.writes.file(edit.toolContext, edit.callID, { path: 'sum.go', expectedBeforeSha256: before, content: fixedImplementation });
  const passed = await check(context, 2);
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.runtime?.kind, 'go');
  assert.match(passed.runtime!.version, /^go[0-9]+\.[0-9]+/);
  assert.match(passed.runtime!.binarySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(failed.runtime, passed.runtime);
  assert.match(passed.output!, /ok\s+example\.invalid\/operator-check/);
  assert.notEqual(passed.artifactDigest, failed.artifactDigest);
  assert.equal(passed.digest, operatorCheckRecordDigest(passed));
  assert.equal(context.asks.length, 1, 'the failed check and scoped correction require no additional grant or scope prompt');
  const restarted = reopen(context);
  assert.deepEqual(await reuseWithoutToolchain(restarted), passed, 'a new native call reuses the receipt even when a fresh Go execution cannot preflight');
  const replayed = await restarted.jobs.get(restarted.origin, restarted.id);
  assert.deepEqual(replayed.children[0]!.write!.checks, [failed, passed], 'restart records no extra execution intent or replacement receipt');
  assert.equal(restarted.asks.length, 1);
  await acceptAndSynthesize(restarted, original, failed, passed);
  assert.equal((await context.git(['rev-parse', 'HEAD'])).stdout.trim(), originalHead, 'no commit, push or module edit is inferred from acceptance');
  assert.equal(await readFile(join(context.directory, 'README.md'), 'utf8'), '# Original\n');
  assert.equal(await readFile(join(context.directory, 'sum.go'), 'utf8'), fixedImplementation);
});

test('prepared Go intent remains uncertain after host restart and never replays', async () => {
  const context = await setup();
  await createSources(context);
  const transaction = context.jobs.transaction.bind(context.jobs);
  context.jobs.transaction = action => transaction(async (ledger, save) => action(ledger, async () => {
    await save();
    if (ledger.jobs.some(job => job.children.some(child => child.write?.checks?.some(record => record.status === 'prepared')))) {
      throw new Error('fixture_go_crash_after_durable_intent');
    }
  }));
  await assert.rejects(check(context, 1), /fixture_go_crash_after_durable_intent/);
  const restarted = reopen(context);
  const before = (await restarted.jobs.get(restarted.origin, restarted.id)).children[0]!;
  assert.equal(before.write!.checks!.length, 1);
  assert.deepEqual(before.write!.checks![0]!.command, ['go', 'test', './...']);
  assert.equal(before.write!.checks![0]!.status, 'prepared');
  await assert.rejects(check(restarted, 2), /operator_check_effect_uncertain/);
  const after = (await restarted.jobs.get(restarted.origin, restarted.id)).children[0]!;
  assert.deepEqual(after.write!.checks, before.write!.checks);
  assert.equal(after.write!.checks![0]!.exitCode, undefined);
  assert.equal(operatorChildHoldsWorkspace(after), true);
  assert.equal(restarted.asks.length, 1);
  assert.throws(() => OperatorChecks.assertEvidence(after, { status: 'idle', messages: [] }), /operator_check_effect_uncertain/);
  assert.equal(await readFile(join(restarted.directory, 'sum.go'), 'utf8'), failingImplementation);
});
