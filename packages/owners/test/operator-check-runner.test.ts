import assert from 'node:assert/strict';
import childProcess, { type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OPERATOR_CHECK_LIMITS } from '../src/operator-check-types.ts';
import { OPERATOR_CHECK_RUNNER_LIMITS, preflightOperatorCheck, runOperatorCheck,
  validateOperatorCheckInput } from '../src/operator-check-runner.ts';
import { resolveOperatorWriterNode } from '../src/operator-write-writer.ts';

function file(path: string, content: string) { return { path, content: Buffer.from(content), mode: 0o100644 }; }
const passing = file('sum.test.mjs', `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sum} from './sum.mjs';
test('new sum module regression', () => assert.equal(sum(2, 3), 5));`);
const module = file('sum.mjs', 'export const sum = (left, right) => left + right;');

test('real isolated Node runs a new module and regression test, and reports an ordinary failure', async () => {
  const passed = await runOperatorCheck(['node', '--test', passing.path], [module, passing]);
  assert.equal(passed.exitCode, 0, passed.output);
  assert.match(passed.output, /new sum module regression/);
  assert.equal(passed.outputTruncated, false);
  const failed = await runOperatorCheck(['node', '--test', passing.path], [
    file(module.path, 'export const sum = () => 0;'), passing]);
  assert.equal(failed.exitCode, 1, failed.output);
  assert.match(failed.output, /ERR_ASSERTION|AssertionError/);
});

test('input rejects flags, globs, missing tests, duplicate paths and source escapes before executing', async () => {
  for (const command of [['sh', '-c', 'true'], ['node', '--test'], ['node', '--test', '--eval=1'],
    ['node', '--test', '../escape.mjs'], ['node', '--test', '*.mjs'], ['node', '--test', '/tmp/test.mjs']]) {
    assert.throws(() => validateOperatorCheckInput(command, [module, passing]), /operator_check_command_invalid/);
    assert.equal((await runOperatorCheck(command, [module, passing])).exitCode, 125);
  }
  for (const path of ['../escape', '/escape', 'a/../../escape', '.git/config', 'a/.git/config', 'a\\escape']) {
    assert.throws(() => validateOperatorCheckInput(['node', '--test', passing.path], [passing, file(path, '')]), /operator_check_source_invalid/);
  }
  assert.throws(() => validateOperatorCheckInput(['node', '--test', passing.path], [passing, passing]), /operator_check_source_invalid/);
  assert.throws(() => validateOperatorCheckInput(['node', '--test', passing.path], [module]), /operator_check_test_missing/);
  assert.throws(() => validateOperatorCheckInput(['node', '--test', passing.path], [{ ...passing, mode: 0o120777 }]), /operator_check_source_invalid/);
});

test('synchronous pre-intent validation accepts safe regular modes and literal source names, rejects special modes and path conflicts', () => {
  for (const mode of [0o600, 0o100600, 0o444, 0o100444, 0o664, 0o100755]) {
    assert.deepEqual(validateOperatorCheckInput(['node', '--test', passing.path], [
      { ...passing, mode }, file('-literal[?]*.txt', 'literal source')]), ['node', '--test', passing.path]);
  }
  for (const mode of [0o104644, 0o102644, 0o101644, 0o120777, 0o40644, 0o20644, -1, 0x100000000, 1.5]) {
    assert.throws(() => validateOperatorCheckInput(['node', '--test', passing.path], [{ ...passing, mode }]),
      /operator_check_source_invalid/);
  }
  assert.throws(() => validateOperatorCheckInput(['node', '--test', '-literal[?]*.txt'], [file('-literal[?]*.txt', '')]),
    /operator_check_command_invalid/);
  assert.throws(() => validateOperatorCheckInput(['node', '--test', passing.path], [passing, file('a', ''), file('a/b', '')]),
    /operator_check_source_invalid/);
});

test('real checks read mode0600 creations and literal special source filenames through the readonly snapshot', async () => {
  await preflightOperatorCheck();
  const literal = file('-literal[?]*.txt', 'literal source');
  const restrictive = file('restrictive.test.mjs', `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {sum} from './sum.mjs';
test('private new files', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(readFileSync('./-literal[?]*.txt', 'utf8'), 'literal source');
  assert.throws(() => writeFileSync('./sum.mjs', 'changed'), {code:'EROFS'});
});`);
  const checked = await runOperatorCheck(['node', '--test', restrictive.path], [
    { ...module, mode: 0o100600 }, { ...restrictive, mode: 0o600 }, literal]);
  assert.equal(checked.exitCode, 0, checked.output);
  assert.match(checked.output, /private new files/);
});

