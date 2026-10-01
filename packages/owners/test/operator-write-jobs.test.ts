import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { OperatorJobs, operatorJobDigest, operatorWriteScopeDigest, operatorWriteReviewDigest } from '../src/operator-jobs.ts';
import { prepareOperatorRecovery } from '../src/operator-job-recovery.ts';
import { OperatorSupervisor, OPERATOR_SUPERVISOR_LIMITS } from '../src/operator-supervisor.ts';
import { operatorWriteArtifact, snapshotOperatorWriteWorkspace, operatorWriteSha256,
  type OperatorWriteSnapshot, type OperatorWriteReceipt } from '../src/operator-write-workspace.ts';
import { operatorChildHoldsWorkspace } from '../src/operator-write-state.ts';
import { OperatorJobInput as OperatorJobInputSchema, OperatorJobLedger } from '../src/operator-jobs-types.ts';
import { OperatorCheckCommand, OperatorCheckRecord, operatorCheckRecordDigest } from '../src/operator-check-types.ts';
import type { OperatorJobInput, OperatorPermissionProof, OperatorSessionSnapshot, OperatorSupervisorClient } from '../src/operator-jobs-types.ts';

const execute = promisify(execFile);
class WriteSessions implements OperatorSupervisorClient {
  sessions = new Map<string, { title: string; directory: string; snapshot: OperatorSessionSnapshot }>();
  prompts: string[] = [];
  async listSessions(directory: string) {
    return [...this.sessions].filter(([, session]) => session.directory === directory).map(([id, session]) => ({ id, title: session.title }));
  }
  async createSession(directory: string, title: string) {
    const id = `ses_write_${this.sessions.size}`;
    this.sessions.set(id, { directory, title, snapshot: { status: 'idle', messages: [] } });
    return { id };
  }
  async readSession(_directory: string, sessionID: string) { return structuredClone(this.sessions.get(sessionID)!.snapshot); }
  async prompt(_directory: string, sessionID: string, messageID: string, text: string) {
    this.prompts.push(text);
    this.sessions.get(sessionID)!.snapshot = { status: 'busy', messages: [{ id: messageID, role: 'user', text, tools: [] }] };
  }
  async abort() { throw new Error('unexpected_abort'); }
  finish(sessionID: string) {
    const snapshot = this.sessions.get(sessionID)!.snapshot;
    snapshot.messages.push({ id: `msg_final_${sessionID}`, role: 'assistant', parentID: snapshot.messages[0]!.id,
      completed: true, text: 'I changed the named file; inspect the host diff before accepting.', tools: [] });
    snapshot.status = 'idle';
  }
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-write-jobs-'));
  const directory = join(workspace, 'repo');
  await mkdir(directory);
  await execute('/usr/bin/git', ['init', '-q', directory]);
  await writeFile(join(directory, 'README.md'), '# Before\n');
  await writeFile(join(directory, 'check.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('title', () => assert.match(readFileSync(new URL('./README.md', import.meta.url), 'utf8'), /After/));\n");
  await execute('/usr/bin/git', ['-C', directory, 'add', 'README.md', 'check.test.mjs']);
  await execute('/usr/bin/git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const jobs = new OperatorJobs(join(workspace, 'state'), workspace, 'operator');
  const origin = { operator: 'operator', sessionID: 'ses_parent', directory: workspace };
  const intake = { messageID: 'msg_human', text: 'Update the title in README.md in this worktree. Keep other files unchanged.' };
  const input: OperatorJobInput = { key: 'scoped-edit', goal: 'Change the README title', constraints: ['Only README.md; no commit or push'],
    tasks: [{ id: 'edit', goal: 'Change the title', directory, access: 'write', files: ['README.md'], dependsOn: [] }] };
  const sessions = new WriteSessions();
  const supervisor = new OperatorSupervisor(jobs, sessions, { ...OPERATOR_SUPERVISOR_LIMITS, receiptGraceMs: 0 }, {
    inspect: async (_job, child) => {
      if (child.write!.operations.some(operation => operation.status === 'prepared')) throw new Error('operator_write_effect_uncertain');
      return operatorWriteArtifact(child.write!.baseline, child.write!.operations.flatMap(operation => operation.receipt ? [operation.receipt] : []));
    },
  });
  const proof = (): OperatorPermissionProof => ({ permissionID: `permission_${randomUUID()}`, sessionID: origin.sessionID,
    messageID: 'msg_native_approval', reply: 'once', callID: `call_${randomUUID()}`, nonce: randomUUID() });
  async function approved(value = input) {
    const prepared = await jobs.prepare(origin, intake, value);
    const baselines: Record<string, OperatorWriteSnapshot> = {};
    for (const task of prepared.input.tasks.filter(task => task.access === 'write')) {
      baselines[task.id] = await snapshotOperatorWriteWorkspace({ workspace, directory: task.directory, files: task.files ?? [], ...(task.createFiles ? { createFiles: task.createFiles } : {}) });
    }
    const approval = { scopeDigest: operatorWriteScopeDigest(prepared.origin, prepared.intake, prepared.input, baselines), proof: proof(), baselines };
    return { prepared, approval };
  }
  return { workspace, directory, jobs, origin, intake, input, sessions, supervisor, proof, approved };
}

async function recordFixtureEdit(f: Awaited<ReturnType<typeof fixture>>, jobID: string) {
  const job = await f.jobs.get(f.origin, jobID);
  const child = job.children[0]!;
  const baseline = child.write!.baseline;
  const beforeSha256 = baseline.files.find(file => file.path === 'README.md')!.sha256;
  const content = '# After\n';
  const mutation = { id: 'mutation_fixture', path: 'README.md', beforeSha256,
    afterSha256: operatorWriteSha256(content), content, snapshotDigest: baseline.digest };
  const body = { mutationID: mutation.id, path: mutation.path, beforeSha256, afterSha256: mutation.afterSha256, snapshotDigest: baseline.digest };
  const receipt: OperatorWriteReceipt = { ...body, digest: operatorWriteSha256(JSON.stringify(body)) };
  await f.jobs.transaction(async (ledger, save) => {
    const current = f.jobs.bound(ledger, f.origin, jobID).children[0]!;
    current.write!.operations.push({ callID: 'call_write_fixture', messageID: child.attempts[0]!.messageID,
      mutation, status: 'prepared', preparedAt: new Date().toISOString() });
    await save();
  });
  await writeFile(join(f.directory, 'README.md'), content);
  await f.jobs.transaction(async (ledger, save) => {
    const operation = f.jobs.bound(ledger, f.origin, jobID).children[0]!.write!.operations[0]!;
    operation.status = 'applied';
    operation.receipt = receipt;
    operation.resolvedAt = new Date().toISOString();
    await save();
  });
}

test('write creation requires exact once approval bound to original intake, files and host baseline', async () => {
  const f = await fixture();
  await assert.rejects(f.jobs.create(f.origin, f.intake, f.input), /write_approval_required/);
  const { prepared, approval } = await f.approved();
  await assert.rejects(f.jobs.createApproved(f.origin, f.intake, { ...prepared.input, goal: 'Expanded goal' }, approval), /approval_mismatch/);
  await assert.rejects(f.jobs.createApproved(f.origin, { ...f.intake, text: 'Different request' }, prepared.input, approval), /approval_mismatch/);
  await assert.rejects(f.jobs.createApproved(f.origin, f.intake, prepared.input, { ...approval, proof: { ...approval.proof, sessionID: 'ses_other' } }), /approval_mismatch/);
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  assert.deepEqual(job.intake, f.intake);
  assert.equal(job.scope, 'scoped-write');
  assert.equal(job.children[0]!.write!.baseline.head, approval.baselines.edit!.head);
  assert.deepEqual(await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval), job);
});

test('write claims exclude overlapping readers and writers atomically, including conflicts within one job', async () => {
  const f = await fixture();
  const { prepared, approval } = await f.approved();
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  const read: OperatorJobInput = { ...f.input, key: 'reader', tasks: [{ id: 'read', goal: 'Read workspace', access: 'read-only', directory: f.workspace, dependsOn: [] }] };
  await assert.rejects(f.jobs.create(f.origin, f.intake, read), /workspace_conflict/);
  const another = await f.approved({ ...f.input, key: 'another-write' });
  await assert.rejects(f.jobs.createApproved(f.origin, f.intake, another.prepared.input, another.approval), /workspace_conflict/);
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'cancel'), /write_review_required/);
  await f.jobs.transaction(async (ledger, save) => {
    ledger.jobs[0]!.children[0]!.status = 'abandoned';
    ledger.jobs[0]!.status = 'cancelled';
    await save();
  });
  await assert.rejects(f.jobs.create(f.origin, f.intake, read), /workspace_conflict/, 'even a terminal record cannot release an unreviewed write workspace');
  const isolated = await fixture();
  const shared = { ...isolated.input, tasks: [...isolated.input.tasks, { ...isolated.input.tasks[0]!, id: 'second', dependsOn: ['edit'] }] };
  const sharedApproval = await isolated.approved(shared);
  await assert.rejects(isolated.jobs.createApproved(isolated.origin, isolated.intake, sharedApproval.prepared.input, sharedApproval.approval), /workspace_conflict/);
});

