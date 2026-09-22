import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Every model-driven process and every verification command runs inside a memory-capped systemd scope
 * and a bubblewrap sandbox with a read-only root. Bash allowlists are not a boundary: `cat > file`
 * matches `cat *`. A read-only owner that wrote probe tests and ran them used ~47 GB and got the
 * whole terminal OOM-killed; this is the fix.
 */
export const SANDBOX_LIMITS = { memoryMax: '6G', tasksMax: 512, verifyTimeoutMs: 10 * 60_000, outputChars: 6_000 };

const HOME = homedir();

/** Paths a sandboxed tool may always write: opencode's own state and the Go caches. */
const ALWAYS_WRITABLE = [
  join(HOME, '.local/share/opencode'),
  join(HOME, '.local/state/opencode'),
  join(HOME, '.config/opencode'),
  join(HOME, '.cache'),
  join(HOME, 'go'),
];

export interface SandboxOptions {
  cwd: string;
  writable: readonly string[];
  env?: NodeJS.ProcessEnv;
}

function sandboxCommand(command: string, args: readonly string[], options: SandboxOptions) {
  const binds = [...ALWAYS_WRITABLE, ...options.writable].flatMap(path => ['--bind-try', path, path]);
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
    '--die-with-parent',
    '--chdir', options.cwd,
    '--',
    command,
    ...args,
  ];
}

export function spawnSandboxed(command: string, args: readonly string[], options: SandboxOptions): ChildProcess {
  return spawn('systemd-run', sandboxCommand(command, args, options), {
    env: { ...process.env, ...options.env },
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
