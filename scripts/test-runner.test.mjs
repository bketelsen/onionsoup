import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./test.mjs', import.meta.url));
const workflow = await readFile(new URL('../.github/workflows/verify.yaml', import.meta.url), 'utf8');
const shards = JSON.parse(workflow.match(/shard: (\[[^\n]+\])/)[1]);

function runnerEnvironment(shard) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.ONIONSOUP_TEST_SHARD;
  if (shard !== undefined) environment.ONIONSOUP_TEST_SHARD = shard;
  return environment;
}

async function run(files, shard, extra = []) {
  try {
    const execution = await exec(process.execPath, [runner, '--test-reporter=tap', ...extra, ...files], {
      env: runnerEnvironment(shard), timeout: 30_000,
    });
    return { ...execution, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return error;
  }
}

async function fixture(context, count = 7) {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-runner-fixture-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const files = [];
  for (let index = 0; index < count; index++) {
    const file = join(directory, `${index}.test.mjs`);
    await writeFile(file, `import test from 'node:test';
      import assert from 'node:assert/strict';
      test('fixture ${index}', () => {
        assert.equal(process.env.ONIONSOUP_TEST_SHARD, undefined);
        console.log('fixture_executed_${index}');
      });`);
    files.push(file);
  }
  return { directory, files };
}

function executions(output) {
  return [...output.matchAll(/^# fixture_executed_(\d+)$/gm)].map(match => Number(match[1]));
}

test('all configured CI shards execute a disjoint complete suite, while default verification executes everything', async context => {
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, index) => index + 1));
  assert.ok(workflow.includes('ONIONSOUP_TEST_SHARD: ${{ matrix.shard }}/' + shards.length));
  const { files } = await fixture(context);
  const executed = [];
  for (const shard of shards) {
    const execution = await run(files, `${shard}/${shards.length}`);
    assert.equal(execution.code, 0, execution.stderr + execution.stdout);
    executed.push(...executions(execution.stdout));
  }
  assert.deepEqual(executed.sort(), files.map((_, index) => index));
  const complete = await run(files);
  assert.equal(complete.code, 0, complete.stderr + complete.stdout);
  assert.deepEqual(executions(complete.stdout).sort(), executed);
});

test('a failing fixture fails its shard and cannot disappear from aggregate verification', async context => {
  const { files } = await fixture(context);
  await writeFile(files[2], "import test from 'node:test'; test('deliberate failure', () => { throw Error('fixture_failure'); });");
  const failed = [];
  for (const shard of shards) {
    const execution = await run(files, `${shard}/${shards.length}`);
    if (execution.code !== 0) {
      assert.match(execution.stdout, /fixture_failure/);
      failed.push(shard);
    }
  }
  assert.equal(failed.length, 1);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /verify:\s+if: \$\{\{ always\(\) \}\}\s+needs: verify-shard/);
  for (const status of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const gate = workflow.match(/run: (test "\$SHARDS_RESULT" = success)/)[1];
    const execution = await exec('/bin/sh', ['-c', gate], { env: { SHARDS_RESULT: status } }).then(
      () => 0, error => error.code,
    );
    assert.equal(execution, status === 'success' ? 0 : 1);
  }
});

test('nested fixture runners execute every file rather than inheriting the outer CI partition', async context => {
  const { directory, files } = await fixture(context);
  const outer = join(directory, 'outer.test.mjs');
  const evidence = join(directory, 'nested-output.txt');
  await writeFile(outer, `import test from 'node:test';
    import { execFileSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    test('nested suite', () => {
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      const output = execFileSync(process.execPath,
        [${JSON.stringify(runner)}, '--test-reporter=tap', ...${JSON.stringify(files)}], { env: environment });
      writeFileSync(${JSON.stringify(evidence)}, output);
    });`);
  const execution = await run([outer], `1/${shards.length}`);
  assert.equal(execution.code, 0, execution.stderr + execution.stdout);
  assert.deepEqual(executions(await readFile(evidence, 'utf8')).sort(), files.map((_, index) => index));
});

test('shard configuration rejects invalid ranges before executing tests', async context => {
  const { files } = await fixture(context, 1);
  for (const shard of ['', '0/4', '5/4', '1/0', '-1/4', '1.5/4', '1/4x', '1/9007199254740992']) {
    const execution = await run(files, shard);
    assert.notEqual(execution.code, 0);
    assert.match(execution.stderr, /test_shard_invalid/);
    assert.deepEqual(executions(execution.stdout), []);
  }
});

test('existing test-name filters remain effective for focused and staging invocations', async context => {
  const { files } = await fixture(context, 2);
  const execution = await run(files, '1/1', ['--test-name-pattern=^fixture 1$']);
  assert.equal(execution.code, 0, execution.stderr + execution.stdout);
  assert.deepEqual(executions(execution.stdout), [1]);
});