test('existing independent git worktrees can hold parallel write reservations', async () => {
  const f = await fixture();
  const second = join(f.workspace, 'other-worktree');
  await execute('/usr/bin/git', ['-C', f.directory, 'worktree', 'add', '-qb', 'fixture-other', second]);
  const input = { ...f.input, tasks: [...f.input.tasks, { ...f.input.tasks[0]!, id: 'other', directory: second }] };
  const { prepared, approval } = await f.approved(input);
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  await f.supervisor.tick();
  const current = await f.jobs.get(f.origin, job.id);
  assert(current.children.every(child => child.status === 'running'));
  assert.equal(f.sessions.prompts.length, 2);
  assert(f.sessions.prompts.every(prompt => prompt.includes('onionsoup_operator_write_file')));
});

test('exact host diff and human acceptance gate write completion and workspace release', async () => {
  const f = await fixture();
  const { prepared, approval } = await f.approved();
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  await f.supervisor.tick();
  await recordFixtureEdit(f, job.id);
  const running = await f.jobs.get(f.origin, job.id);
  f.sessions.finish(running.children[0]!.sessionID!);
  await f.supervisor.tick();
  const review = await f.jobs.get(f.origin, job.id);
  const child = review.children[0]!;
  assert.equal(child.status, 'needs-review');
  assert.equal(review.status, 'needs-review');
  assert.match(child.write!.artifact!.diff, /\+# After/);
  assert.equal(operatorChildHoldsWorkspace(child), true);
  await assert.rejects(f.jobs.synthesize(f.origin, job.id, operatorJobDigest(review), [child.evidence!.messageID], 'Done'), /synthesis_stale/);
  const digest = operatorWriteReviewDigest(review, child);
  const snapshot = await f.sessions.readSession(child.directory, child.sessionID!);
  await assert.rejects(f.jobs.acceptWrite(f.origin, job.id, child.id, 'stale', child.write!.artifact!, f.proof(), snapshot), /review_stale/);
  await assert.rejects(f.jobs.acceptWrite(f.origin, job.id, child.id, digest, child.write!.artifact!, f.proof(), { ...snapshot, status: 'busy' }), /runtime_not_settled/);
  const changedTranscript = structuredClone(snapshot);
  changedTranscript.messages.at(-1)!.text = 'Changed after the evidence snapshot.';
  await assert.rejects(f.jobs.acceptWrite(f.origin, job.id, child.id, digest, child.write!.artifact!, f.proof(), changedTranscript), /runtime_evidence_mismatch/);
  const accepted = await f.jobs.acceptWrite(f.origin, job.id, child.id, digest, child.write!.artifact!, f.proof(), snapshot);
  assert.equal(accepted.status, 'needs-synthesis');
  assert.equal(operatorChildHoldsWorkspace(accepted.children[0]!), false);
  assert.equal(accepted.children[0]!.write!.baseline.digest, approval.baselines.edit!.digest);
  const replay = await f.jobs.acceptWrite(f.origin, job.id, child.id, digest, child.write!.artifact!, f.proof(), snapshot);
  assert.equal(replay.events.filter(event => event.kind === 'write-accepted').length, 1);
  await f.jobs.create(f.origin, f.intake, { key: 'reader-after-acceptance', goal: 'Inspect accepted file', constraints: [],
    tasks: [{ id: 'read', goal: 'Read the change', directory: f.directory, access: 'read-only', dependsOn: [] }] });
});

test('unresolved write intent blocks completion without replay and preserves workspace ownership', async () => {
  const f = await fixture();
  const { prepared, approval } = await f.approved();
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  await f.supervisor.tick();
  await recordFixtureEdit(f, job.id);
  await f.jobs.transaction(async (ledger, save) => {
    const operation = ledger.jobs[0]!.children[0]!.write!.operations[0]!;
    operation.status = 'prepared';
    delete operation.receipt;
    delete operation.resolvedAt;
    await save();
  });
  const running = await f.jobs.get(f.origin, job.id);
  f.sessions.finish(running.children[0]!.sessionID!);
  await f.supervisor.tick();
  const blocked = await f.jobs.get(f.origin, job.id);
  assert.equal(blocked.children[0]!.blocker, 'operator_write_effect_uncertain');
  assert.equal(operatorChildHoldsWorkspace(blocked.children[0]!), true);
  assert.equal(blocked.children[0]!.write!.operations[0]!.status, 'prepared');
  assert.equal(blocked.children[0]!.write!.acceptance, undefined);
  assert.equal(f.sessions.prompts.length, 1);
});

test('an existing reader prevents a writer from claiming its overlapping workspace', async () => {
  const f = await fixture();
  await f.jobs.create(f.origin, f.intake, { key: 'existing-reader', goal: 'Inspect files', constraints: [],
    tasks: [{ id: 'read', goal: 'Inspect workspace', directory: f.workspace, access: 'read-only', dependsOn: [] }] });
  const { prepared, approval } = await f.approved();
  await assert.rejects(f.jobs.createApproved(f.origin, f.intake, prepared.input, approval), /workspace_conflict/);
  assert.equal((await f.jobs.list(f.origin)).length, 1);
});

test('concurrent independently approved writers cannot both claim one existing worktree', async () => {
  const f = await fixture();
  const first = await f.approved();
  const second = await f.approved({ ...f.input, key: 'second-approved-job' });
  const outcomes = await Promise.allSettled([first, second].map(({ prepared, approval }) =>
    f.jobs.createApproved(f.origin, f.intake, prepared.input, approval)));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  assert(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /workspace_conflict/);
  assert.equal((await f.jobs.snapshot()).length, 1);
});


test('check scope accepts only exact bounded Node test commands and write-only unique IDs', async () => {
  const f = await fixture();
  for (const command of [['node', '--test'], ['bash', '-c', 'node --test'], ['node', '--test', '--watch'],
    ['node', '--test', '../test.mjs'], ['node', '--test', '/tmp/test.mjs'], ['node', '--test', '*.test.mjs'],
    ['node', '--test', 'tests/[a].mjs'], ['node', '--test', '+(a|b).mjs'],
    ['node', '--test', 'test\n.mjs'], ['node', '--test', '.git/test.mjs']]) {
    assert.equal(OperatorCheckCommand.safeParse(command).success, false, JSON.stringify(command));
  }
  assert.deepEqual(OperatorCheckCommand.parse(['node', '--test', 'check.test.mjs']), ['node', '--test', 'check.test.mjs']);
  const checks = [{ id: 'unit', command: ['node', '--test', 'check.test.mjs'] }];
  assert.equal(OperatorJobInputSchema.safeParse({ ...f.input, tasks: [{ ...f.input.tasks[0], checks: [...checks, ...checks] }] }).success, false);
  assert.equal(OperatorJobInputSchema.safeParse({ ...f.input, tasks: [{ ...f.input.tasks[0], access: 'read-only', checks }] }).success, false);
  const unknown = { ...f.input, tasks: [{ ...f.input.tasks[0]!, checks: [{ id: 'unit', command: ['node', '--test', 'unapproved.test.mjs'] }] }] };
  const proposed = await f.approved(unknown);
  await assert.rejects(f.jobs.createApproved(f.origin, f.intake, proposed.prepared.input, proposed.approval), /check_path_outside_scope/);
});

test('legacy no-check records retain exact serialized shape and review digest', async () => {
  const f = await fixture();
  const { prepared, approval } = await f.approved();
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  const child = job.children[0]!;
  const legacy = createHash('sha256').update(JSON.stringify({ id: job.id, origin: job.origin, intake: job.intake,
    goal: job.goal, constraints: job.constraints, child: { id: child.id, goal: child.goal, directory: child.directory,
      files: child.files, access: child.access, evidence: child.evidence, attempts: child.attempts,
      baseline: child.write!.baseline, approval: child.write!.approval, operations: child.write!.operations,
      artifact: child.write!.artifact } })).digest('hex');
  assert.equal(operatorWriteReviewDigest(job, child), legacy);
  assert.deepEqual(OperatorJobLedger.parse({ version: 1, jobs: [job] }), { version: 1, jobs: [job] });
  assert.equal(Object.hasOwn(child, 'createFiles'), false);
  assert.equal(Object.hasOwn(child, 'checks'), false);
  assert.equal(Object.hasOwn(child.write!, 'checks'), false);
});

async function checkFixture() {
  const f = await fixture();
  const checks = [{ id: 'unit', command: ['node', '--test', 'check.test.mjs'] }];
  const input = { ...f.input, tasks: [{ ...f.input.tasks[0]!, checks }] };
  const { prepared, approval } = await f.approved(input);
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  await f.supervisor.tick();
  await recordFixtureEdit(f, job.id);
  const running = await f.jobs.get(f.origin, job.id);
  const child = running.children[0]!;
  const artifact = await operatorWriteArtifact(child.write!.baseline, child.write!.operations.flatMap(operation => operation.receipt ? [operation.receipt] : []));
  const record = (updates: Partial<OperatorCheckRecord> = {}): OperatorCheckRecord => {
    const receipt: OperatorCheckRecord = { id: `check_${randomUUID()}`, checkID: 'unit', command: checks[0]!.command,
      callID: 'call_check', messageID: 'msg_tool_check', artifactDigest: artifact.digest,
      status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), exitCode: 0,
      output: '1 test passed', ...updates };
    return { ...receipt, digest: operatorCheckRecordDigest(receipt) };
  };
  const saveChecks = (records: OperatorCheckRecord[]) => f.jobs.transaction(async (ledger, save) => {
    f.jobs.bound(ledger, f.origin, job.id).children[0]!.write!.checks = records;
    await save();
  });
  async function finish() {
    f.sessions.finish(child.sessionID!);
    await f.supervisor.tick();
    return f.jobs.get(f.origin, job.id);
  }
  async function accept() {
    const current = await f.jobs.get(f.origin, job.id);
    const target = current.children[0]!;
    return f.jobs.acceptWrite(f.origin, job.id, target.id, operatorWriteReviewDigest(current, target), target.write!.artifact!,
      f.proof(), await f.sessions.readSession(target.directory, target.sessionID!));
  }
  return { ...f, input, job, artifact, record, saveChecks, finish, accept };
}

