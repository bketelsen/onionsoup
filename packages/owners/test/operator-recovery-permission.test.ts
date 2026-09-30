import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { OPERATOR_RECOVERY_PERMISSION } from '../src/operator-jobs-types.ts';
import { OperatorRecoveryPermissions, OPERATOR_RECOVERY_NONCE } from '../src/operator-recovery-permission.ts';

type Ask = Parameters<ToolContext['ask']>[0];
function fixture() {
  const permissions = new OperatorRecoveryPermissions({ eventGraceMs: 15 });
  const controller = new AbortController();
  const request = { patterns: ['job/child/exact-digest'], metadata: { digest: 'exact-digest' } };
  const asked = (input: Ask, id = 'per_fixture', overrides: Record<string, unknown> = {}) => ({
    type: 'permission.asked', properties: { id, sessionID: 'ses_parent', ...input,
      tool: { messageID: 'msg_current', callID: 'call_current' }, ...overrides },
  });
  const replied = (id = 'per_fixture', reply = 'once', sessionID = 'ses_parent') => ({
    type: 'permission.replied', properties: { sessionID, requestID: id, reply },
  });
  const context = (ask: (input: Ask) => Promise<void>) => ({ sessionID: 'ses_parent', messageID: 'msg_current', abort: controller.signal, ask });
  return { permissions, controller, request, asked, replied, context };
}

test('recovery proof requires the exact native asked and once reply, with no persistent permission pattern', async () => {
  const f = fixture();
  const proof = await f.permissions.ask(f.context(async input => {
    assert.equal(input.permission, OPERATOR_RECOVERY_PERMISSION);
    assert.deepEqual(input.always, []);
    assert.notEqual(input.metadata[OPERATOR_RECOVERY_NONCE], 'model-supplied');
    f.permissions.event(f.asked(input));
    f.permissions.event(f.replied('per_fixture', 'once'));
  }), { ...f.request, metadata: { [OPERATOR_RECOVERY_NONCE]: 'model-supplied' } });
  assert.deepEqual({ ...proof, nonce: 'host-generated' }, {
    permissionID: 'per_fixture', sessionID: 'ses_parent', messageID: 'msg_current', callID: 'call_current', reply: 'once', nonce: 'host-generated',
  });
  assert.match(proof.nonce, /^[a-f0-9-]{36}$/);
});

test('an always reply is rejected even when native ask resolves and persistent patterns are empty', async () => {
  const f = fixture();
  await assert.rejects(f.permissions.ask(f.context(async input => {
    assert.deepEqual(input.always, []);
    f.permissions.event(f.asked(input));
    f.permissions.event(f.replied('per_fixture', 'always'));
  }), f.request), /operator_recovery_permission_once_required/);
});

test('native automatic allow without an actual permission request fails closed', async () => {
  const f = fixture();
  await assert.rejects(f.permissions.ask(f.context(async () => {}), f.request), /human_permission_unobserved/);
});

test('late event delivery after native ask resolves is accepted only within the bounded proof grace', async () => {
  const f = fixture();
  const proof = await f.permissions.ask(f.context(async input => {
    setImmediate(() => {
      f.permissions.event(f.asked(input));
      f.permissions.event(f.replied());
    });
  }), f.request);
  assert.equal(proof.permissionID, 'per_fixture');
});

test('wrong session, tool message, nonce, permission, patterns and persistent rules cannot supply proof', async () => {
  const f = fixture();
  const cases = [
    { sessionID: 'ses_other' }, { tool: { messageID: 'msg_other', callID: 'call_current' } },
    { metadata: { [OPERATOR_RECOVERY_NONCE]: 'foreign-nonce' } }, { permission: 'read' },
    { patterns: ['another-digest'] }, { always: ['*'] }, { tool: undefined },
  ];
  for (const override of cases) {
    await assert.rejects(f.permissions.ask(f.context(async input => {
      f.permissions.event(f.asked(input, 'per_fixture', override));
      f.permissions.event(f.replied());
    }), f.request), /human_permission_unobserved/);
  }
});

test('missing, reordered and wrong-request replies never authorize the gate', async () => {
  for (const order of ['missing', 'reordered', 'wrong-request', 'wrong-session']) {
    const f = fixture();
    await assert.rejects(f.permissions.ask(f.context(async input => {
      if (order === 'reordered') f.permissions.event(f.replied());
      f.permissions.event(f.asked(input));
      if (order === 'wrong-request') f.permissions.event(f.replied('per_other'));
      if (order === 'wrong-session') f.permissions.event(f.replied('per_fixture', 'once', 'ses_other'));
    }), f.request), /reply_unobserved/);
  }
});

test('native rejection and abort cannot be turned into approval even if a reply was observed', async () => {
  const f = fixture();
  await assert.rejects(f.permissions.ask(f.context(async input => {
    f.permissions.event(f.asked(input));
    f.permissions.event(f.replied('per_fixture', 'reject'));
  }), f.request), /permission_rejected/);
  await assert.rejects(f.permissions.ask(f.context(async input => {
    f.permissions.event(f.asked(input));
    f.permissions.event(f.replied());
    throw new Error('native_ask_rejected');
  }), f.request), /native_ask_rejected/);
  await assert.rejects(f.permissions.ask(f.context(async input => {
    f.permissions.event(f.asked(input));
    f.permissions.event(f.replied());
    f.controller.abort();
  }), f.request), /permission_aborted/);
});

test('aborting an unresolved native ask cleans up its gate and does not wait for a response', async () => {
  const f = fixture();
  let event: unknown;
  const operation = f.permissions.ask(f.context(async input => {
    event = f.asked(input);
    setImmediate(() => f.controller.abort());
    await new Promise<void>(() => {});
  }), f.request);
  await assert.rejects(operation, /permission_aborted/);
  f.permissions.event(event);
  f.permissions.event(f.replied());
});

test('concurrent exact gates cannot borrow one another replies or old nonce events', async () => {
  const f = fixture();
  let firstAsked: unknown;
  const first = await f.permissions.ask(f.context(async input => {
    firstAsked = f.asked(input, 'per_first');
    f.permissions.event(firstAsked);
    f.permissions.event(f.replied('per_first'));
  }), f.request);
  assert.equal(first.permissionID, 'per_first');
  await assert.rejects(f.permissions.ask(f.context(async () => {
    f.permissions.event(firstAsked);
    f.permissions.event(f.replied('per_first'));
  }), f.request), /human_permission_unobserved/);
  const proofs = await Promise.all(['first', 'second'].map(label => f.permissions.ask(f.context(async input => {
    f.permissions.event(f.asked(input, `per_${label}`));
    await new Promise<void>(resolve => setImmediate(resolve));
    f.permissions.event(f.replied(`per_${label}`));
  }), { patterns: [label], metadata: {} })));
  assert.deepEqual(proofs.map(proof => proof.permissionID), ['per_first', 'per_second']);
  assert.notEqual(proofs[0].nonce, proofs[1].nonce);
});

test('duplicate matching events are idempotent but conflicting request identities fail closed', async () => {
  const f = fixture();
  const proof = await f.permissions.ask(f.context(async input => {
    f.permissions.event(f.asked(input));
    f.permissions.event(f.asked(input));
    f.permissions.event(f.replied());
    f.permissions.event(f.replied());
  }), f.request);
  assert.equal(proof.permissionID, 'per_fixture');
  await assert.rejects(f.permissions.ask(f.context(async input => {
    f.permissions.event(f.asked(input));
    f.permissions.event(f.asked(input, 'per_conflicting'));
    f.permissions.event(f.replied('per_conflicting'));
  }), f.request), /permission_ambiguous/);
});
