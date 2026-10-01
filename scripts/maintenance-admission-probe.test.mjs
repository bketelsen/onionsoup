import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fingerprintEvidence, validateMaintenanceLaunchProfile } from './maintenance-admission-probe.mjs';

const selection = { root: '/fixture/release', state: '/fixture/home/state', config: '/fixture/config',
  surfaceUrl: 'http://127.0.0.1:4747/' };
const profiles = {
  'onionsoup-owners.service': { entry: 'packages/owners/src/cli.ts', suffix: ' daemon', extra: '' },
  'onionsoup-surface.service': { entry: 'packages/surface/src/main.ts', suffix: '',
    extra: ' SURFACE_PORT=4747 ONIONSOUP_RELEASE_MANIFEST=/fixture/release/current/packages/surface/release-manifest.json' },
};
function effectiveUnit(unit) {
  const profile = profiles[unit];
  const executable = join(homedir(), '.local/share/mise/shims/node');
  const argv = `${executable} --conditions=onionsoup-source --import tsx /fixture/release/current/${profile.entry}${profile.suffix}`;
  return { ExecStart: `{ path=${executable} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    WorkingDirectory: '/fixture/release/current',
    Environment: `PATH=/fixture/bin:/usr/bin ONIONSOUP_HOME=/fixture/home ONIONSOUP_CONFIG=/fixture/config${profile.extra}`,
    EnvironmentFiles: '', FragmentPath: `/fixture/${unit}`, DropInPaths: '' };
}

test('default launch validator accepts both installed direct Node source profiles including target manifest environment', () => {
  for (const unit of Object.keys(profiles)) {
    const current = effectiveUnit(unit);
    assert.match(validateMaintenanceLaunchProfile(selection, unit, current, { HOME: homedir() }).argv, /\/current\/packages\//);
    current.Environment = current.Environment.split(' ').map(value => `"${value}"`).join(' ');
    assert.match(validateMaintenanceLaunchProfile(selection, unit, current).argv, /--import tsx/);
  }
});

test('default launch validator rejects a hardcoded old release, wrappers, hooks and unknown environments', () => {
  const unit = 'onionsoup-surface.service';
  const cases = [
    current => { current.ExecStart = current.ExecStart.replaceAll('/current/', '/releases/old/'); },
    current => { current.ExecStart = current.ExecStart.replace('argv[]=', 'argv[]=/bin/sh -c '); },
    current => { current.ExecStart += current.ExecStart; },
    current => { current.ExecStartPre = '/fixture/unknown-effect'; },
    current => { current.EnvironmentFiles = '/fixture/secret'; },
    current => { current.WorkingDirectory = '/fixture/release/releases/old'; },
    current => { current.Environment += ' OPENCODE_URL=http://foreign/'; },
    current => { current.Environment = current.Environment.replace('ONIONSOUP_HOME=/fixture/home', 'ONIONSOUP_HOME=/fixture/other'); },
    current => { current.Environment = current.Environment.replace('ONIONSOUP_CONFIG=/fixture/config', 'ONIONSOUP_CONFIG=/fixture/other'); },
    current => { current.Environment = current.Environment.replace('SURFACE_PORT=4747', 'SURFACE_PORT=4000'); },
    current => { current.Environment = current.Environment.replace('/current/packages/surface/release-manifest.json', '/releases/old/manifest.json'); },
    current => { current.BindReadOnlyPaths = '/fixture/old:/fixture/release/current'; },
  ];
  for (const mutate of cases) {
    const current = effectiveUnit(unit);
    mutate(current);
    assert.throws(() => validateMaintenanceLaunchProfile(selection, unit, current), /maintenance_recovery_launch_/);
  }
  for (const key of ['NODE_OPTIONS', 'OPENCODE_URL', 'ONIONSOUP_HOME_OVERRIDE', 'LD_PRELOAD', 'TSX_TSCONFIG_PATH', 'MISE_NODE_VERSION']) {
    assert.throws(() => validateMaintenanceLaunchProfile(selection, unit, effectiveUnit(unit), { [key]: 'unknown' }),
      /maintenance_recovery_launch_environment_unsupported/);
  }
});

test('fingerprints bind durable state, configuration and SQLite WAL while excluding deployment coordination', async context => {
  const scratch = await mkdtemp(join(tmpdir(), 'maintenance-probe-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const input = { state: join(scratch, 'state'), config: join(scratch, 'config'), evidenceRoots: [join(scratch, 'opencode')] };
  await Promise.all([input.state, input.config, ...input.evidenceRoots].map(path => mkdir(path)));
  await mkdir(join(input.state, 'deploy'));
  await writeFile(join(input.state, 'durable.json'), '{}');
  await writeFile(join(input.evidenceRoots[0], 'opencode.db-wal'), 'before');
  const before = await fingerprintEvidence(input);
  await writeFile(join(input.state, 'deploy/pending.json'), '{"status":"draining"}');
  assert.equal((await fingerprintEvidence(input)).digest, before.digest);
  await writeFile(join(input.evidenceRoots[0], 'opencode.db-wal'), 'after');
  assert.notEqual((await fingerprintEvidence(input)).digest, before.digest);
  await writeFile(join(input.evidenceRoots[0], 'opencode.db-wal'), 'before');
  await writeFile(join(input.state, 'durable.json'), '{"changed":true}');
  assert.notEqual((await fingerprintEvidence(input)).digest, before.digest);
});