test('configured successful current-artifact host receipts gate acceptance and remain immutable after duplicate acceptance', async () => {
  const f = await checkFixture();
  const receipt = f.record();
  await f.saveChecks([receipt]);
  const review = await f.finish();
  assert.equal(review.children[0]!.status, 'needs-review');
  assert.deepEqual(review.children[0]!.checks, f.input.tasks[0]!.checks);
  const digest = operatorWriteReviewDigest(review, review.children[0]!);
  const accepted = await f.accept();
  assert.equal(accepted.children[0]!.status, 'completed');
  assert.deepEqual(accepted.children[0]!.write!.checks, [receipt]);
  assert.equal(operatorChildHoldsWorkspace(accepted.children[0]!), false);
  const child = accepted.children[0]!;
  await f.jobs.acceptWrite(f.origin, f.job.id, child.id, digest, child.write!.artifact!, f.proof(),
    await f.sessions.readSession(child.directory, child.sessionID!));
  assert.equal((await f.jobs.get(f.origin, f.job.id)).events.filter(event => event.kind === 'write-accepted').length, 1);
});

test('failed, missing, stale, mismatched and corrupt check receipts remain visible but cannot accept the artifact', async () => {
  const cases = {
    missing: (f: Awaited<ReturnType<typeof checkFixture>>) => [],
    failed: (f: Awaited<ReturnType<typeof checkFixture>>) => [f.record({ exitCode: 1, output: 'Assertion failed' })],
    stale: (f: Awaited<ReturnType<typeof checkFixture>>) => [f.record({ artifactDigest: '0'.repeat(64) })],
    command: (f: Awaited<ReturnType<typeof checkFixture>>) => [f.record({ command: ['node', '--test', 'other.test.mjs'] })],
    corrupt: (f: Awaited<ReturnType<typeof checkFixture>>) => [{ ...f.record(), output: 'Altered output after receipt' }],
    newestFailed: (f: Awaited<ReturnType<typeof checkFixture>>) => [f.record(), f.record({ exitCode: 1 })],
  };
  for (const [name, records] of Object.entries(cases)) {
    const f = await checkFixture();
    const checks = records(f);
    await f.saveChecks(checks);
    const review = await f.finish();
    assert.equal(review.children[0]!.status, 'needs-review', name);
    assert.deepEqual(review.children[0]!.write!.checks, checks);
    await assert.rejects(f.accept(), /operator_write_check_/, name);
    assert.equal(operatorChildHoldsWorkspace((await f.jobs.get(f.origin, f.job.id)).children[0]!), true);
  }
});

