import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { OperatorJobs } from '../src/operator-jobs.ts';
import { OperatorSupervisor, OPERATOR_SUPERVISOR_LIMITS } from '../src/operator-supervisor.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { OperatorWritePermissions } from '../src/operator-write-permission.ts';
import { OperatorWriteCalls, OPERATOR_WRITE_TOOL } from '../src/operator-write-call.ts';
import { operatorChildHoldsWorkspace } from '../src/operator-write-state.ts';
import { OPERATOR_INVESTIGATOR, type OperatorJobInput, type OperatorSessionSnapshot, type OperatorSupervisorClient } from '../src/operator-jobs-types.ts';

import { fixture, start, type Context } from './operator-write-host-fixture.ts';

async function edit(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const job = await f.jobs.get(f.origin, id);
  const child = job.children[0]!;
  const sessionID = child.sessionID!;
  const messageID = 'msg_native_write';
  const callID = 'call_native_write';
  f.client.tool(sessionID, messageID, callID);
  const input = { path: 'README.md', expectedBeforeSha256: child.write!.baseline.files.find(file => file.path === 'README.md')!.sha256,
    content: '# Revised\n' };
  const calls = new OperatorWriteCalls();
  const args = { ...input };
  calls.prepare({ sessionID, callID }, args);
  const actualCallID = calls.consume(sessionID, args);
  const receipt = await f.writes.file(f.childContext(sessionID, messageID), actualCallID, input);
  return { child, sessionID, messageID, callID, input, receipt };
}

async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const job = await start(f);
  const changed = await edit(f, job.id);
  f.client.finish(changed.sessionID);
  await f.supervisor.tick();
  const review = await f.writes.review(f.origin, job.id, 'edit');
  return { job, changed, review };
}

test('host write creation normalizes intake and native once proof, and duplicate creation does not ask again', async () => {
  const f = await fixture();
  const job = await f.writes.create(f.origin, f.intake, f.input, f.parent());
  assert.equal(job.intake.text, f.intake.text.trim());
  assert.equal(job.children[0]!.write!.approval.proof.reply, 'once');
  assert.match(job.children[0]!.write!.approval.proof.permissionID, /^permission_host_/);
  assert.deepEqual(f.asks[0]!.always, []);
  assert.equal(f.asks[0]!.metadata.mode, 'create-write');
  assert.deepEqual(f.asks[0]!.metadata, JSON.parse(JSON.stringify(f.asks[0]!.metadata)),
    'native OpenCode permission metadata cannot contain undefined optional properties');
  const duplicate = await f.writes.create(f.origin, f.intake, f.input, f.parent());
  assert.deepEqual(duplicate, job);
  assert.equal(f.asks.length, 1);
  assert.equal(f.client.prompts, 0);
});

test('host denies a changed clean baseline during native approval without creating a job', async () => {
  const f = await fixture();
  await assert.rejects(f.writes.create(f.origin, f.intake, f.input, f.parent(async () => {
    await writeFile(join(f.directory, 'README.md'), '# Independent change\n');
    await f.git(['add', 'README.md']);
    await f.git(['commit', '-qm', 'independent human change while approval pending']);
  })), /operator_write_scope_stale/);
  assert.equal((await f.jobs.snapshot()).length, 0);
  assert.equal(f.client.sessions.size, 0);
});

test('native refusal and always approval create neither job nor file effect', async () => {
  for (const reply of ['reject', 'always']) {
    const f = await fixture();
    await assert.rejects(f.writes.create(f.origin, f.intake, f.input, f.parent(undefined, reply)), /operator_write_permission_/);
    assert.equal((await f.jobs.snapshot()).length, 0);
    assert.equal(await readFile(join(f.directory, 'README.md'), 'utf8'), '# Original\n');
    assert.equal(f.client.prompts, 0);
  }
});

