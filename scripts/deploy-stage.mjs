import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PRIVATE_HOME = '/home/stage';
const STAGE_PATH = '/opt/node/bin:/usr/bin:/bin';
const HOST_BUS_TEST = 'a sandboxed npm ci succeeds in a minimal fixture, with private XDG roots and the worktree writable';
export const STAGE_LIMITS = { memoryMax: '8G', tasksMax: 2048 };
const STAGE_ENV = {
  HOME: PRIVATE_HOME,
  XDG_CONFIG_HOME: `${PRIVATE_HOME}/.config`,
  XDG_CACHE_HOME: `${PRIVATE_HOME}/.cache`,
  XDG_DATA_HOME: `${PRIVATE_HOME}/.local/share`,
  XDG_STATE_HOME: `${PRIVATE_HOME}/.local/state`,
  NPM_CONFIG_USERCONFIG: '/dev/null',
  NPM_CONFIG_CACHE: `${PRIVATE_HOME}/.cache/npm`,
  // Test-only identity: never import the host's Git identity into the stage.
  // A synthetic global file supplies a fallback; GIT_CONFIG_COUNT overrides local fixtures.
  GIT_CONFIG_GLOBAL: '/etc/stage-gitconfig',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  PATH: STAGE_PATH,
  TMPDIR: '/tmp',
};

function stageParents(location) {
  const parents = [];
  for (let parent = dirname(location); parent !== '/'; parent = dirname(parent)) parents.unshift(parent);
  return parents.flatMap(parent => ['--dir', parent]);
}

async function existingReadOnly(source, target = source) {
  try {
    await access(source);
    return ['--ro-bind', source, target];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function stageArguments(command, args, location, privateFiles, skipHostBusTest) {
  if (!isAbsolute(location) || resolve(location) !== location) throw new Error('stage_absolute_location_required');
  const physicalLocation = await realpath(location);
  if (physicalLocation !== location) throw new Error('stage_symlink_location_forbidden');
  const nodeBinary = await realpath(process.execPath);
  const nodeRoot = dirname(dirname(nodeBinary));
  await access(join(nodeRoot, 'bin', 'npm'));
  const certificates = [
    ...(await existingReadOnly('/etc/ssl/certs')),
    ...(await existingReadOnly('/etc/pki/tls/certs')),
  ];
  const networkFiles = (await Promise.all([
    '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/gai.conf',
  ].map(path => existingReadOnly(path)))).flat();
  return [
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--dir', '/opt', '--ro-bind', nodeRoot, '/opt/node',
    '--dir', '/etc', '--dir', '/etc/ssl', '--dir', '/etc/pki', '--dir', '/etc/pki/tls',
    ...certificates, ...networkFiles,
    '--ro-bind', privateFiles.passwd, '/etc/passwd',
    '--ro-bind', privateFiles.gitconfig, '/etc/stage-gitconfig',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--dir', '/home', '--tmpfs', PRIVATE_HOME,
    ...stageParents(location), '--bind', location, location,
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--clearenv',
    ...Object.entries(STAGE_ENV).flatMap(([key, value]) => ['--setenv', key, value]),
    ...(skipHostBusTest ? ['--setenv', 'NODE_OPTIONS', `--test-skip-pattern=^${HOST_BUS_TEST}$`] : []),
    '--chdir', location, '--',
    command === 'npm' ? '/opt/node/bin/npm' : command,
    ...args,
  ];
}

export async function runStageCommand(command, args, location, hostEnvironment = process.env, limits = STAGE_LIMITS) {
  if (!/^(?:[6-9]|1[0-2])G$/.test(limits?.memoryMax) ||
    !Number.isSafeInteger(limits.tasksMax) || limits.tasksMax < 512 || limits.tasksMax > 4096) {
    throw new Error('stage_limits_invalid');
  }
  const privateDirectory = await mkdtemp(join(tmpdir(), 'onionsoup-stage-identity-'));
  try {
    const privateFiles = {
      passwd: join(privateDirectory, 'passwd'),
      gitconfig: join(privateDirectory, 'gitconfig'),
    };
    await writeFile(privateFiles.passwd, `stage:x:${process.getuid()}:${process.getgid()}:Stage:/home/stage:/bin/sh\n`, { mode: 0o600 });
    await writeFile(privateFiles.gitconfig, '[user]\n\tname = Onionsoup Stage Test\n\temail = stage-test@onionsoup.invalid\n', { mode: 0o600 });
    const skipHostBusTest = command === 'npm' && args[0] === 'run' && args[1] === 'verify';
    const sandboxArgs = await stageArguments(command, args, location, privateFiles, skipHostBusTest);
    const runnerEnvironment = {
      PATH: '/usr/bin:/bin',
      XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: hostEnvironment.DBUS_SESSION_BUS_ADDRESS,
    };
    // The archived suite's nested sandbox integration test requires a host user bus,
    // which is never mounted inside this dedicated stage sandbox.
    if (skipHostBusTest) console.log(`Staged verify skips only "${HOST_BUS_TEST}" (nested host bus unavailable).`);
    await exec('systemd-run', [
      '--user', '--scope', '--quiet', '-p', `MemoryMax=${limits.memoryMax}`, '-p', 'MemorySwapMax=0',
      '-p', `TasksMax=${limits.tasksMax}`, '--', 'bwrap', ...sandboxArgs,
    ], { cwd: location, env: runnerEnvironment, timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 });
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
