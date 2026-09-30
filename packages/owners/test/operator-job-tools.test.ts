import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { OperatorJobs } from '../src/operator-jobs.ts';
import { operatorJobCaller } from '../src/operator-job-tools.ts';
import { checkOperatorChildMessage, checkOperatorChildTool } from '../src/operator-child-scope.ts';
import { OPERATOR_INVESTIGATOR } from '../src/operator-jobs-types.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'operator-tools-'));
  const jobs = new OperatorJobs(directory, directory, 'Duncan');
  const context = { agent: 'Duncan', sessionID: 'ses_parent', messageID: 'msg_answer', directory };
  const messages = [
    { info: { id: 'msg_person', role: 'user' }, parts: [{ type: 'text', text: 'Inspect the code and tests. Do not edit.' }] },
    { info: { id: 'msg_answer', role: 'assistant', parentID: 'msg_person' }, parts: [] },
    { info: { id: 'msg_later', role: 'user' }, parts: [{ type: 'text', text: 'Unrelated later task' }] },
  ];
  const session = { id: context.sessionID, directory, parentID: undefined as string | undefined };
  const client = { session: { get: async () => ({ data: session }), messages: async () => ({ data: messages }) } } as unknown as Parameters<Plugin>[0]['client'];
  return { directory, jobs, context, messages, session, client };
}

test('operator job intake comes from the exact invoking turn, not later messages or model-provided approval', async () => {
  const f = await fixture();
  const caller = await operatorJobCaller(f.jobs, f.client, f.context, true);
  assert.deepEqual(caller.intake, { messageID: 'msg_person', text: 'Inspect the code and tests. Do not edit.' });
  await assert.rejects(operatorJobCaller(f.jobs, f.client, { ...f.context, messageID: 'msg_missing' }, true), /human_intake_required/);
  await assert.rejects(operatorJobCaller(f.jobs, f.client, { ...f.context, agent: 'Odrade' }, true), /operator_only/);
  f.session.parentID = 'ses_foreign';
  await assert.rejects(operatorJobCaller(f.jobs, f.client, f.context, true), /parent_unverified/);
});

test('runtime notices can read an existing job but cannot masquerade as human intake', async () => {
  const f = await fixture();
  f.messages[0]!.parts[0]!.text = '[onionsoup notice] Investigations complete; synthesize them.';
  await assert.rejects(operatorJobCaller(f.jobs, f.client, f.context, true), /human_intake_required/);
  assert.equal((await operatorJobCaller(f.jobs, f.client, f.context)).origin.sessionID, 'ses_parent');
});

test('managed children accept only durable bound attempts and bounded reads, preserving ordinary user work', async () => {
  const f = await fixture();
  const caller = await operatorJobCaller(f.jobs, f.client, f.context, true);
  const job = await f.jobs.create(caller.origin, caller.intake!, { key: 'inspect', goal: 'Explain code', constraints: ['No effects'],
    tasks: [{ id: 'code', goal: 'Read code', directory: f.directory, access: 'read-only', dependsOn: [] }] });
  await f.jobs.transaction(async (ledger, save) => {
    const child = ledger.jobs[0]!.children[0]!;
    child.sessionID = 'ses_child'; child.status = 'dispatching';
    child.attempts.push({ id: 'attempt_one', messageID: 'msg_dispatch', createdAt: new Date().toISOString() });
    await save();
  });
  await checkOperatorChildMessage(f.jobs, OPERATOR_INVESTIGATOR, 'ses_child', 'msg_dispatch');
  await assert.rejects(checkOperatorChildMessage(f.jobs, OPERATOR_INVESTIGATOR, 'ses_child', 'msg_other'), /message_unbound/);
  await assert.rejects(checkOperatorChildMessage(f.jobs, OPERATOR_INVESTIGATOR, 'ses_unknown', 'msg_dispatch'), /message_unbound/);
  await assert.rejects(checkOperatorChildMessage(f.jobs, 'Duncan', 'ses_child', 'msg_dispatch'), /message_unbound/);
  await checkOperatorChildMessage(f.jobs, 'Duncan', 'ses_parent', 'msg_person');
  await writeFile(join(f.directory, 'code.txt'), 'fixture');
  await checkOperatorChildTool(f.jobs, 'ses_child', 'read', { filePath: join(f.directory, 'code.txt') });
  await assert.rejects(checkOperatorChildTool(f.jobs, 'ses_child', 'bash', { command: 'true' }), /read_only/);
  await assert.rejects(checkOperatorChildTool(f.jobs, 'ses_child', 'glob', { pattern: '../*' }), /pattern_outside_scope/);
  const outside = await mkdtemp(join(tmpdir(), 'operator-outside-'));
  await writeFile(join(outside, 'private.txt'), 'fixture-only');
  await symlink(outside, join(f.directory, 'escape'));
  await assert.rejects(checkOperatorChildTool(f.jobs, 'ses_child', 'read', { filePath: join(f.directory, 'escape/private.txt') }), /path_outside_scope/);
  await checkOperatorChildTool(f.jobs, 'ses_parent', 'bash', { command: 'true' });
  assert.equal((await f.jobs.get(caller.origin, job.id)).children[0]!.attempts.length, 1);
});
