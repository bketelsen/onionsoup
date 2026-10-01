import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { OperatorJobs, operatorWriteScopeDigest } from '../src/operator-jobs.ts';
import { abandonOperatorChild, prepareOperatorRecovery } from '../src/operator-job-recovery.ts';
import { OperatorRecoveryPermissions } from '../src/operator-recovery-permission.ts';
import { OperatorWritePermissions } from '../src/operator-write-permission.ts';
import { OperatorWrites } from '../src/operator-write-host.ts';
import { operatorWriteArtifact, operatorWriteSha256, snapshotOperatorWriteWorkspace } from '../src/operator-write-workspace.ts';
import { operatorChildHoldsWorkspace } from '../src/operator-write-state.ts';
import { operatorChildOccupiesSlot } from '../src/operator-scheduler.ts';
import { checkOperatorChildMessage, checkOperatorChildTool } from '../src/operator-child-scope.ts';
import { OPERATOR_INVESTIGATOR, type OperatorChild, type OperatorSessionSnapshot,
  type OperatorSupervisorClient, type OperatorWriteOperation } from '../src/operator-jobs-types.ts';

import { OPERATOR_WRITE_TOOL } from '../src/operator-write-call.ts';

const execute = promisify(execFile);
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-write-recovery-'));
  const directory = join(workspace, 'repo');
  await mkdir(directory);
  await execute('/usr/bin/git', ['init', '-q', directory]);
  await writeFile(join(directory, 'README.md'), '# Before\n');
  await execute('/usr/bin/git', ['-C', directory, 'add', 'README.md']);
  await execute('/usr/bin/git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const jobs = new OperatorJobs(join(workspace, 'state'), workspace, 'operator');
  const origin = { operator: 'operator', sessionID: 'ses_parent', directory: workspace };
  const prepared = await jobs.prepare(origin, { messageID: 'msg_human', text: 'Update the README title only.' }, {
    key: 'write', goal: 'Change the README title', constraints: ['Only README.md; no commit'],
    tasks: [{ id: 'edit', goal: 'Change the title', directory, access: 'write', files: ['README.md'], dependsOn: [] }],
  });
  const baseline = await snapshotOperatorWriteWorkspace({ workspace, directory, files: ['README.md'] });
  const baselines = { edit: baseline };
  const job = await jobs.createApproved(prepared.origin, prepared.intake, prepared.input, {
    scopeDigest: operatorWriteScopeDigest(prepared.origin, prepared.intake, prepared.input, baselines), baselines,
    proof: { permissionID: 'per_create', sessionID: origin.sessionID, messageID: 'msg_approval', reply: 'once', callID: 'call_create', nonce: randomUUID() },
  });
  const runtime: { unavailable: boolean; snapshot: OperatorSessionSnapshot } = {
    unavailable: false, snapshot: { status: 'idle', messages: [] },
  };
  let effects = 0;
  const client: OperatorSupervisorClient = {
    listSessions: async () => { if (runtime.unavailable) throw new Error('offline'); return []; },
    readSession: async () => { if (runtime.unavailable) throw new Error('offline'); return structuredClone(runtime.snapshot); },
    createSession: async () => { effects++; return { id: 'unexpected' }; },
    prompt: async () => { effects++; }, abort: async () => { effects++; },
  };
  const permissions = new OperatorRecoveryPermissions({ eventGraceMs: 1 });
  const approvals: Parameters<ToolContext['ask']>[0][] = [];
  const context = { sessionID: origin.sessionID, messageID: 'msg_recovery', abort: new AbortController().signal,
    metadata: () => {}, ask: async (request: Parameters<ToolContext['ask']>[0]) => {
      approvals.push(request);
      const id = `per_recovery_${approvals.length}`;
      permissions.event({ type: 'permission.asked', properties: { ...request, id, sessionID: origin.sessionID,
        tool: { messageID: context.messageID, callID: `call_recovery_${approvals.length}` } } });
      permissions.event({ type: 'permission.replied', properties: { requestID: id, sessionID: origin.sessionID, reply: 'once' } });
    } };
  const mutate = async (change: (child: OperatorChild) => void) => jobs.transaction(async (ledger, save) => {
    change(jobs.bound(ledger, origin, job.id).children[0]!); await save();
  });
  const preview = () => prepareOperatorRecovery(jobs, client, origin, job.id, 'edit');
  const abandon = (digest: string) => abandonOperatorChild(jobs, client, origin, job.id, 'edit', digest,
    'Release only this zero-write child, retaining history.', context, permissions);
  async function blocked() {
    await mutate(child => {
      child.status = 'blocked'; child.sessionID = 'ses_child'; child.blocker = 'operator_child_interrupted';
      child.attempts.push({ id: 'attempt_1', messageID: 'msg_prompt', createdAt: new Date().toISOString() });
    });
    runtime.snapshot.messages = [{ role: 'user', id: 'msg_prompt', text: 'Approved task', tools: [] },
      { role: 'assistant', id: 'msg_reply', parentID: 'msg_prompt', text: '', tools: [] }];
  }
  function operation(status: OperatorWriteOperation['status']): OperatorWriteOperation {
    return { callID: 'call_edit', messageID: 'msg_reply', status, preparedAt: new Date().toISOString(), mutation: {
      id: 'mutation_edit', path: 'README.md', beforeSha256: baseline.files.find(file => file.path === 'README.md')!.sha256,
      afterSha256: operatorWriteSha256('# After\n'), content: '# After\n', snapshotDigest: baseline.digest,
    } };
  }
  return { workspace, directory, jobs, origin, job, runtime, client, permissions, approvals, context, mutate,
    preview, abandon, blocked, operation, effects: () => effects };
}

