import assert from 'node:assert/strict';
import childProcess, { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import filesystem, { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { inspectOperatorCheckOwner, inspectOperatorCheckWitness, operatorCheckProcessIdentity,
  readOperatorCheckOwner, OperatorCheckWitness, type OperatorCheckOwner } from '../src/operator-check-execution.ts';
import { OPERATOR_CHECK_RUNNER_LIMITS, runOperatorCheck } from '../src/operator-check-runner.ts';
import { resolveOperatorWriterNode } from '../src/operator-write-writer.ts';

function source(content: string, path = 'guard.test.mjs') { return { path, content: Buffer.from(content), mode: 0o100644 }; }

function intercept(context: TestContext, observe: (child: childProcess.ChildProcess, args: readonly string[]) => void) {
  const original = childProcess.spawn;
  const override = context.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = original(command, args, options);
    observe(child, args);
    return child;
  });
  syncBuiltinESMExports();
  return () => { override.mock.restore(); syncBuiltinESMExports(); };
}

test('guarded real check persists its exact namespace witness before executing and later proves stopped', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-execution-'));
  const path = join(directory, 'witness.json');
  let output = '';
  let witness: OperatorCheckWitness | undefined;
  const restore = intercept(context, child => { child.stdout?.on('data', chunk => { output += String(chunk); }); });
  try {
    const checked = await runOperatorCheck(['node', '--test', 'guard.test.mjs'], [source('console.log("PERMITTED_PAYLOAD");')], {
      onWitness: async identity => {
        assert.equal(output, '');
        witness = OperatorCheckWitness.parse(identity);
        assert.equal((await inspectOperatorCheckWitness(witness)).state, 'running');
        await writeFile(path, JSON.stringify(witness), { flag: 'wx', mode: 0o600 });
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), witness);
        assert.equal(output, '');
      },
    });
    assert.equal(checked.exitCode, 0, checked.output);
    assert.match(checked.output, /PERMITTED_PAYLOAD/);
    assert.ok(witness);
    const observation = await inspectOperatorCheckWitness(witness);
    assert.equal(observation.state, 'stopped');
    assert.deepEqual(observation.proof?.namespace, witness.namespace);
    assert.deepEqual(observation.proof?.owner, witness.owner);
  } finally { restore(); }
});

test('a failed durable witness write never permits the isolated payload', async () => {
  let witness: OperatorCheckWitness | undefined;
  const checked = await runOperatorCheck(['node', '--test', 'guard.test.mjs'], [source('console.log("UNPERMITTED_PAYLOAD");')], {
    onWitness: async identity => { witness = identity; throw new Error('fixture durable write failed'); },
  });
  assert.equal(checked.exitCode, 125, checked.output);
  assert.equal(checked.output.includes('UNPERMITTED_PAYLOAD'), false);
  assert.ok(witness);
  assert.equal((await inspectOperatorCheckWitness(witness)).state, 'stopped');
});

test('closing both launch pipes as on host death executes only the trusted guard, never the payload', async context => {
  let child: childProcess.ChildProcess | undefined;
  let barrier: Duplex | undefined;
  let output = '';
  let witness: OperatorCheckWitness | undefined;
  const restore = intercept(context, (launched, args) => {
    child = launched;
    barrier = launched.stdio[Number(args[args.indexOf('--block-fd') + 1])] as Duplex;
    launched.stdout?.on('data', chunk => { output += String(chunk); });
  });
  try {
    const checked = await runOperatorCheck(['node', '--test', 'guard.test.mjs'], [source('console.log("EOF_EXECUTED_PAYLOAD");')], {
      onWitness: async identity => {
        witness = identity;
        const closed = once(child!, 'close');
        child!.stdin!.end();
        barrier!.end();
        await closed;
        throw new Error('fixture owner lost before durable write');
      },
    });
    assert.equal(checked.exitCode, 125, checked.output);
    assert.equal(output.includes('EOF_EXECUTED_PAYLOAD'), false);
    assert.ok(witness);
    assert.equal((await inspectOperatorCheckWitness(witness)).state, 'stopped');
  } finally { restore(); }
});

test('a guarded timeout retains a recoverable witness and proves the namespace stopped', async () => {
  const previous = OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs;
  let witness: OperatorCheckWitness | undefined;
  try {
    OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = 600;
    const checked = await runOperatorCheck(['node', '--test', 'guard.test.mjs'], [source('setInterval(()=>{},1000);')], {
      onWitness: async identity => { witness = identity; },
    });
    assert.equal(checked.exitCode, 124, checked.output);
    assert.ok(witness);
    assert.equal((await inspectOperatorCheckWitness(witness)).state, 'stopped');
  } finally { OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = previous; }
});

test('a permit pipe failure while durable witness acknowledgment is pending denies execution', async context => {
  let child: childProcess.ChildProcess | undefined;
  let witness: OperatorCheckWitness | undefined;
  const restore = intercept(context, launched => { child = launched; });
  try {
    const checked = await runOperatorCheck(['node', '--test', 'guard.test.mjs'], [source('console.log("BROKEN_PERMIT_PAYLOAD");')], {
      onWitness: async identity => {
        witness = identity;
        const closed = once(child!, 'close');
        child!.stdin!.destroy(Object.assign(new Error('fixture permit pipe failure'), { code: 'EPIPE' }));
        await closed;
      },
    });
    assert.equal(checked.exitCode, 125, checked.output);
    assert.equal(checked.output.includes('BROKEN_PERMIT_PAYLOAD'), false);
    assert.ok(witness);
    assert.equal((await inspectOperatorCheckWitness(witness)).state, 'stopped');
  } finally { restore(); }
});

