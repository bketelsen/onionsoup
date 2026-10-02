import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPERATOR_CHECK_LIMITS, OperatorCheckCommand, OperatorCheckRecord, operatorCheckKind, operatorCheckRecordDigest } from '../src/operator-check-types.ts';

test('native checks accept only bounded exact Node tests and local Go test or vet targets', () => {
  for (const [command, kind] of [
    [['node', '--test', 'test/unit.test.mjs'], 'node-test'],
    [['go', 'test', './...'], 'go-test'],
    [['go', 'vet', './pkg', './internal/...'], 'go-vet'],
  ] as const) {
    const parsed = OperatorCheckCommand.parse([...command]);
    assert.equal(operatorCheckKind(parsed), kind);
  }
  for (const command of [
    ['go', 'test'], ['go', 'build', './...'], ['go', 'install', './...'],
    ['go', 'test', '-exec=sh', './...'], ['go', 'test', '-C', '/tmp'],
    ['go', 'test', '../outside'], ['go', 'test', '/tmp/repo'], ['go', 'test', 'example.test/external'],
    ['go', 'test', './pkg/../../outside'], ['go', 'test', './.git'], ['go', 'test', './pkg/*'],
    ['go', 'test', './pkg/../other'], ['go', 'test', './pkg\\escape'], ['go', 'test', './pkg\n'],
    ['go', 'test', ...Array(9).fill('./pkg')], ['npm', 'test', '--silent'], ['sh', '-c', 'go test ./...'],
  ]) assert.equal(OperatorCheckCommand.safeParse(command).success, false, JSON.stringify(command));
});

test('Go command evidence is parsed canonically and binds exact verb and package scope', () => {
  const record = OperatorCheckRecord.parse({ id: 'check_go', checkID: 'unit', command: ['go', 'test', './...'],
    callID: 'call_go', messageID: 'msg_go', artifactDigest: 'a'.repeat(64), status: 'completed',
    startedAt: 'start', completedAt: 'end', exitCode: 0, output: 'ok', digest: 'b'.repeat(64) });
  const digest = operatorCheckRecordDigest(record);
  const runtime = { kind: 'go' as const, version: 'go1.25.8', binarySha256: 'c'.repeat(64) };
  assert.notEqual(operatorCheckRecordDigest({ ...record, runtime }), digest);
  assert.notEqual(operatorCheckRecordDigest({ ...record, runtime: { ...runtime, version: 'go1.25.7' } }),
    operatorCheckRecordDigest({ ...record, runtime }));
  assert.notEqual(operatorCheckRecordDigest({ ...record, command: ['go', 'vet', './...'] }), digest);
  assert.notEqual(operatorCheckRecordDigest({ ...record, command: ['go', 'test', './pkg'] }), digest);
  assert.equal(OperatorCheckRecord.safeParse({ ...record, command: ['go', 'test', '-exec=sh', './...'] }).success, false);
});


test('project commands retain exact arbitrary argv within the disposable runtime boundary', () => {
  for (const command of [
    ['project', 'make', 'check'], ['project', 'mise', 'config', 'ls'], ['project', 'svu', 'next'],
    ['project', 'sh', '-c', 'make help && make check'], ['project', './scripts/validate.sh'],
    ['project', 'node', '-e', 'console.log("literal argument")'],
  ]) {
    assert.deepEqual(OperatorCheckCommand.parse(command), command);
    assert.equal(operatorCheckKind(command), 'project');
  }
  for (const command of [[], ['constructor', 'x'], ['toString', 'x'], ['__proto__', 'x'], ['project'], ['project', ''], ['project', 'sh', 'bad\0argument'],
    ['project', 'sh', 'x'.repeat(OPERATOR_CHECK_LIMITS.projectArgumentChars + 1)],
    ['project', 'sh', ...Array(OPERATOR_CHECK_LIMITS.projectArguments).fill('arg')],
    ['project', 'sh', ...Array(5).fill('x'.repeat(OPERATOR_CHECK_LIMITS.projectArgumentChars))],
  ]) assert.equal(OperatorCheckCommand.safeParse(command).success, false);
});

test('project receipts bind exact approved command, snapshot and selected runtime bytes', () => {
  const runtime = { kind: 'project' as const, profileSha256: 'c'.repeat(64),
    tools: [{ name: '/runtime/bin/make', binarySha256: 'd'.repeat(64) }] };
  const record = OperatorCheckRecord.parse({ id: 'check_project', checkID: 'check', command: ['project', 'make', 'check'],
    callID: 'call_project', messageID: 'msg_project', artifactDigest: 'a'.repeat(64), status: 'completed',
    startedAt: 'start', completedAt: 'end', exitCode: 0, output: 'ok', digest: 'b'.repeat(64), runtime });
  const digest = operatorCheckRecordDigest(record);
  for (const changed of [
    { ...record, command: ['project', 'make', 'help'] },
    { ...record, artifactDigest: 'e'.repeat(64) },
    { ...record, runtime: { ...runtime, profileSha256: 'e'.repeat(64) } },
    { ...record, runtime: { ...runtime, tools: [{ ...runtime.tools[0]!, binarySha256: 'e'.repeat(64) }] } },
  ]) assert.notEqual(operatorCheckRecordDigest(changed), digest);
});
