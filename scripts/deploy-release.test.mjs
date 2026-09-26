import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { armDeployment, beginAdmission, beginDrain, markDeploymentWaiting } from '../packages/owners/src/deployment-admission.ts';
import { arm, worker, cancel } from './deploy-release.mjs';
import { runStageCommand } from './deploy-stage.mjs';

const exec = promisify(execFile);

const OLD = 'b'.repeat(40);
const NEXT = 'a'.repeat(40);

async function unsealDirectories(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await unsealDirectories(join(directory, entry.name));
  }
}

test('candidate stage hides host credentials and prevents runtime writes while installing and verifying', async () => {
  // npm run verify within a staged release already runs inside the scoped bwrap.
  // Its own test process has no user bus, so check that boundary directly there.
  if (process.env.HOME === '/home/stage' && process.env.NPM_CONFIG_USERCONFIG === '/dev/null') {
    assert.equal(process.env.XDG_CONFIG_HOME, '/home/stage/.config');
    assert.equal(process.env.XDG_DATA_HOME, '/home/stage/.local/share');
    assert.equal(process.env.GIT_AUTHOR_NAME, undefined);
    assert.equal(process.env.GIT_AUTHOR_EMAIL, undefined);
    assert.equal(process.env.GIT_COMMITTER_NAME, undefined);
    assert.equal(process.env.GIT_COMMITTER_EMAIL, undefined);
    assert.equal(process.env.GIT_CONFIG_GLOBAL, '/etc/stage-gitconfig');
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
    assert.equal((await import('node:os')).userInfo().username, 'stage');
    assert.equal(process.env.NODE_OPTIONS,
      '--test-skip-pattern=^a sandboxed npm ci succeeds in a minimal fixture, with private XDG roots and the worktree writable$');
    assert.equal(process.env.FAKE_CREDENTIAL, undefined);
    assert.equal(process.env.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(process.env.ONIONSOUP_HOME, undefined);
    assert.equal(existsSync('/run/user'), false);
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'onionsoup-stage-policy-'));
  const home = join(scratch, 'host-home');
  const staging = join(scratch, 'releases', 'staging');
  const runtime = join(scratch, 'runtime', 'state');
  const secret = 'fixture-credential-do-not-leak';
  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
  await mkdir(join(home, '.ssh'), { recursive: true });
  await mkdir(staging, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(join(home, '.local', 'share', 'opencode', 'auth.json'), secret);
  await writeFile(join(home, '.ssh', 'id_ed25519'), secret);
  await writeFile(join(home, '.npmrc'), `//registry.npmjs.org/:_authToken=${secret}\n`);
  await writeFile(join(runtime, 'marker'), 'unchanged');
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name: 'candidate-stage-fixture', version: '1.0.0', private: true,
    scripts: { verify: 'node verify.mjs' },
    dependencies: { 'is-number': '7.0.0' },
  }));
  await writeFile(join(staging, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { userInfo } from 'node:os';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import isNumber from 'is-number';
    assert.equal(isNumber(42), true);
    assert.equal(process.env.HOME, '/home/stage');
    assert.equal(process.env.XDG_CONFIG_HOME, '/home/stage/.config');
    assert.equal(process.env.XDG_CACHE_HOME, '/home/stage/.cache');
    assert.equal(process.env.XDG_DATA_HOME, '/home/stage/.local/share');
    assert.equal(process.env.XDG_STATE_HOME, '/home/stage/.local/state');
    assert.equal(process.env.NPM_CONFIG_USERCONFIG, '/dev/null');
    assert.equal(process.env.GIT_AUTHOR_NAME, undefined);
    assert.equal(process.env.GIT_AUTHOR_EMAIL, undefined);
    assert.equal(process.env.GIT_COMMITTER_NAME, undefined);
    assert.equal(process.env.GIT_COMMITTER_EMAIL, undefined);
    assert.equal(process.env.GIT_CONFIG_GLOBAL, '/etc/stage-gitconfig');
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(userInfo().username, 'stage');
     assert.equal(process.env.NODE_OPTIONS,
       '--test-skip-pattern=^a sandboxed npm ci succeeds in a minimal fixture, with private XDG roots and the worktree writable$');
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(process.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(process.env.FAKE_CREDENTIAL, undefined);
    for (const key of Object.keys(process.env)) {
      assert.equal(key.startsWith('OPENCODE_'), false, key);
      assert.equal(key.startsWith('ONIONSOUP_'), false, key);
      assert.equal(key.startsWith('NPM_CONFIG_') && key !== 'NPM_CONFIG_USERCONFIG' && key !== 'NPM_CONFIG_CACHE', false, key);
    }
    for (const path of ['.ssh/id_ed25519', '.npmrc', '.local/share/opencode/auth.json']) {
      assert.equal(existsSync('${home}/' + path), false, path);
      assert.equal(existsSync(process.env.HOME + '/' + path), false, path);
    }
    assert.equal(existsSync('${runtime}/marker'), false);
    assert.throws(() => writeFileSync('${runtime}/marker', 'changed'));
    execFileSync('git', ['init', '-q', 'test-repo']);
    writeFileSync('test-repo/fixture', 'test');
    execFileSync('git', ['-C', 'test-repo', 'add', 'fixture']);
    execFileSync('git', ['-C', 'test-repo', 'commit', '-qm', 'test fixture']);
    assert.equal(execFileSync('git', ['-C', 'test-repo', 'log', '-1', '--format=%an <%ae>'],
      { encoding: 'utf8' }).trim(), 'Onionsoup Stage Test <stage-test@onionsoup.invalid>');
    execFileSync('git', ['-C', 'test-repo', 'config', 'user.name', 'Fixture Author']);
    execFileSync('git', ['-C', 'test-repo', 'config', 'user.email', 'fixture@example.invalid']);
    writeFileSync('test-repo/fixture', 'updated');
    execFileSync('git', ['-C', 'test-repo', 'commit', '-qam', 'fixture author']);
    assert.equal(execFileSync('git', ['-C', 'test-repo', 'log', '-1', '--format=%an <%ae>'],
      { encoding: 'utf8' }).trim(), 'Fixture Author <fixture@example.invalid>');
    writeFileSync('verified', 'ok');
  `);
  try {
    const { stdout } = await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: staging, env: { PATH: process.env.PATH, HOME: join(staging, '.lock-home'),
        npm_config_cache: join(staging, '.lock-cache'), npm_config_userconfig: '/dev/null' },
    });
    assert.match(stdout, /up to date/);
    await rm(join(staging, '.lock-cache'), { recursive: true, force: true });
    await runStageCommand('npm', ['ci', '--no-audit', '--no-fund'], staging, {
      ...process.env, HOME: home, OPENCODE_SERVER_PASSWORD: secret,
      OPENCODE_CONFIG_CONTENT: secret, ONIONSOUP_HOME: runtime, FAKE_CREDENTIAL: secret,
       NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
       GIT_AUTHOR_NAME: 'Host Author', GIT_AUTHOR_EMAIL: 'host@example.com',
       GIT_COMMITTER_NAME: 'Host Committer', GIT_COMMITTER_EMAIL: 'host@example.com',
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Host Identity',
    });
     await runStageCommand('npm', ['run', 'verify'], staging, {
       ...process.env, ONIONSOUP_DEPLOY_E2E: undefined, HOME: home, OPENCODE_SERVER_PASSWORD: secret,
       OPENCODE_CONFIG_CONTENT: secret, ONIONSOUP_HOME: runtime,
     });
    assert.equal(await readFile(join(staging, 'verified'), 'utf8'), 'ok');
    assert.equal(await readFile(join(runtime, 'marker'), 'utf8'), 'unchanged');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('stage refuses out-of-range resource caps before starting a command', async () => {
  for (const limits of [
    { memoryMax: 'infinity', tasksMax: 2048 },
    { memoryMax: '8G', tasksMax: 0 },
    { memoryMax: '8G', tasksMax: 100000 },
    { memoryMax: '8G', tasksMax: '2048' },
  ]) {
    await assert.rejects(runStageCommand('npm', ['--version'], '/does-not-exist', process.env, limits),
      /stage_limits_invalid/);
  }
});

test('arm archives a real commit, installs and verifies in a temporary release',
  { skip: process.env.ONIONSOUP_DEPLOY_E2E !== '1' || process.env.HOME === '/home/stage', timeout: 2_000_000 }, async () => {
     const scratch = await mkdtemp(join(tmpdir(), 'onionsoup-arm-e2e-'));
    const root = join(scratch, 'installation');
    const state = join(scratch, 'state');
    const source = fileURLToPath(new URL('..', import.meta.url));
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: source });
    const commit = stdout.trim();
    const previous = join(root, 'releases', OLD);
    try {
      await mkdir(previous, { recursive: true });
      await symlink(previous, join(root, 'current'));
       const optIn = process.env.ONIONSOUP_DEPLOY_E2E;
       let pending;
       try {
         delete process.env.ONIONSOUP_DEPLOY_E2E;
         pending = await arm({ root, state, source, commit }).catch(error => {
           const output = error.stdout ?? '';
           const failures = output.match(/^[ \t]*(?:✖|not ok|ℹ (?:tests|pass|fail|skipped))[^\n]*/gm)?.slice(-50).join('\n') ?? '';
           const details = output.slice(output.lastIndexOf('✖ failing tests:'));
           const causes = details.match(/(?:Failed to connect to user scope bus[^\n]*|uv_os_get_passwd returned ENOENT[^\n]*|AssertionError \[ERR_ASSERTION\][^\n]*)/g)?.slice(0, 10).join('\n') ?? '';
           throw new Error(`staged verify failed: ${failures}\n${causes}\n${error.stderr?.slice(-1000) ?? ''}`);
         });
       } finally {
         if (optIn === undefined) delete process.env.ONIONSOUP_DEPLOY_E2E;
         else process.env.ONIONSOUP_DEPLOY_E2E = optIn;
       }
      assert.equal(pending.status, 'armed');
      assert.equal(pending.targetBuildId, commit);
      assert.equal(await realpath(join(root, 'current')), previous);
      assert.equal(JSON.parse(await readFile(join(root, 'releases', commit,
        'packages', 'surface', 'release-manifest.json'), 'utf8')).buildId, commit);
      assert.equal(JSON.parse(await readFile(join(state, 'deploy', 'pending.json'), 'utf8')).status, 'armed');
    } finally {
      const release = join(root, 'releases', commit);
      if (existsSync(release)) await unsealDirectories(release);
      await rm(scratch, { recursive: true, force: true });
    }
  });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-deploy-'));
  const root = join(directory, 'installation');
  const state = join(directory, 'state');
  for (const buildId of [OLD, NEXT]) {
    const surface = join(root, 'releases', buildId, 'packages', 'surface');
    await mkdir(surface, { recursive: true });
    await writeFile(join(surface, 'release-manifest.json'), JSON.stringify({ buildId }));
  }
  await symlink(join(root, 'releases', OLD), join(root, 'current'));
  await armDeployment(state, NEXT);
  return { root, state, config: resolve('packages/owners/test/fixtures/owners') };
}

test('unavailable endpoint reopens the drain for retry and cancellation', async () => {
  const options = await fixture();
  await assert.rejects(worker(options), /deployment_endpoint_invalid/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(existsSync(join(options.state, 'deploy', 'rollback.json')), false);
  const lease = await beginAdmission(options.state, 'new');
  await lease.release();
  assert.equal((await cancel(options)).status, 'cancelled');
});

test('malformed and throwing status probes reopen the pre-checkpoint drain', async () => {
  for (const request of [
    async () => [],
    async () => { throw new Error('status_transport_unavailable'); },
  ]) {
    const options = await fixture();
    const admissionEffects = {
      endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
      request,
      processes: async () => false,
      sleep: async () => {},
    };
    await assert.rejects(worker({ ...options, admissionEffects }),
      /deployment_opencode_invalid|status_transport_unavailable/);
    assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
    assert.equal(existsSync(join(options.state, 'deploy', 'rollback.json')), false);
    assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
    const lease = await beginAdmission(options.state, 'reply');
    await lease.release();
    assert.equal((await cancel(options)).status, 'cancelled');
  }
});

test('a probe throwing after the quiet interval reopens the drain', async () => {
  const options = await fixture();
  let statusProbes = 0;
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => {
      if (path === '/session/status') {
        if (++statusProbes > 6) throw new Error('late_status_unavailable');
        return {};
      }
      return [];
    },
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = { systemctl: async () => true, opencode: async buildId => ({ ok: true, buildId }) };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /late_status_unavailable/);
  assert.equal(statusProbes, 7);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
  assert.equal(existsSync(join(options.state, 'deploy', 'rollback.json')), false);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
});

test('worker waits with the gate open for an active admission without consulting an unverified endpoint', async () => {
  const options = await fixture();
  const lease = await beginAdmission(options.state, 'chat');
  try {
    await assert.rejects(worker(options), /deployment_waiting_for_turns/);
    assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
    const reply = await beginAdmission(options.state, 'surface:reply');
    await reply.release();
  } finally {
    await lease.release();
  }
});

test('worker leaves an already pending question answerable before retrying drain', async () => {
  const options = await fixture();
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : path === '/question' ?
      [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Proceed?', header: 'Choice', options: [] }] }] : [],
    processes: async () => false,
    sleep: async () => {},
  };
  await assert.rejects(worker({ ...options, admissionEffects }), /deployment_waiting_for_turns/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  const answer = await beginAdmission(options.state, 'surface:question-reply');
  await answer.release();
});

test('a prompt discovered by the quiet probe after drain reopens the gate for its reply', async () => {
  const options = await fixture();
  let pendingPrompt = true;
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : path === '/permission' && pendingPrompt ?
      [{ id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: [], metadata: {}, always: [] }] : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = { systemctl: async () => true, opencode: async buildId => ({ ok: true, buildId }) };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /deployment_waiting_for_turns/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(existsSync(join(options.state, 'deploy', 'rollback.json')), false);
  const reply = await beginAdmission(options.state, 'surface:permission-reply');
  pendingPrompt = false;
  await reply.release();
  assert.equal((await worker({ ...options, admissionEffects, effects })).status, 'completed');
});

test('a prompt discovered after checkpoint but before switching reopens admission', async () => {
  const options = await fixture();
  const checkpoint = join(options.state, 'deploy', 'rollback.json');
  let sawCheckpoint = false;
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => {
      if (path === '/session/status') return {};
      if (path === '/question' && existsSync(checkpoint)) {
        sawCheckpoint = true;
        return [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Proceed?', header: 'Choice', options: [] }] }];
      }
      return [];
    },
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = { systemctl: async () => true, opencode: async buildId => ({ ok: true, buildId }) };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /deployment_waiting_for_turns/);
  assert.equal(sawCheckpoint, true);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(existsSync(checkpoint), false);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
  const answer = await beginAdmission(options.state, 'surface:question-reply');
  await answer.release();
  assert.equal((await cancel(options)).status, 'cancelled');
});

test('interrupted pre-switch checkpoint leaves old services running and reopens a pending question', async () => {
  const options = await fixture();
  const checkpoint = join(options.state, 'deploy', 'rollback.json');
  await beginDrain(options.state, NEXT);
  await writeFile(checkpoint, JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
    phase: 'pre-switch',
  }));
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/question' ?
      [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Proceed?', header: 'Choice', options: [] }] }] :
      path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = {
    systemctl: async action => {
      if (action === 'restart') throw new Error('old_service_interrupted');
      return true;
    },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  assert.equal((await worker({ ...options, admissionEffects, effects })).status, 'waiting');
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(existsSync(checkpoint), false);
  const answer = await beginAdmission(options.state, 'surface:question-reply');
  await answer.release();
});

test('pre-switch checkpoint with a changed pointer keeps the drain held', async () => {
  const options = await fixture();
  const checkpoint = join(options.state, 'deploy', 'rollback.json');
  await beginDrain(options.state, NEXT);
  await rm(join(options.root, 'current'));
  await symlink(join(options.root, 'releases', NEXT), join(options.root, 'current'));
  await writeFile(checkpoint, JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
    phase: 'pre-switch',
  }));
  const effects = {
    systemctl: async action => {
      if (action === 'restart') throw new Error('service_interrupted');
      return true;
    },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  await assert.rejects(worker({ ...options, effects }), /rollback_unverified_gate_held/);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', NEXT));
  assert.equal(existsSync(checkpoint), true);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
});

test('uncertain switch with old pointer and pending question holds drain without restarting', async () => {
  const options = await fixture();
  const checkpoint = join(options.state, 'deploy', 'rollback.json');
  await beginDrain(options.state, NEXT);
  await writeFile(checkpoint, JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
    phase: 'switch-attempted',
  }));
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/question' ?
      [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Proceed?', header: 'Choice', options: [] }] }] :
      path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = {
    systemctl: async action => {
      if (action === 'restart') throw new Error('old_service_interrupted');
      return true;
    },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /rollback_unverified_gate_held/);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(existsSync(checkpoint), true);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
  await assert.rejects(beginAdmission(options.state, 'surface:question-reply'), /deployment_draining/);
});

test('uncertain switch with new pointer and a pending question does not roll back across the chat', async () => {
  const options = await fixture();
  const checkpoint = join(options.state, 'deploy', 'rollback.json');
  await beginDrain(options.state, NEXT);
  await rm(join(options.root, 'current'));
  await symlink(join(options.root, 'releases', NEXT), join(options.root, 'current'));
  await writeFile(checkpoint, JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
    phase: 'switch-attempted',
  }));
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/question' ?
      [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Proceed?', header: 'Choice', options: [] }] }] :
      path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = {
    systemctl: async action => {
      if (action === 'restart') throw new Error('service_interrupted');
      return true;
    },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /rollback_unverified_gate_held/);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', NEXT));
  assert.equal(existsSync(checkpoint), true);
});

test('uncertain switch recovers only after quiescence returns', async () => {
  const options = await fixture();
  const checkpoint = join(options.state, 'deploy', 'rollback.json');
  await beginDrain(options.state, NEXT);
  await writeFile(checkpoint, JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
    phase: 'switch-attempted',
  }));
  let hasQuestion = true;
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/question' && hasQuestion ?
      [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Proceed?', header: 'Choice', options: [] }] }] :
      path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const events = [];
  const effects = {
    systemctl: async (action, unit) => {
      events.push(`${action}:${unit}`);
      return true;
    },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /rollback_unverified_gate_held/);
  assert.equal(events.some(event => event.startsWith('restart:')), false);
  hasQuestion = false;
  assert.equal((await worker({ ...options, admissionEffects, effects })).status, 'cancelled');
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(events.filter(event => event.startsWith('restart:')).length, 2);
  assert.equal(existsSync(checkpoint), false);
});

test('caller-chosen loopback endpoint cannot authorize a switch', async () => {
  const options = await fixture();
  await assert.rejects(worker({ ...options, opencodeUrl: 'http://127.0.0.1:9999' }),
    /deployment_opencode_override_forbidden/);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
});

test('cancel armed with a live chat lease preserves it and permits new turns', async () => {
  const options = await fixture();
  const lease = await beginAdmission(options.state, 'chat');
  try {
    assert.equal((await cancel(options)).status, 'cancelled');
    assert.equal((await cancel(options)).status, 'cancelled');
    const next = await beginAdmission(options.state, 'new-chat');
    await next.release();
    assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  } finally {
    await lease.release();
  }
});

test('cancel waiting before drain keeps the gate open', async () => {
  const options = await fixture();
  await markDeploymentWaiting(options.state, NEXT);
  assert.equal((await cancel(options)).status, 'cancelled');
  const lease = await beginAdmission(options.state, 'chat');
  await lease.release();
});

test('cancel racing the worker either cancels or leaves a responsive waiting gate', async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const options = await fixture();
    const lease = await beginAdmission(options.state, 'chat');
    try {
      const [cancellation, processing] = await Promise.allSettled([cancel(options), worker(options)]);
      const record = JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8'));
      if (record.status === 'cancelled') {
        assert.equal(cancellation.status, 'fulfilled');
        if (processing.status === 'rejected') assert.match(processing.reason.message,
          /deployment_not_armed|deployment_waiting_for_turns/);
        const next = await beginAdmission(options.state, 'new-chat');
        await next.release();
      } else {
        assert.equal(record.status, 'waiting');
        assert.equal(cancellation.status, 'rejected');
        assert.equal(processing.status, 'rejected');
        const next = await beginAdmission(options.state, 'new-chat');
        await next.release();
      }
      assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
    } finally {
      await lease.release();
    }
  }
});

test('cancel rejects a switch checkpoint even while intent still says armed', async () => {
  const options = await fixture();
  await writeFile(join(options.state, 'deploy', 'rollback.json'), JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
  }));
  await assert.rejects(cancel(options), /rollback_unverified_gate_held/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'armed');
});

test('cancel refuses draining and an existing switch checkpoint', async () => {
  const options = await fixture();
  await beginDrain(options.state, NEXT);
  await assert.rejects(cancel(options), /cannot_cancel_draining/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
  await writeFile(join(options.state, 'deploy', 'rollback.json'), JSON.stringify({
    original: join(options.root, 'releases', OLD), oldBuildId: OLD, targetBuildId: NEXT,
  }));
  await assert.rejects(cancel(options), /cannot_cancel_draining|rollback_unverified_gate_held/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
});

test('worker cannot load coordinator from moving release root', async () => {
  const options = await fixture();
  await assert.rejects(worker({ ...options, root: resolve('.') }), /worker_inside_release_root/);
});

test('worker switches only after two quiet probes and releases the drain on verified health', async () => {
  const options = await fixture();
  let probes = 0;
  const events = [];
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => { events.push('quiet'); },
    onProbe: () => { probes++; events.push('probe'); },
  };
  const effects = {
    systemctl: async (action, unit) => { events.push(`${action}:${unit}`); return true; },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  const outcome = await worker({ ...options, admissionEffects, effects });
  assert.equal(outcome.status, 'completed');
  assert.equal(probes >= 3, true);
  assert.ok(events.indexOf('quiet') < events.indexOf('restart:onionsoup-owners.service'));
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', NEXT));
  assert.equal((await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).includes('completed'), true);
});

test('worker holds old pointer when a late busy probe interrupts the quiet interval', async () => {
  const options = await fixture();
  let probes = 0;
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' && ++probes > 1 ? { busy: { type: 'busy' } } : path === '/session/status' ? {} : [],
    processes: async () => false, sleep: async () => {},
  };
  await assert.rejects(worker({ ...options, admissionEffects, effects: {
    systemctl: async () => true, opencode: async buildId => ({ ok: true, buildId }),
  } }), /deployment_waiting_for_turns/);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'waiting');
});

test('failed new-build health rolls back while retaining the gate if old health cannot be verified', async () => {
  const options = await fixture();
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : [],
    processes: async () => false, sleep: async () => {},
  };
  let healthChecks = 0;
  await assert.rejects(worker({ ...options, admissionEffects, readiness: { timeoutMs: 10, intervalMs: 1 }, effects: {
    systemctl: async () => true,
    opencode: async buildId => ({ ok: ++healthChecks === 1, buildId }),
  } }), /rollback_unverified_gate_held/);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
  assert.ok(JSON.parse(await readFile(join(options.state, 'deploy', 'rollback.json'), 'utf8')));
});

test('a switch-phase failure with unverified recovery retains its checkpoint and drain gate', async () => {
  const options = await fixture();
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const effects = {
    systemctl: async action => {
      if (action === 'restart') throw new Error('restart_unavailable');
      return true;
    },
    opencode: async buildId => ({ ok: true, buildId }),
  };
  await assert.rejects(worker({ ...options, admissionEffects, effects }), /rollback_unverified_gate_held/);
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
  assert.ok(JSON.parse(await readFile(join(options.state, 'deploy', 'rollback.json'), 'utf8')));
  await assert.rejects(beginAdmission(options.state, 'new'), /deployment_draining/);
  await assert.rejects(cancel(options), /rollback_unverified_gate_held/);
});

test('worker waits for the restarted surface to report the new build before releasing the drain', async () => {
  const options = await fixture();
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  let newBuildProbes = 0;
  const outcome = await worker({ ...options, admissionEffects,
    readiness: { timeoutMs: 100, intervalMs: 1 },
    effects: {
      systemctl: async () => true,
      opencode: async buildId => {
        if (buildId === NEXT) newBuildProbes++;
        return { ok: buildId === OLD || newBuildProbes >= 3, buildId };
      },
    },
  });
  assert.equal(outcome.status, 'completed');
  assert.ok(newBuildProbes >= 3);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', NEXT));
  assert.equal(existsSync(join(options.state, 'deploy', 'rollback.json')), false);
});

test('new-build readiness timeout restores the old build after its own delayed readiness', async () => {
  const options = await fixture();
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  let oldBuildProbes = 0;
  let newBuildProbes = 0;
  await assert.rejects(worker({ ...options, admissionEffects,
    readiness: { timeoutMs: 20, intervalMs: 1 },
    effects: {
      systemctl: async () => true,
      opencode: async buildId => {
        if (buildId === NEXT) {
          newBuildProbes++;
          return { ok: false, buildId };
        }
        oldBuildProbes++;
        return { ok: oldBuildProbes !== 2, buildId };
      },
    },
  }), /readiness_opencode_or_build/);
  assert.ok(newBuildProbes > 1);
  assert.ok(oldBuildProbes >= 3);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'cancelled');
  assert.equal(existsSync(join(options.state, 'deploy', 'rollback.json')), false);
});

test('unreadable readiness holds the gate and never logs endpoint credentials', async () => {
  const options = await fixture();
  const admissionEffects = {
    endpoint: async () => ({ url: 'http://127.0.0.1:34567/', username: 'opencode', password: 'fixture' }),
    request: async (_endpoint, path) => path === '/session/status' ? {} : [],
    processes: async () => false,
    sleep: async () => {},
  };
  const secret = 'sensitive-endpoint-password';
  const logs = [];
  const originalError = console.error;
  console.error = message => { logs.push(message); };
  let oldBuildProbes = 0;
  try {
    await assert.rejects(worker({ ...options, admissionEffects,
      readiness: { timeoutMs: 10, intervalMs: 1 },
      effects: {
        systemctl: async () => true,
        opencode: async buildId => {
          if (buildId === OLD && ++oldBuildProbes === 1) return { ok: true, buildId };
          throw new Error(`cannot read endpoint: ${secret}`);
        },
      },
    }), /rollback_unverified_gate_held/);
  } finally {
    console.error = originalError;
  }
  assert.ok(oldBuildProbes > 1);
  assert.equal(await realpath(join(options.root, 'current')), join(options.root, 'releases', OLD));
  assert.equal(JSON.parse(await readFile(join(options.state, 'deploy', 'pending.json'), 'utf8')).status, 'draining');
  assert.ok(existsSync(join(options.state, 'deploy', 'rollback.json')));
  assert.match(logs.join('\n'), /readiness_probe_unavailable/);
  assert.doesNotMatch(logs.join('\n'), /sensitive-endpoint-password/);
});