test('owner inspection requires exact live identity and same boot and PID domain', async () => {
  const owner = await readOperatorCheckOwner();
  assert.equal((await inspectOperatorCheckOwner(owner)).state, 'running');
  assert.equal((await inspectOperatorCheckOwner({ ...owner, started: '0' })).state, 'foreign');
  assert.equal((await inspectOperatorCheckOwner({ ...owner, bootID: randomUUID() })).state, 'foreign');
  assert.equal((await inspectOperatorCheckOwner({ ...owner, pidNamespace: 'pid:[0]' })).state, 'foreign');
});

test('a separately owned fixture process must disappear before its owner record proves stopped', async () => {
  const current = await readOperatorCheckOwner();
  const child = spawn(await resolveOperatorWriterNode(), ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    const identity = operatorCheckProcessIdentity(await readFile(`/proc/${child.pid}/stat`, 'utf8'));
    const owner: OperatorCheckOwner = { ...current, pid: identity.pid, started: identity.started };
    assert.equal((await inspectOperatorCheckOwner(owner)).state, 'running');
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
    const inspection = await inspectOperatorCheckOwner(owner);
    assert.equal(inspection.state, 'stopped');
    assert.deepEqual(inspection.proof?.owner, owner);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('recovery inspection refuses inaccessible proc state and never treats a zombie as stopped', async context => {
  const owner = await readOperatorCheckOwner();
  const original = filesystem.readFile;
  let deny = false;
  const override = context.mock.method(filesystem, 'readFile', async (...args: Parameters<typeof filesystem.readFile>) => {
    const path = String(args[0]);
    if (/^\/proc\/self\/fd\/\d+\/stat$/.test(path)) {
      if (deny) throw Object.assign(new Error('fixture proc denied'), { code: 'EACCES' });
      const stat = String(await original(...args));
      const position = stat.lastIndexOf(') ') + 2;
      return `${stat.slice(0, position)}Z${stat.slice(position + 1)}`;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await inspectOperatorCheckOwner(owner)).state, 'running');
    deny = true;
    assert.equal((await inspectOperatorCheckOwner(owner)).state, 'unavailable');
  } finally { override.mock.restore(); syncBuiltinESMExports(); }
});

test('guarded Go uses the host-pinned Node guard while retaining exact Go runtime evidence', async () => {
  let witness: OperatorCheckWitness | undefined;
  const checked = await runOperatorCheck(['go', 'test', './...'], [
    source('module example.invalid/guard\n\ngo 1.25.0\n', 'go.mod'),
    source('package guard\nimport "testing"\nfunc TestGuard(t *testing.T) {}\n', 'guard_test.go'),
  ], { onWitness: async identity => { witness = identity; } });
  assert.equal(checked.exitCode, 0, checked.output);
  assert.equal(checked.runtime?.kind, 'go');
  assert.ok(witness);
  assert.equal((await inspectOperatorCheckWitness(witness)).state, 'stopped');
});

async function eventually<T>(observe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed !== undefined) return observed;
    await delay(20);
  }
  assert.fail('fixture observation did not arrive');
}

async function crashFixture(permit: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'operator-guard-crash-'));
  const script = join(directory, 'owner.mjs');
  const diagnostic = join(directory, 'diagnostic-witness.json');
  const output = join(directory, 'stdout.log');
  const runnerURL = new URL('../src/operator-check-runner.ts', import.meta.url).href;
  await writeFile(script, `import childProcess from 'node:child_process';
import {openSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const capture = openSync(${JSON.stringify(output)}, 'a', 0o600);
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command,args,options) => originalSpawn(command,args,
  {...options,stdio:options.stdio.map((fd,index)=>index===1?capture:fd)});
syncBuiltinESMExports();
const {runOperatorCheck} = await import(${JSON.stringify(runnerURL)});
await runOperatorCheck(['node','--test','crash.test.mjs'],
  [{path:'crash.test.mjs',mode:420,content:Buffer.from('console.log("CRASH_FIXTURE_PAYLOAD");setInterval(()=>{},1000);')}],
  {onWitness:async witness=>{
    await writeFile(${JSON.stringify(diagnostic)},JSON.stringify(witness));
    ${permit ? '' : 'await new Promise(()=>{});'}
  }});
`);
  const owner = spawn(await resolveOperatorWriterNode(), ['--conditions=onionsoup-source', '--import',
    fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)), script], { stdio: 'ignore' });
  return { owner, diagnostic, output };
}

for (const scenario of [{ name: 'before durable witness acknowledgment', permit: false }, { name: 'after explicit execution permit', permit: true }]) {
  test(`real owner crash ${scenario.name} leaves a positively stopped guarded namespace`, async () => {
    const fixture = await crashFixture(scenario.permit);
    try {
      const witness = await eventually(async () => {
        try { return OperatorCheckWitness.parse(JSON.parse(await readFile(fixture.diagnostic, 'utf8'))); }
        catch { return undefined; }
      });
      assert.equal((await inspectOperatorCheckWitness(witness)).state, 'running');
      if (scenario.permit) await eventually(async () =>
        (await readFile(fixture.output, 'utf8')).includes('CRASH_FIXTURE_PAYLOAD') ? true : undefined);
      const closed = once(fixture.owner, 'close');
      fixture.owner.kill('SIGKILL');
      await closed;
      assert.equal((await inspectOperatorCheckOwner(witness.owner)).state, 'stopped');
      await eventually(async () => (await inspectOperatorCheckWitness(witness)).state === 'stopped' ? true : undefined);
      assert.equal((await readFile(fixture.output, 'utf8')).includes('CRASH_FIXTURE_PAYLOAD'), scenario.permit);
    } finally {
      if (fixture.owner.exitCode === null && fixture.owner.signalCode === null) {
        const closed = once(fixture.owner, 'close');
        fixture.owner.kill('SIGKILL');
        await closed;
      }
    }
  });
}