test('host writer binds the exact native call, records its real receipt, and accepts the verified diff once', async () => {
  const f = await fixture();
  const job = await start(f);
  const child = job.children[0]!;
  const hash = child.write!.baseline.files.find(file => file.path === 'README.md')!.sha256;
  f.client.tool(child.sessionID!, 'msg_real_call', 'call_real');
  await assert.rejects(f.writes.file(f.childContext(child.sessionID!, 'msg_real_call'), 'call_forged', {
    path: 'README.md', expectedBeforeSha256: hash, content: '# Forged\n',
  }), /operator_write_call_unbound/);
  assert.equal(await readFile(join(f.directory, 'README.md'), 'utf8'), '# Original\n');
  // Keep the rejected synthetic call terminal, then create the actual separately bound call.
  f.client.sessions.get(child.sessionID!)!.snapshot.messages.at(-1)!.tools[0]!.status = 'error';
  const changed = await edit(f, job.id);
  assert.equal(await readFile(join(f.directory, 'README.md'), 'utf8'), '# Revised\n');
  const persisted = await f.jobs.get(f.origin, job.id);
  assert.equal(persisted.children[0]!.write!.operations.length, 1);
  assert.equal(persisted.children[0]!.write!.operations[0]!.status, 'applied');
  assert.deepEqual(persisted.children[0]!.write!.operations[0]!.receipt, changed.receipt);
  await assert.rejects(f.writes.file(f.childContext(changed.sessionID, changed.messageID), changed.callID, changed.input), /operator_write_call_already_recorded/);
  f.client.finish(changed.sessionID);
  await f.supervisor.tick();
  const preview = await f.writes.review(f.origin, job.id, 'edit');
  assert.match(preview.artifact.diff, /\+# Revised/);
  assert.equal(operatorChildHoldsWorkspace(preview.child), true);
  const accepted = await f.writes.accept(f.origin, job.id, 'edit', preview.digest, f.parent());
  assert.equal(accepted.children[0]!.status, 'completed');
  assert.equal(operatorChildHoldsWorkspace(accepted.children[0]!), false);
  assert.equal(accepted.children[0]!.write!.acceptance!.proof.reply, 'once');
  assert.equal(f.asks.length, 2);
  assert.equal(f.asks[1]!.metadata.mode, 'accept-write');
  await f.writes.accept(f.origin, job.id, 'edit', preview.digest, f.parent());
  assert.equal(f.asks.length, 2, 'idempotent acceptance does not solicit or replay another approval');
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), child.write!.baseline.head);
});

test('changed host diff or runtime activity during acceptance retains the workspace claim', async () => {
  const f = await fixture();
  const { job, review } = await ready(f);
  await assert.rejects(f.writes.accept(f.origin, job.id, 'edit', review.digest, f.parent(async () => {
    await writeFile(join(f.directory, 'README.md'), '# Changed after review\n');
  })), /operator_write_(source_changed|artifact_changed)/);
  const held = await f.jobs.get(f.origin, job.id);
  assert.equal(held.children[0]!.write!.acceptance, undefined);
  assert.equal(operatorChildHoldsWorkspace(held.children[0]!), true);
  const other = await fixture();
  const second = await ready(other);
  await assert.rejects(other.writes.accept(other.origin, second.job.id, 'edit', second.review.digest, other.parent(async () => {
    other.client.sessions.get(second.changed.sessionID)!.snapshot.status = 'busy';
  })), /operator_write_runtime_not_settled/);
  assert.equal(operatorChildHoldsWorkspace((await other.jobs.get(other.origin, second.job.id)).children[0]!), true);
});

test('slow host review metadata does not hold the parent ledger lock', async () => {
  const f = await fixture();
  const { job } = await ready(f);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const read = f.client.readSession.bind(f.client);
  f.client.readSession = async (directory, sessionID) => { enter(); await pending; return read(directory, sessionID); };
  const review = f.writes.review(f.origin, job.id, 'edit');
  await entered;
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const jobs = await Promise.race([f.jobs.list(f.origin), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('parent_ledger_blocked')), 2_000);
    })]);
    assert.equal(jobs[0]!.id, job.id);
  } finally { clearTimeout(timeout); release(); await review; }
});

test('refusing final diff acceptance preserves the applied receipt and holds the workspace claim', async () => {
  const f = await fixture();
  const { job, review } = await ready(f);
  await assert.rejects(f.writes.accept(f.origin, job.id, 'edit', review.digest, f.parent(undefined, 'reject')), /operator_write_permission_rejected/);
  const current = await f.jobs.get(f.origin, job.id);
  assert.equal(current.children[0]!.write!.acceptance, undefined);
  assert.equal(current.children[0]!.write!.operations[0]!.status, 'applied');
  assert.equal(operatorChildHoldsWorkspace(current.children[0]!), true);
  assert.equal(await readFile(join(f.directory, 'README.md'), 'utf8'), '# Revised\n');
});

test('concurrent native approvals of one exact diff record only one accepted transition', async () => {
  const f = await fixture();
  const { job, review } = await ready(f);
  let count = 0;
  let release!: () => void;
  const bothAsked = new Promise<void>(resolve => { release = resolve; });
  const atApproval = async () => {
    count++;
    if (count === 2) release();
    await bothAsked;
  };
  const outcomes = await Promise.all([
    f.writes.accept(f.origin, job.id, 'edit', review.digest, f.parent(atApproval)),
    f.writes.accept(f.origin, job.id, 'edit', review.digest, f.parent(atApproval)),
  ]);
  assert(outcomes.every(outcome => outcome.children[0]!.status === 'completed'));
  const current = await f.jobs.get(f.origin, job.id);
  assert.equal(current.events.filter(event => event.kind === 'write-accepted').length, 1);
  assert.equal(current.children[0]!.write!.operations.length, 1);
  assert.equal(operatorChildHoldsWorkspace(current.children[0]!), false);
});