test('real sandbox hides host markers, original checkout, inherited environment and network; source and root are readonly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-check-host-fixture-'));
  const marker = join(directory, 'fake-credential-marker');
  await writeFile(marker, 'fake fixture only');
  const server = createServer(connection => connection.end('fake fixture network'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previous = process.env.OPERATOR_CHECK_FAKE_SECRET;
  process.env.OPERATOR_CHECK_FAKE_SECRET = 'fake fixture only';
  try {
    const isolation = file('isolation.test.mjs', `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {connect} from 'node:net';
test('host isolation', async () => {
  assert.throws(() => readFileSync(${JSON.stringify(marker)}));
  assert.throws(() => writeFileSync(${JSON.stringify(marker)}, 'changed'));
  assert.throws(() => writeFileSync('/workspace/sum.mjs', 'changed'), {code:'EROFS'});
  assert.throws(() => writeFileSync('/root-write-probe', 'changed'), {code:'EROFS'});
  assert.throws(() => writeFileSync('/dev/extra-file', 'changed'), {code:'EROFS'});
  assert.equal(existsSync('/workspace/.git'), false);
  assert.equal(existsSync('/home'), false);
  assert.equal(existsSync('/var/home'), false);
  assert.equal(existsSync('/etc'), false);
  assert.equal(process.env.OPERATOR_CHECK_FAKE_SECRET, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.equal(process.env.HTTPS_PROXY, undefined);
  assert.equal(spawnSync('/bin/sh', ['-c', 'true']).error?.code, 'ENOENT');
  writeFileSync('/tmp/private', 'allowed');
  assert.equal(readFileSync('/tmp/private', 'utf8'), 'allowed');
  await new Promise((resolve, reject) => {
    const socket = connect(${address.port}, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); reject(Error('host network reachable')); });
    socket.once('error', resolve);
    socket.setTimeout(2000, () => { socket.destroy(); reject(Error('network check timed out')); });
  });
});`);
    const checked = await runOperatorCheck(['node', '--test', isolation.path], [module, isolation]);
    assert.equal(checked.exitCode, 0, checked.output);
    assert.equal(await readFile(marker, 'utf8'), 'fake fixture only');
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_CHECK_FAKE_SECRET;
    else process.env.OPERATOR_CHECK_FAKE_SECRET = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('sandbox supports a staged runner and pinned Node under tmp without mounting the staging directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-check-staged-'));
  const previous = process.env.ONIONSOUP_HOST_NODE;
  try {
    for (const name of ['operator-check-runner.ts', 'operator-check-types.ts', 'operator-write-writer.ts']) {
      await cp(new URL(`../src/${name}`, import.meta.url), join(directory, name));
    }
    await symlink(fileURLToPath(new URL('../src/sandbox.ts', import.meta.url)), join(directory, 'sandbox.ts'));
    await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(directory, 'node_modules'));
    const node = join(directory, 'node');
    await copyFile(await resolveOperatorWriterNode(), node, constants.COPYFILE_FICLONE);
    await chmod(node, 0o755);
    const api = await import(pathToFileURL(join(directory, 'operator-check-runner.ts')).href);
    process.env.ONIONSOUP_HOST_NODE = node;
    const checked = await api.runOperatorCheck(['node', '--test', passing.path], [module, passing]);
    assert.equal(checked.exitCode, 0, checked.output);
  } finally {
    if (previous === undefined) delete process.env.ONIONSOUP_HOST_NODE;
    else process.env.ONIONSOUP_HOST_NODE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner bounds captured output without killing a successful test', async () => {
  const noisy = file('noisy.test.mjs', `console.log('x'.repeat(${OPERATOR_CHECK_LIMITS.outputChars * 2}));`);
  const checked = await runOperatorCheck(['node', '--test', noisy.path], [noisy]);
  assert.equal(checked.exitCode, 0);
  assert.equal(checked.output.length, OPERATOR_CHECK_LIMITS.outputChars);
  assert.equal(checked.outputTruncated, true);
});

async function fixtureProcesses(marker: string) {
  const entries = await readdir('/proc');
  const processes = await Promise.all(entries.filter(entry => /^\d+$/.test(entry)).map(async pid => {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    return command.includes(marker) ? pid : undefined;
  }));
  return processes.filter(Boolean);
}

