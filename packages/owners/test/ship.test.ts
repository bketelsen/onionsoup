import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Runtime } from '../src/runtime.ts';
import { SHIP_LIMITS, shipEngine, type ShipExecution } from '../src/ship.ts';
import { git } from '../src/workspace.ts';

const run = promisify(execFile);
const outputs = ['packages/owners/dist', 'packages/surface/dist', 'packages/surface/web/dist'];

async function writeRevision(directory: string, revision: string) {
  await writeFile(join(directory, 'revision'), revision);
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-qm', revision]);
  return (await git(directory, ['rev-parse', 'HEAD'])).trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'owners-ship-'));
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  await mkdir(source);
  await git(source, ['init', '-qb', 'main']);
  await git(source, ['config', 'user.email', 'test@example.test']);
  await git(source, ['config', 'user.name', 'Test']);
  await writeFile(join(source, '.gitignore'), 'packages/\nnode_modules/\n');
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'ship-fixture', version: '1.0.0', scripts: {
      build: 'node build.cjs engine', 'surface:build': 'node build.cjs web', verify: 'node build.cjs all',
    },
  }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({
    name: 'ship-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'ship-fixture', version: '1.0.0' } },
  }));
  await writeFile(join(source, 'build.cjs'), `
const fs = require('node:fs');
const revision = fs.readFileSync('revision', 'utf8');
if (revision === 'old' && process.env.SERVICE_STATE) {
  if (fs.readFileSync(process.env.SERVICE_STATE, 'utf8').trim() !== 'stopped') process.exit(3);
}
const paths = ${JSON.stringify(outputs)};
for (const path of paths) {
  if (process.argv[2] === 'engine' && path.includes('/web/')) continue;
  if (process.argv[2] === 'web' && !path.includes('/web/')) continue;
  fs.rmSync(path, { recursive: true, force: true });
  fs.mkdirSync(path, { recursive: true });
  fs.writeFileSync(path + '/version', revision);
}
if (process.env.FAIL_REBUILD === '1' && revision === 'old') process.exit(2);
`);
  const previous = await writeRevision(source, 'old');
  await git(root, ['clone', '-q', source, checkout]);
  await run(process.execPath, ['build.cjs', 'all'], { cwd: checkout });
  await writeRevision(source, 'new');
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  await runtime.notebook('clippy').ensure('# Charter\n');
  const owner = runtime.declarations.owners.get('clippy')!;
  runtime.declarations.owners.set('clippy', { ...owner, deploy: { checkout, services: ['fixture.service'] } });
  return { root, checkout, previous, runtime };
}

async function artifactVersions(checkout: string) {
  return Promise.all(outputs.map(path => readFile(join(checkout, path, 'version'), 'utf8')));
}

