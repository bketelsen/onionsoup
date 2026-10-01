import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperatorCheckCommand, OperatorCheckRecord, operatorCheckKind, operatorCheckRecordDigest } from '../src/operator-check-types.ts';

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