test('PID namespace reaps a detached subprocess before a successful check returns', async () => {
  const marker = `operator-check-daemon-${crypto.randomUUID()}`;
  const daemon = file('daemon.test.mjs', `import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => {}, 1000); // ${marker}`)}],
  {detached:true, stdio:'ignore'});
child.unref();`);
  const checked = await runOperatorCheck(['node', '--test', daemon.path], [daemon]);
  assert.equal(checked.exitCode, 0, checked.output);
  assert.deepEqual(await fixtureProcesses(marker), []);
});

test('timeout kills and waits for the isolated process tree, leaving no fixture subprocess', async () => {
  const previous = OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs;
  const marker = `operator-check-timeout-${crypto.randomUUID()}`;
  const hangs = file('hangs.test.mjs', `import {spawn} from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => {}, 1000); // ${marker}`)}],
  {detached:true, stdio:'ignore'}).unref();
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`);
  try {
    OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = 1_500;
    const checked = await runOperatorCheck(['node', '--test', hangs.path], [hangs]);
    assert.equal(checked.exitCode, 124);
    assert.match(checked.output, /operator_check_timeout/);
    assert.deepEqual(await fixtureProcesses(marker), []);
  } finally { OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = previous; }
});

test('known pre-spawn snapshot and runtime failures complete with125 without leaking host error paths', async () => {
  const previousTemporary = process.env.TMPDIR;
  const previousNode = process.env.ONIONSOUP_HOST_NODE;
  const privatePath = join(tmpdir(), `operator-check-private-${crypto.randomUUID()}`);
  try {
    process.env.TMPDIR = privatePath;
    const missingDirectory = await runOperatorCheck(['node', '--test', passing.path], [module, passing]);
    assert.equal(missingDirectory.exitCode, 125);
    assert.equal(missingDirectory.output, '[operator_check_setup_failed]\n');
    assert.ok(!missingDirectory.output.includes(privatePath));
    if (previousTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporary;
    const invalidComponent = await runOperatorCheck(['node', '--test', passing.path], [module, passing,
      file('x'.repeat(300), 'too long for the snapshot filesystem')]);
    assert.equal(invalidComponent.exitCode, 125);
    assert.equal(invalidComponent.output, '[operator_check_setup_failed]\n');
    process.env.ONIONSOUP_HOST_NODE = join(privatePath, 'node');
    const missingRuntime = await runOperatorCheck(['node', '--test', passing.path], [module, passing]);
    assert.equal(missingRuntime.exitCode, 125);
    assert.equal(missingRuntime.output, '[operator_check_setup_failed]\n');
  } finally {
    if (previousTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporary;
    if (previousNode === undefined) delete process.env.ONIONSOUP_HOST_NODE;
    else process.env.ONIONSOUP_HOST_NODE = previousNode;
  }
});

test('a real check whose process-group exit cannot be proved still rejects as uncertain', async context => {
  const originalKill = process.kill.bind(process);
  context.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (pid < 0 && signal === 0) throw Object.assign(new Error('fixture denies group observation'), { code: 'EPERM' });
    return originalKill(pid, signal);
  });
  await assert.rejects(runOperatorCheck(['node', '--test', passing.path], [module, passing]), /operator_check_process_uncertain/);
});

test('a missing launch executable has no process and completes with125', async context => {
  const originalSpawn = childProcess.spawn;
  const missingExecutable = join(tmpdir(), `operator-check-missing-launch-${crypto.randomUUID()}`);
  const override = context.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[], options: SpawnOptions) =>
    originalSpawn(missingExecutable, args, options));
  syncBuiltinESMExports();
  try {
    const checked = await runOperatorCheck(['node', '--test', passing.path], [module, passing]);
    assert.equal(checked.exitCode, 125);
    assert.equal(checked.output, '[operator_check_launch_failed]\n');
    assert.ok(!checked.output.includes(missingExecutable));
  } finally {
    override.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an isolated test runner killed by signal completes with a nonzero exit after its namespace stops', async () => {
  const killed = file('killed.test.mjs', `process.kill(process.ppid, 'SIGKILL');`);
  const checked = await runOperatorCheck(['node', '--test', killed.path], [killed]);
  assert.equal(checked.exitCode, 137, checked.output);
});