test('prepared check intent never becomes complete or replays and blocks resume and zero-effect release', async () => {
  const f = await checkFixture();
  const check = f.record({ status: 'prepared' });
  delete check.completedAt;
  delete check.exitCode;
  delete check.output;
  delete check.digest;
  await f.saveChecks([check]);
  const blocked = await f.finish();
  assert.equal(blocked.children[0]!.status, 'blocked');
  assert.equal(blocked.children[0]!.blocker, 'operator_write_check_uncertain');
  assert.equal(f.sessions.prompts.length, 1);
  assert.equal(operatorChildHoldsWorkspace(blocked.children[0]!), true);
  assert.equal(blocked.children[0]!.write!.checks![0]!.status, 'prepared');
});

test('changing a successful check receipt invalidates a pending human review digest', async () => {
  const f = await checkFixture();
  await f.saveChecks([f.record()]);
  const review = await f.finish();
  const child = review.children[0]!;
  const oldDigest = operatorWriteReviewDigest(review, child);
  await f.saveChecks([f.record({ exitCode: 1 })]);
  await assert.rejects(f.jobs.acceptWrite(f.origin, f.job.id, child.id, oldDigest, child.write!.artifact!, f.proof(),
    await f.sessions.readSession(child.directory, child.sessionID!)), /review_stale/);
});