test('never-launched zero-write reservation releases only with native once approval and immutable scope history', async () => {
  const f = await fixture();
  const before = await f.jobs.get(f.origin, f.job.id);
  const preview = await f.preview();
  assert.equal(preview.eligible, true);
  assert.equal(preview.reason, 'absent');
  for (const value of [f.job.id, 'edit', f.directory, 'README.md', 'Change the title']) assert(preview.warning.includes(value));
  const result = await f.abandon(preview.digest);
  const child = result.children[0]!;
  assert.equal(child.status, 'abandoned');
  assert.deepEqual(child.write, before.children[0]!.write);
  assert.deepEqual(result.intake, before.intake);
  assert.deepEqual(result.constraints, before.constraints);
  assert.equal(operatorChildHoldsWorkspace(child), false);
  assert.equal(operatorChildOccupiesSlot(child), false);
  assert.equal(f.approvals.length, 1);
  assert.match(String(f.approvals[0]!.metadata.action), /zero-write/);
  assert.deepEqual(f.approvals[0]!.always, []);
  assert.deepEqual(await f.abandon(preview.digest), result);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.effects(), 0);
  await f.jobs.create(f.origin, result.intake, { key: 'separate-human-request', goal: 'Read the README', constraints: [],
    tasks: [{ id: 'read', goal: 'Read', directory: f.directory, access: 'read-only', dependsOn: [] }] });
});

test('idle owned interrupted child releases both claims, preserves attempts and fences late tools without file effects', async () => {
  const f = await fixture(); await f.blocked();
  const before = (await f.jobs.get(f.origin, f.job.id)).children[0]!;
  assert.equal(operatorChildOccupiesSlot(before), true);
  assert.equal((await f.preview()).reason, 'idle-owned');
  const result = await f.abandon((await f.preview()).digest);
  const child = result.children[0]!;
  assert.deepEqual(child.attempts, before.attempts);
  assert.equal(operatorChildHoldsWorkspace(child), false);
  assert.equal(operatorChildOccupiesSlot(child), false);
  await assert.rejects(checkOperatorChildMessage(f.jobs, OPERATOR_INVESTIGATOR, 'ses_child', 'msg_prompt'), /message_unbound/);
  await assert.rejects(checkOperatorChildTool(f.jobs, 'ses_child', OPERATOR_WRITE_TOOL, {}), /not_running/);
  const writes = new OperatorWrites(f.jobs, f.client, new OperatorWritePermissions());
  const childContext = { ...f.context, agent: OPERATOR_INVESTIGATOR, directory: f.directory, sessionID: 'ses_child', messageID: 'msg_reply' };
  await assert.rejects(writes.file(childContext, 'call_edit', { path: 'README.md', content: '# After\n',
    expectedBeforeSha256: child.write!.baseline.files.find(file => file.path === 'README.md')!.sha256 }), /write_child_not_running/);
  assert.equal(await readFile(join(f.directory, 'README.md'), 'utf8'), '# Before\n');
  assert.equal(f.effects(), 0);
});

test('finished zero-operation child can be abandoned rather than accepted as successfully edited', async () => {
  const f = await fixture(); await f.blocked();
  const current = (await f.jobs.get(f.origin, f.job.id)).children[0]!;
  const artifact = await operatorWriteArtifact(current.write!.baseline, []);
  f.runtime.snapshot.messages[1]!.completed = true;
  f.runtime.snapshot.messages[1]!.text = 'No file changed; the requested edit remains undone.';
  await f.mutate(child => { child.status = 'needs-review'; child.write!.artifact = artifact; });
  const result = await f.abandon((await f.preview()).digest);
  assert.equal(result.children[0]!.status, 'abandoned');
  assert.equal(result.children[0]!.write!.acceptance, undefined);
  assert.deepEqual(result.children[0]!.write!.artifact, artifact);
});

