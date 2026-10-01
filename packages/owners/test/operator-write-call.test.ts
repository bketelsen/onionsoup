import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperatorWriteCalls, OperatorCheckCalls } from '../src/operator-write-call.ts';

const input = () => ({ path: 'README.md', expectedBeforeSha256: 'a'.repeat(64), content: 'Scoped change\n' });

test('native call capabilities bind session and exact arguments and consume only once', () => {
  const calls = new OperatorWriteCalls();
  const first = input();
  const second = input();
  calls.prepare({ sessionID: 'ses_one', callID: 'call_one' }, first);
  calls.prepare({ sessionID: 'ses_two', callID: 'call_two' }, second);
  const replay = structuredClone(first);
  assert.equal(calls.consume('ses_two', second), 'call_two');
  assert.equal(calls.consume('ses_one', first), 'call_one');
  assert.throws(() => calls.consume('ses_one', replay), /call_unbound/);
  assert.throws(() => calls.consume('ses_one', input()), /call_unbound/);
});

test('altered native arguments, spoofed capability and wrong sessions cannot authorize a write', () => {
  const calls = new OperatorWriteCalls();
  const altered = input();
  calls.prepare({ sessionID: 'ses_one', callID: 'call_one' }, altered);
  altered.content = 'Expanded scope';
  assert.throws(() => calls.consume('ses_one', altered), /call_unbound/);
  const other = input();
  calls.prepare({ sessionID: 'ses_one', callID: 'call_other' }, other);
  assert.throws(() => calls.consume('ses_foreign', other), /call_unbound/);
  assert.throws(() => calls.consume('ses_one', { ...input(), onionsoupWriteCall: 'invented' }), /call_unbound/);
});

test('an expired before-hook capability cannot survive a stalled native invocation', context => {
  context.mock.timers.enable({ apis: ['Date'] });
  const calls = new OperatorWriteCalls();
  const args = input();
  calls.prepare({ sessionID: 'ses_one', callID: 'call_one' }, args);
  context.mock.timers.tick(60_001);
  assert.throws(() => calls.consume('ses_one', args), /call_unbound/);
});

test('check capabilities bind the exact check ID and cannot cross the write capability namespace', () => {
  const checks = new OperatorCheckCalls();
  const writes = new OperatorWriteCalls();
  const first = { checkID: 'unit' };
  checks.prepare({ sessionID: 'ses_one', callID: 'call_check' }, first);
  const replay = structuredClone(first);
  assert.equal(checks.consume('ses_one', first), 'call_check');
  assert.throws(() => checks.consume('ses_one', replay), /call_unbound/);
  const changed = { checkID: 'unit' };
  checks.prepare({ sessionID: 'ses_one', callID: 'call_changed' }, changed);
  changed.checkID = 'unapproved';
  assert.throws(() => checks.consume('ses_one', changed), /call_unbound/);
  const file: ReturnType<typeof input> & Record<string, unknown> = input();
  writes.prepare({ sessionID: 'ses_one', callID: 'call_file' }, file);
  assert.throws(() => checks.consume('ses_one', { checkID: 'unit', onionsoupCheckCall: file.onionsoupWriteCall }), /call_unbound/);
  assert.equal(writes.consume('ses_one', file), 'call_file');
});