test('create-only tasks bind exact absent paths and check scope without manufacturing legacy defaults', async () => {
  for (const files of [undefined, []]) {
    const f = await fixture();
    const input: OperatorJobInput = { ...f.input, tasks: [{ ...f.input.tasks[0]!, files,
      createFiles: ['helper.test.mjs'], checks: [{ id: 'helper', command: ['node', '--test', 'helper.test.mjs'] }] }] };
    if (files === undefined) delete input.tasks[0]!.files;
    const { prepared, approval } = await f.approved(input);
    const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
    assert.deepEqual(job.children[0]!.createFiles, ['helper.test.mjs']);
    assert.deepEqual(job.children[0]!.write!.baseline.approvedPaths, ['helper.test.mjs']);
    assert.deepEqual(job.children[0]!.write!.baseline.createFiles, ['helper.test.mjs']);
    assert.deepEqual(await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval), job);
    await f.supervisor.tick();
    assert(f.sessions.prompts[0]!.includes('"helper.test.mjs":"absent"'));
    assert(f.sessions.prompts[0]!.includes('onionsoup_operator_check'));
    const changed = await f.approved({ ...input, tasks: [{ ...input.tasks[0]!,
      checks: [{ id: 'different', command: ['node', '--test', 'helper.test.mjs'] }] }] });
    await assert.rejects(f.jobs.createApproved(f.origin, f.intake, changed.prepared.input, changed.approval), /idempotency_conflict/);
    const otherPath = await f.approved({ ...input, tasks: [{ ...input.tasks[0]!,
      createFiles: ['other.test.mjs'], checks: [{ id: 'helper', command: ['node', '--test', 'other.test.mjs'] }] }] });
    await assert.rejects(f.jobs.createApproved(f.origin, f.intake, otherPath.prepared.input, otherPath.approval), /idempotency_conflict/);
  }
});

