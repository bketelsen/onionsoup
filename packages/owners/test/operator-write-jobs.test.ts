import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { OperatorJobs, operatorJobDigest, operatorWriteScopeDigest, operatorWriteReviewDigest } from '../src/operator-jobs.ts';
import { OperatorSupervisor, OPERATOR_SUPERVISOR_LIMITS } from '../src/operator-supervisor.ts';
import { operatorWriteArtifact, snapshotOperatorWriteWorkspace, operatorWriteSha256,
  type OperatorWriteSnapshot, type OperatorWriteReceipt } from '../src/operator-write-workspace.ts';
import { operatorChildHoldsWorkspace } from '../src/operator-write-state.ts';
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
  await execute('/usr/bin/git', ['-C', directory, 'add', 'README.md']);
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
      baselines[task.id] = await snapshotOperatorWriteWorkspace({ workspace, directory: task.directory, files: task.files! });
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
