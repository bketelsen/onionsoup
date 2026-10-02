import assert from 'node:assert/strict';
import childProcess, { ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import filesystem from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inheritedCgroupBudget } from '../src/cgroup-budget.ts';
import { alreadyMemoryCapped, OPERATOR_WRITER_LIMITS } from '../src/operator-write-writer.ts';
import { MASKED_HOST_PATHS, sandboxCommand, sandboxEnvironment, spawnSandboxed } from '../src/sandbox.ts';

const coreBudget = { memoryBytes: 6 * 1024 ** 3, tasksMax: 512, swapBytes: 0 };
const root = '/sys/fs/cgroup';

function kernelFiles(membership = '/stage/worker', memory = String(coreBudget.memoryBytes), tasks = '512', swap = '0') {
  return new Map([
    ['/proc/self/cgroup', `0::${membership}\n`],
    [`${root}${membership}/memory.max`, memory],
    [`${root}${membership}/pids.max`, tasks],
    [`${root}${membership}/memory.swap.max`, swap],
  ]);
}

function useKernelFiles(context: TestContext, files: Map<string, string>) {
  const original = filesystem.readFileSync;
  const override = context.mock.method(filesystem, 'readFileSync', (...args: Parameters<typeof original>) => {
    const path = String(args[0]);
    if (path !== '/proc/self/cgroup' && !path.startsWith(`${root}/`)) return original(...args);
    const content = files.get(path);
    if (content === undefined) throw new Error('fixture_kernel_file_unreadable');
    return content;
  });
  syncBuiltinESMExports();
  context.after(() => {
    override.mock.restore();
    syncBuiltinESMExports();
  });
}

test('kernel ancestry proves effective memory, tasks and zero swap at different levels', context => {
  const files = kernelFiles('/stage/worker', 'max', 'max', '0');
  files.set(`${root}/stage/memory.max`, String(coreBudget.memoryBytes));
  files.set(`${root}/stage/pids.max`, '512');
  files.set(`${root}/stage/memory.swap.max`, 'max');
  useKernelFiles(context, files);
  assert.equal(inheritedCgroupBudget(coreBudget), true);
  files.set(`${root}/stage/pids.max`, '513');
  assert.equal(inheritedCgroupBudget(coreBudget), false);
  files.set(`${root}/stage/pids.max`, '512');
  files.set(`${root}/stage/memory.max`, String(coreBudget.memoryBytes + 1));
  assert.equal(inheritedCgroupBudget(coreBudget), false);
});

test('exact and stricter kernel caps are valid; unbounded, higher or missing caps are not proof', context => {
  const files = kernelFiles();
  useKernelFiles(context, files);
  assert.equal(inheritedCgroupBudget(coreBudget), true);
  files.set(`${root}/stage/worker/memory.max`, '1');
  files.set(`${root}/stage/worker/pids.max`, '1');
  assert.equal(inheritedCgroupBudget(coreBudget), true);
  for (const [controller, value] of [
    ['memory.max', 'max'], ['memory.max', String(coreBudget.memoryBytes + 1)],
    ['pids.max', '513'], ['pids.max', 'max'], ['memory.swap.max', '1'], ['memory.swap.max', 'max'],
  ]) {
    const path = `${root}/stage/worker/${controller}`;
    const previous = files.get(path)!;
    files.set(path, value);
    assert.equal(inheritedCgroupBudget(coreBudget), false, `${controller}=${value}`);
    files.set(path, previous);
    files.delete(path);
    assert.equal(inheritedCgroupBudget(coreBudget), false, `missing ${controller}`);
    files.set(path, previous);
  }
});

test('malformed numeric kernel limits cannot become budget evidence', context => {
  const files = kernelFiles();
  useKernelFiles(context, files);
  const malformed = ['', ' ', '-1', '+1', '0x0', '0e0', '0.0', '00', 'NaN', 'Infinity', '9007199254740992', '1\n2'];
  for (const controller of ['memory.max', 'pids.max', 'memory.swap.max']) {
    const path = `${root}/stage/worker/${controller}`;
    const previous = files.get(path)!;
    for (const value of malformed) {
      files.set(path, value);
      assert.equal(inheritedCgroupBudget(coreBudget), false, `${controller}=${JSON.stringify(value)}`);
    }
    files.set(path, previous);
  }
  for (const controller of ['memory.max', 'pids.max']) {
    files.set(`${root}/stage/worker/${controller}`, '0');
    assert.equal(inheritedCgroupBudget(coreBudget), false, `${controller}=0`);
  }
});

test('missing, ambiguous, relative and traversing cgroup memberships fail closed', context => {
  const files = kernelFiles();
  useKernelFiles(context, files);
  for (const membership of [
    '', '1:memory:/stage/worker\n', '0::stage/worker\n', '0::/stage/../worker\n',
    '0::/stage/./worker\n', '0:://stage/worker\n', '0::/stage/worker/\n',
    '0::/stage/\0worker\n', '0::/stage/worker\n0::/stage/worker\n', '0::/\n',
  ]) {
    files.set('/proc/self/cgroup', membership);
    assert.equal(inheritedCgroupBudget(coreBudget), false, JSON.stringify(membership));
  }
  files.delete('/proc/self/cgroup');
  assert.equal(inheritedCgroupBudget(coreBudget), false);
});

