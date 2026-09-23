import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { homeDirectory } from './paths.ts';

/**
 * Every model-driven process and every verification command runs inside a memory-capped systemd scope
 * and a bubblewrap sandbox with a read-only root. Bash allowlists are not a boundary: `cat > file`
 * matches `cat *`. A read-only owner that wrote probe tests and ran them used ~47 GB and got the
 * whole terminal OOM-killed; this is the fix.
 */
export const SANDBOX_LIMITS = { memoryMax: '6G', tasksMax: 512, verifyTimeoutMs: 10 * 60_000, outputChars: 6_000 };

const HOME = homedir();

/**
 * The host's real opencode config (~/.config/opencode) is loaded as plugins by any host opencode that reads
 * the person's real config (the surface's own unsandboxed opencode): anything a sandboxed process writes
 * there would run on the host, outside any sandbox. These two paths are masked with --tmpfs after every
 * writable bind, so nothing can reopen them.
 */
/** Exported for tests: the two host paths every sandboxed process must never see writable. */
export const MASKED_HOST_PATHS = [join(HOME, '.config/opencode'), join(HOME, '.local/state/opencode')];

/** Private config/state roots every sandboxed process gets instead, under ONIONSOUP_HOME. */
/** Exported for tests: where the private XDG roots live under ONIONSOUP_HOME. */
export function privateXdgRoots() {
  const root = join(homeDirectory(), 'sandbox');
  return { config: join(root, 'config'), state: join(root, 'state') };
}

/**
 * Paths a sandboxed tool may always write: opencode's own private config/state, its real data directory
 * (auth.json lives there; masking it would break authentication, so it stays writable until the
 * credential-proxy follow-up hides provider credentials instead), and the Go/npm caches.
 */
function alwaysWritable() {
  const { config, state } = privateXdgRoots();
  return [
    config,
    state,
    join(HOME, '.local/share/opencode'),
    join(HOME, '.cache'),
    join(HOME, '.npm'),
    join(HOME, 'go'),
  ];
}

/** A path with any trailing separators removed, so "/a/b/" and "/a/b" compare equal. */
function normalize(path: string) {
  const resolved = resolve(path);
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/** True if `path` is exactly `ancestor`, or lies inside it. */
function isWithin(path: string, ancestor: string) {
  return path === ancestor || path.startsWith(ancestor + sep);
}

/** Reject any writable bind that is, or contains, a masked host path: that bind would reopen the mask. */
function assertNotMasking(writable: readonly string[]) {
  for (const requested of writable) {
    const normalized = normalize(requested);
    for (const masked of MASKED_HOST_PATHS) {
      if (isWithin(normalized, masked) || isWithin(masked, normalized)) {
        throw new Error(`writable_path_masks_host_opencode: ${requested} conflicts with ${masked}`);
      }
    }
  }
}

export interface SandboxOptions {
  cwd: string;
  writable: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Exported for tests: the exact bwrap/systemd-run arguments, so bind order and masking can be inspected without spawning. */
export function sandboxCommand(command: string, args: readonly string[], options: SandboxOptions) {
  assertNotMasking(options.writable);
  const { config, state } = privateXdgRoots();
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  const binds = [...alwaysWritable(), ...options.writable].flatMap(path => ['--bind-try', path, path]);
  const masks = MASKED_HOST_PATHS.flatMap(path => ['--tmpfs', path]);
  return [
    '--user', '--scope', '--quiet',
    '-p', `MemoryMax=${SANDBOX_LIMITS.memoryMax}`,
    '-p', 'MemorySwapMax=0',
    '-p', `TasksMax=${SANDBOX_LIMITS.tasksMax}`,
    '--',
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...binds,
    // Masks come last: a writable bind added after these would reopen the host config it hides.
    ...masks,
    '--die-with-parent',
    '--chdir', options.cwd,
    '--',
    command,
    ...args,
  ];
}

/**
 * Variables a host process (the surface's opencode, a TUI) may carry that must not leak into a sandboxed
 * opencode: an inherited server password makes the nested server reject our unauthenticated client.
 */
const HOST_ONLY_VARIABLES = new Set(['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT']);

/**
 * Environment keys that must always point at the private config/state roots: stripped from both the
 * inherited environment and any caller-supplied env, then set last, so neither source can override them
 * and reopen the masked host paths through an environment variable instead of a bind.
 */
const PROTECTED_PATH_VARIABLES = new Set(['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'OPENCODE_CONFIG_DIR']);

function without(env: NodeJS.ProcessEnv, keys: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.has(key)));
}

/** Exported for tests: the private XDG roots and environment, without spawning anything. */
export function sandboxEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // HOST_ONLY_VARIABLES only ever leak in from this process's own environment (a host opencode's password,
  // config): a caller passing them on purpose (OPENCODE_CONFIG_CONTENT, the per-hire agent config) is legitimate
  // and must survive. PROTECTED_PATH_VARIABLES are stripped from both sources: neither may override them.
  const inherited = without(without(process.env, HOST_ONLY_VARIABLES), PROTECTED_PATH_VARIABLES);
  const caller = without(extra, PROTECTED_PATH_VARIABLES);
  const { config, state } = privateXdgRoots();
  // ONIONSOUP_SANDBOX tells the onionsoup opencode plugin to stay inert while it is loaded from the private config.
  // Tools that insist on a writable temp dir under $HOME get the sandbox's private /tmp instead.
  return {
    ...inherited,
    ANSIBLE_LOCAL_TEMP: '/tmp/ansible-local',
    ...caller,
    ONIONSOUP_SANDBOX: '1',
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    OPENCODE_CONFIG_DIR: join(config, 'opencode'),
  };
}

export function spawnSandboxed(command: string, args: readonly string[], options: SandboxOptions): ChildProcess {
  return spawn('systemd-run', sandboxCommand(command, args, options), {
    env: sandboxEnvironment(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function stopSandboxed(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3_000).unref();
}

export interface SandboxedRun {
  exitCode: number;
  output: string;
}

/** Run a command to completion inside the sandbox, with a wall-clock limit. */
export function runSandboxed(command: string, args: readonly string[], options: SandboxOptions): Promise<SandboxedRun> {
  return new Promise(resolve => {
    const child = spawnSandboxed(command, args, options);
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-SANDBOX_LIMITS.outputChars * 4);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      output += `\n[killed after ${SANDBOX_LIMITS.verifyTimeoutMs / 1000}s]`;
      stopSandboxed(child);
    }, SANDBOX_LIMITS.verifyTimeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : 1);
      const note = signal ? `\n[terminated by ${signal}; a memory-limit kill looks like this]` : '';
      resolve({ exitCode, output: tail(output + note) });
    });
  });
}

export async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no_free_port'))));
    });
  });
}

function tail(text: string) {
  return text.length > SANDBOX_LIMITS.outputChars ? `…${text.slice(-SANDBOX_LIMITS.outputChars)}` : text;
}
