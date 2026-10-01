import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { OPERATOR_RECOVERY_PERMISSION, OPERATOR_WRITE_PERMISSION } from '../src/operator-jobs-types.ts';
import { OperatorRecoveryPermissions, OPERATOR_RECOVERY_NONCE } from '../src/operator-recovery-permission.ts';
import { OperatorWritePermissions, OPERATOR_WRITE_NONCE } from '../src/operator-write-permission.ts';

type Ask = Parameters<ToolContext['ask']>[0];
function context(ask: (input: Ask) => Promise<void>) {
  return { sessionID: 'ses_operator', messageID: 'msg_operator', abort: new AbortController().signal, ask };
}
function asked(input: Ask, id: string, overrides: Record<string, unknown> = {}) {
  return { type: 'permission.asked', properties: { id, sessionID: 'ses_operator', ...input,
    tool: { messageID: 'msg_operator', callID: `call_${id}` }, ...overrides } };
}
function replied(id: string, reply = 'once') {
  return { type: 'permission.replied', properties: { sessionID: 'ses_operator', requestID: id, reply } };
}
function request(mode: 'create-write' | 'accept-write') {
  return { patterns: [`${mode}/job/child/exact-tree-digest`], metadata: { mode, approvalScope: 'once', digest: 'exact-tree-digest' } };
}

test('write creation and final diff acceptance each require a distinct exact native Allow once proof', async () => {
  const permissions = new OperatorWritePermissions({ eventGraceMs: 15 });
  const proofs = [];
  for (const mode of ['create-write', 'accept-write'] as const) {
    proofs.push(await permissions.ask(context(async input => {
      assert.equal(input.permission, OPERATOR_WRITE_PERMISSION);
      assert.deepEqual(input.always, []);
      assert.equal(input.metadata.approvalScope, 'once');
      assert.match(String(input.metadata[OPERATOR_WRITE_NONCE]), /^[a-f0-9-]{36}$/);
      permissions.event(asked(input, `per_${mode}`));
      permissions.event(replied(`per_${mode}`));
    }), request(mode)));
  }
  assert.deepEqual(proofs.map(proof => proof.permissionID), ['per_create-write', 'per_accept-write']);
  assert(proofs.every(proof => proof.reply === 'once' && proof.sessionID === 'ses_operator' && proof.messageID === 'msg_operator'));
  assert.notEqual(proofs[0]!.nonce, proofs[1]!.nonce);
});

test('native auto-allow and Always replies cannot authorize either write gate', async () => {
  const permissions = new OperatorWritePermissions({ eventGraceMs: 15 });
  for (const mode of ['create-write', 'accept-write'] as const) {
    await assert.rejects(permissions.ask(context(async () => {}), request(mode)), /operator_write_human_permission_unobserved/);
    await assert.rejects(permissions.ask(context(async input => {
      permissions.event(asked(input, `per_${mode}`));
      permissions.event(replied(`per_${mode}`, 'always'));
    }), request(mode)), /operator_write_permission_once_required/);
  }
});

test('recovery and write requests interleave without borrowing a permission or nonce', async () => {
  const recovery = new OperatorRecoveryPermissions({ eventGraceMs: 15 });
  const write = new OperatorWritePermissions({ eventGraceMs: 15 });
  const deliver = (event: unknown) => { recovery.event(event); write.event(event); };
  const pending = new Map<string, Ask>();
  let started!: () => void;
  const bothStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const finishAsks = new Promise<void>(resolve => { release = resolve; });
  const start = (permission: string) => context(async input => {
    pending.set(permission, input);
    if (pending.size === 2) started();
    await finishAsks;
  });
  const recovering = recovery.ask(start(OPERATOR_RECOVERY_PERMISSION), { patterns: ['recover/exact'], metadata: {} });
  const writing = write.ask(start(OPERATOR_WRITE_PERMISSION), request('create-write'));
  await bothStarted;
  const recoveryInput = pending.get(OPERATOR_RECOVERY_PERMISSION)!;
  const writeInput = pending.get(OPERATOR_WRITE_PERMISSION)!;
  assert.notEqual(recoveryInput.metadata[OPERATOR_RECOVERY_NONCE], writeInput.metadata[OPERATOR_WRITE_NONCE]);
  deliver(asked(writeInput, 'per_wrong_write', { permission: OPERATOR_RECOVERY_PERMISSION }));
  deliver(replied('per_wrong_write'));
  deliver(asked(recoveryInput, 'per_wrong_recovery', { permission: OPERATOR_WRITE_PERMISSION }));
  deliver(replied('per_wrong_recovery'));
  deliver(asked(writeInput, 'per_write'));
  deliver(asked(recoveryInput, 'per_recovery'));
  deliver(replied('per_recovery'));
  deliver(replied('per_write'));
  release();
  const [recoveryProof, writeProof] = await Promise.all([recovering, writing]);
  assert.equal(recoveryProof.permissionID, 'per_recovery');
  assert.equal(writeProof.permissionID, 'per_write');
});

test('a creation approval cannot be replayed as acceptance of a reviewed diff', async () => {
  const permissions = new OperatorWritePermissions({ eventGraceMs: 15 });
  let creationEvent: unknown;
  await permissions.ask(context(async input => {
    creationEvent = asked(input, 'per_create');
    permissions.event(creationEvent);
    permissions.event(replied('per_create'));
  }), request('create-write'));
  await assert.rejects(permissions.ask(context(async input => {
    permissions.event(creationEvent);
    permissions.event(replied('per_create'));
    permissions.event(asked(input, 'per_wrong_mode', { patterns: request('create-write').patterns }));
    permissions.event(replied('per_wrong_mode'));
  }), request('accept-write')), /operator_write_human_permission_unobserved/);
});

test('write denial, wrong tool turn and reordered replies stay closed', async () => {
  const permissions = new OperatorWritePermissions({ eventGraceMs: 15 });
  await assert.rejects(permissions.ask(context(async input => {
    permissions.event(asked(input, 'per_denied'));
    permissions.event(replied('per_denied', 'reject'));
  }), request('accept-write')), /operator_write_permission_rejected/);
  await assert.rejects(permissions.ask(context(async input => {
    permissions.event(asked(input, 'per_wrong_turn', { tool: { messageID: 'msg_other', callID: 'call_other' } }));
    permissions.event(replied('per_wrong_turn'));
  }), request('accept-write')), /operator_write_human_permission_unobserved/);
  await assert.rejects(permissions.ask(context(async input => {
    permissions.event(replied('per_reordered'));
    permissions.event(asked(input, 'per_reordered'));
  }), request('accept-write')), /operator_write_permission_reply_unobserved/);
});