async function journal(runtime: Runtime) {
  const directory = join(runtime.notebook('clippy').directory, 'journal');
  return (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('');
}

function localExecution(overrides: Partial<ShipExecution> = {}): ShipExecution {
  return {
    sandbox: async (command, args, options) => {
      try {
        const completed = await run(command, [...args], { cwd: options.cwd });
        return { exitCode: 0, output: completed.stdout };
      } catch (error) {
        return { exitCode: 1, output: String(error) };
      }
    },
    schedule: async () => undefined,
    ...overrides,
  };
}

test('verification failure restores previous source and rebuilds all ignored deployment artifacts', async () => {
  const { checkout, previous, runtime } = await repositoryFixture();
  const execution = localExecution();
  const result = await shipEngine(runtime, 'clippy', localExecution({
    sandbox: async (command, args, options) => {
      const completed = await execution.sandbox(command, args, options);
      return args.includes('verify') ? { exitCode: 1, output: 'verification failed after build' } : completed;
    },
    schedule: async () => assert.fail('must not schedule a failed release'),
  }));
  assert.equal(result.outcome, 'failed');
  assert.match(result.summary, /restored .* and rebuilt its artifacts/);
  assert.equal((await git(checkout, ['rev-parse', 'HEAD'])).trim(), previous);
  assert.deepEqual(await artifactVersions(checkout), ['old', 'old', 'old']);
  assert.match(await journal(runtime), /attention.*verification failed after build/);
});

test('failed rollback rebuild is reported rather than claimed restored', async () => {
  const { runtime } = await repositoryFixture();
  const execution = localExecution();
  const result = await shipEngine(runtime, 'clippy', localExecution({
    sandbox: async (command, args, options) => {
      if (args.includes('build')) return { exitCode: 1, output: 'old compiler unavailable' };
      const completed = await execution.sandbox(command, args, options);
      return args.includes('verify') ? { exitCode: 1, output: 'new verification failed' } : completed;
    },
  }));
  assert.equal(result.outcome, 'failed');
  assert.match(result.summary, /ship_rollback_failed:.*old compiler unavailable/);
  assert.match(await journal(runtime), /ship_rollback_failed/);
});

async function watchdogTools(root: string) {
  const directory = join(root, 'bin');
  await mkdir(directory);
  const scripts: Record<string, string> = {
    'systemd-run': `#!/usr/bin/python3
import json, os, sys
arguments = sys.argv[1:]
with open(os.environ['SANDBOX_LOG'], 'a') as log:
    log.write(json.dumps(arguments) + '\\n')
start = max(index for index, argument in enumerate(arguments) if argument == '--') + 1
os.execvp(arguments[start], arguments[start:])
`,
    systemctl: `#!/bin/sh
printf '%s\\n' "$*" >> "$SERVICE_LOG"
if [ "$2" = restart ]; then
  printf 'artifacts:' >> "$SERVICE_LOG"
  for path in packages/owners/dist packages/surface/dist packages/surface/web/dist; do
    cat "$DEPLOY_CHECKOUT/$path/version" >> "$SERVICE_LOG"
    printf ':' >> "$SERVICE_LOG"
  done
  printf '\\n' >> "$SERVICE_LOG"
  printf active > "$SERVICE_STATE"
fi
if [ "$2" = stop ]; then printf stopped > "$SERVICE_STATE"; fi
if [ "$2" = is-active ]; then
  test "$(cat "$SERVICE_STATE")" = active && test "$(cat "$DEPLOY_CHECKOUT/revision")" = old
fi
`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(directory, name), body);
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

for (const hasBuildFailure of [false, true]) {
  test(`watchdog executes rollback and ${hasBuildFailure ? 'reports failed rebuild without restarting' : 'restores artifacts before restarting'}`, async () => {
    const { root, checkout, previous, runtime } = await repositoryFixture();
    const directory = await watchdogTools(root);
    let script = '';
    const previousWait = SHIP_LIMITS.healthWaitSeconds;
    const previousHome = process.env.ONIONSOUP_HOME;
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    SHIP_LIMITS.healthWaitSeconds = 0;
    process.env.ONIONSOUP_HOME = join(root, 'home');
    try {
      const shipped = await shipEngine(runtime, 'clippy', localExecution({ schedule: async path => {
        assert.match(await journal(runtime), /ship-started/, 'journal is durable before arming the restart');
        script = path;
      } }));
      assert.equal(shipped.outcome, 'shipped');
      assert.deepEqual(await artifactVersions(checkout), ['new', 'new', 'new']);
      const serviceLog = join(root, 'services');
      const serviceState = join(root, 'service-state');
      const sandboxLog = join(root, 'sandbox-calls');
      const scriptText = await readFile(script, 'utf8');
      assert.match(scriptText, /'timeout' '--kill-after' '5s' '600s'/);
      assert.ok(scriptText.includes(`export PATH='${directory}:`));
      const completed = run('/bin/sh', [script], { env: {
        ...process.env, PATH: '/usr/bin:/bin', SERVICE_LOG: serviceLog, SERVICE_STATE: serviceState, SANDBOX_LOG: sandboxLog,
        DEPLOY_CHECKOUT: checkout, FAIL_REBUILD: hasBuildFailure ? '1' : '0',
      } });
      if (hasBuildFailure) await assert.rejects(completed);
      else await completed;
      assert.equal((await git(checkout, ['rev-parse', 'HEAD'])).trim(), previous);
      const calls = await readFile(serviceLog, 'utf8');
      assert.equal(calls.match(/restart/g)?.length, hasBuildFailure ? 1 : 2);
      const sandboxCalls = await readFile(sandboxLog, 'utf8');
      assert.ok(sandboxCalls.includes('bwrap'));
      assert.ok(sandboxCalls.includes('--tmpfs'));
      assert.ok(sandboxCalls.includes('MemoryMax=6G'));
      assert.match(calls, /artifacts:new:new:new:/);
      if (hasBuildFailure) {
        assert.match(await journal(runtime), /ship_rollback_failed/);
        assert.equal(await readFile(serviceState, 'utf8'), 'stopped');
        assert.ok(!calls.includes('artifacts:old:old:old:'));
      }
      else {
        assert.deepEqual(await artifactVersions(checkout), ['old', 'old', 'old']);
        assert.match(await journal(runtime), /ship-rolled-back/);
        assert.match(calls, /stop fixture.service[\s\S]*restart fixture.service\nartifacts:old:old:old:/);
      }
    } finally {
      SHIP_LIMITS.healthWaitSeconds = previousWait;
      process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.ONIONSOUP_HOME;
      else process.env.ONIONSOUP_HOME = previousHome;
    }
  });
}