test('operator probe keeps its existing optional tasks and outer memory budget without requiring swap', async context => {
  const files = kernelFiles('/stage/worker', String(OPERATOR_WRITER_LIMITS.outerMemoryBytes), 'max', 'max');
  files.delete(`${root}/stage/worker/pids.max`);
  files.delete(`${root}/stage/worker/memory.swap.max`);
  useKernelFiles(context, files);
  assert.equal(await alreadyMemoryCapped(), true);
  assert.equal(await alreadyMemoryCapped(coreBudget.memoryBytes), false);
  assert.equal(await alreadyMemoryCapped(OPERATOR_WRITER_LIMITS.outerMemoryBytes, 512), false);
  files.set(`${root}/stage/worker/pids.max`, '512');
  assert.equal(await alreadyMemoryCapped(OPERATOR_WRITER_LIMITS.outerMemoryBytes, 512), true);
});

test('invalid requested budgets never prove an inherited cap', context => {
  useKernelFiles(context, kernelFiles());
  for (const budget of [
    { ...coreBudget, memoryBytes: 0 }, { ...coreBudget, memoryBytes: Infinity },
    { ...coreBudget, tasksMax: 0 }, { ...coreBudget, tasksMax: 1.5 },
    { ...coreBudget, swapBytes: -1 }, { ...coreBudget, swapBytes: NaN },
  ]) assert.equal(inheritedCgroupBudget(budget), false);
});

async function sandboxFixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'core-budget-'));
  const previousHome = process.env.ONIONSOUP_HOME;
  const previousMarker = process.env.ONIONSOUP_SANDBOX;
  process.env.ONIONSOUP_HOME = directory;
  process.env.ONIONSOUP_SANDBOX = '1';
  context.after(async () => {
    if (previousHome === undefined) delete process.env.ONIONSOUP_HOME;
    else process.env.ONIONSOUP_HOME = previousHome;
    if (previousMarker === undefined) delete process.env.ONIONSOUP_SANDBOX;
    else process.env.ONIONSOUP_SANDBOX = previousMarker;
    await rm(directory, { recursive: true, force: true });
  });
  const options = { cwd: directory, writable: [directory], env: { ONIONSOUP_SANDBOX: 'forged' } };
  const original = childProcess.spawn;
  const launched: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const override = context.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    launched.push({ command, args, options: spawnOptions });
    return original('/usr/bin/true', [], spawnOptions);
  });
  syncBuiltinESMExports();
  context.after(() => {
    override.mock.restore();
    syncBuiltinESMExports();
  });
  return { options, launched, scopedArgs: sandboxCommand('sh', ['-c', 'true'], options) };
}

test('core inherited spawn preserves its synchronous child, exact bwrap boundaries and environment', async context => {
  useKernelFiles(context, kernelFiles());
  const { options, launched, scopedArgs } = await sandboxFixture(context);
  const nested = spawnSandboxed('sh', ['-c', 'true'], options);
  assert.ok(nested instanceof ChildProcess);
  await once(nested, 'close');
  assert.equal(launched[0]!.command, 'bwrap');
  assert.deepEqual(launched[0]!.args, scopedArgs.slice(scopedArgs.indexOf('bwrap') + 1));
  assert.deepEqual(launched[0]!.options.env, sandboxEnvironment(options.env));
});

test('sandbox prepares fixed mask mountpoints before constructing the unchanged read-only root', async context => {
  const { options } = await sandboxFixture(context);
  const created: string[] = [];
  const original = filesystem.mkdirSync;
  const override = context.mock.method(filesystem, 'mkdirSync', (...args: Parameters<typeof original>) => {
    created.push(String(args[0]));
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const argv = sandboxCommand('true', [], options);
    for (const masked of MASKED_HOST_PATHS) {
      assert.ok(created.includes(masked));
      assert.ok(argv.includes(masked));
    }
    assert.deepEqual(argv.slice(argv.indexOf('--ro-bind'), argv.indexOf('--ro-bind') + 3), ['--ro-bind', '/', '/']);
  } finally {
    override.mock.restore();
    syncBuiltinESMExports();
  }
});

test('forged inherited and caller environment cannot bypass the original systemd scope', async context => {
  const files = kernelFiles();
  useKernelFiles(context, files);
  const { options, launched, scopedArgs } = await sandboxFixture(context);
  for (const [controller, value] of [
    ['memory.max', String(coreBudget.memoryBytes + 1)], ['pids.max', '513'], ['memory.swap.max', '1'],
    ['memory.max', 'max'], ['pids.max', ''], ['memory.swap.max', 'invalid'],
  ]) {
    const path = `${root}/stage/worker/${controller}`;
    const previous = files.get(path)!;
    files.set(path, value);
    const scoped = spawnSandboxed('sh', ['-c', 'true'], options);
    await once(scoped, 'close');
    assert.equal(launched.at(-1)!.command, 'systemd-run', `${controller}=${value}`);
    assert.deepEqual(launched.at(-1)!.args, scopedArgs);
    assert.deepEqual(launched.at(-1)!.options.env, sandboxEnvironment(options.env));
    files.set(path, previous);
  }
});