test('all recorded mutations retain the claim including prepared, applied and not-applied receipts', async () => {
  for (const status of ['prepared', 'applied', 'not-applied'] as const) {
    const f = await fixture(); await f.blocked();
    await f.mutate(child => child.write!.operations.push(f.operation(status)));
    const preview = await f.preview();
    assert.equal(preview.eligible, false);
    await assert.rejects(f.abandon(preview.digest), /not_eligible/);
    assert.equal(f.approvals.length, 0);
    assert.equal(operatorChildHoldsWorkspace((await f.jobs.get(f.origin, f.job.id)).children[0]!), true);
  }
});

test('busy, unavailable, active tools, foreign turns and active scheduler claims cannot release zero-write claims', async () => {
  for (const mode of ['busy', 'unavailable', 'tool', 'foreign', 'foreign-assistant', 'claim'] as const) {
    const f = await fixture(); await f.blocked();
    if (mode === 'busy') f.runtime.snapshot.status = 'busy';
    if (mode === 'unavailable') f.runtime.unavailable = true;
    if (mode === 'tool') f.runtime.snapshot.messages[1]!.tools.push({ callID: 'call_active', tool: 'read', status: 'running' });
    if (mode === 'foreign') f.runtime.snapshot.messages.push({ id: 'msg_person', role: 'user', text: 'Real user work', tools: [] });
    if (mode === 'foreign-assistant') f.runtime.snapshot.messages[1]!.parentID = 'msg_person';
    if (mode === 'claim') await f.mutate(child => { child.operation = { token: randomUUID(), kind: 'observe',
      startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
    const preview = await f.preview();
    assert.equal(preview.eligible, false, mode);
    assert.equal(operatorChildHoldsWorkspace((await f.jobs.get(f.origin, f.job.id)).children[0]!), true);
    if (mode.startsWith('foreign')) {
      f.runtime.unavailable = true;
      assert.equal((await f.preview()).reason, 'foreign-work');
    }
  }
});

test('native denial cannot release a zero-write claim', async () => {
  const f = await fixture();
  f.context.ask = async () => { throw new Error('Human declined'); };
  await assert.rejects(f.abandon((await f.preview()).digest), /not_approved/);
  assert.equal(operatorChildHoldsWorkspace((await f.jobs.get(f.origin, f.job.id)).children[0]!), true);
});

test('a mutation recorded while approval is pending invalidates release and preserves the full write reservation', async () => {
  const f = await fixture(); await f.blocked();
  const preview = await f.preview();
  const ask = f.context.ask;
  f.context.ask = async request => {
    await ask(request);
    await f.mutate(child => child.write!.operations.push(f.operation('prepared')));
  };
  await assert.rejects(f.abandon(preview.digest), /stale/);
  const child = (await f.jobs.get(f.origin, f.job.id)).children[0]!;
  assert.equal(child.abandonment, undefined);
  assert.equal(child.write!.operations.length, 1);
  assert.equal(operatorChildHoldsWorkspace(child), true);
});

test('write scope or runtime changing during native approval invalidates the exact release', async () => {
  for (const mode of ['scope', 'runtime'] as const) {
    const f = await fixture(); await f.blocked();
    const preview = await f.preview();
    const ask = f.context.ask;
    f.context.ask = async request => {
      await ask(request);
      if (mode === 'scope') await f.mutate(child => { child.write!.approval.scopeDigest = 'changed'; });
      else f.runtime.snapshot.status = 'busy';
    };
    await assert.rejects(f.abandon(preview.digest), /stale/);
    assert.equal(operatorChildHoldsWorkspace((await f.jobs.get(f.origin, f.job.id)).children[0]!), true);
  }
});


test('a competing accepted-diff receipt invalidates a pending zero-operation abandonment', async () => {
  const f = await fixture(); await f.blocked();
  await f.mutate(child => { child.status = 'needs-review'; });
  const preview = await f.preview();
  const ask = f.context.ask;
  f.context.ask = async request => {
    await ask(request);
    // Model the independently tested accept-write commit winning the ledger race.
    await f.mutate(child => {
      child.status = 'completed';
      child.write!.acceptance = { digest: 'competing-accepted-artifact', at: new Date().toISOString(),
        proof: { permissionID: 'per_accept', sessionID: f.origin.sessionID, messageID: 'msg_accept',
          reply: 'once', callID: 'call_accept', nonce: randomUUID() } };
    });
  };
  await assert.rejects(f.abandon(preview.digest), /stale/);
  const child = (await f.jobs.get(f.origin, f.job.id)).children[0]!;
  assert.equal(child.status, 'completed');
  assert.equal(child.abandonment, undefined);
  assert.equal(child.write!.acceptance!.digest, 'competing-accepted-artifact');
});