test('prepared check with no file operations prevents explicit resume and zero-write recovery', async () => {
  const f = await fixture();
  const checks = [{ id: 'unit', command: ['node', '--test', 'check.test.mjs'] }];
  const { prepared, approval } = await f.approved({ ...f.input, tasks: [{ ...f.input.tasks[0]!, checks }] });
  const job = await f.jobs.createApproved(f.origin, f.intake, prepared.input, approval);
  await f.supervisor.tick();
  await f.jobs.transaction(async (ledger, save) => {
    const child = f.jobs.bound(ledger, f.origin, job.id).children[0]!;
    child.write!.checks = [{ id: 'pending_check', checkID: 'unit', command: checks[0]!.command, callID: 'call_pending',
      messageID: 'msg_pending', artifactDigest: '0'.repeat(64), status: 'prepared', startedAt: new Date().toISOString() }];
    child.status = 'blocked';
    child.blocker = 'operator_child_turn_error';
    child.attempts.at(-1)!.endedAt = new Date().toISOString();
    await save();
  });
  await assert.rejects(f.supervisor.intervene(f.origin, job.id, 'resume', 'edit'), /operator_write_check_uncertain/);
  const preview = await prepareOperatorRecovery(f.jobs, f.sessions, f.origin, job.id, 'edit');
  assert.equal(preview.eligible, false);
  assert.equal(preview.reason, 'write-reservation-requires-verified-review');
  const child = (await f.jobs.get(f.origin, job.id)).children[0]!;
  assert.equal(child.write!.operations.length, 0);
  assert.equal(child.write!.checks![0]!.status, 'prepared');
  assert.equal(operatorChildHoldsWorkspace(child), true);
  assert.equal(f.sessions.prompts.length, 1);
});
