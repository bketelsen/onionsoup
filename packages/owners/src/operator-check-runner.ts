import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { constants as operatingSystem, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { SANDBOX_LIMITS } from './sandbox.ts';
import { OPERATOR_CHECK_LIMITS, OperatorCheckCommand } from './operator-check-types.ts';
import { alreadyMemoryCapped, OPERATOR_WRITER_LIMITS, preflightOperatorFileWriter } from './operator-write-writer.ts';

export const OPERATOR_CHECK_RUNNER_LIMITS = { memoryBytes: OPERATOR_WRITER_LIMITS.memoryBytes,
  tasksMax: SANDBOX_LIMITS.tasksMax, timeoutMs: 60_000, killMs: OPERATOR_WRITER_LIMITS.killMs,
  stopWaitMs: 5_000, exitPollMs: 20,
  sourceFiles: 4_104, sourceBytes: 128 * 1024 * 1024, libraries: 64, temporaryBytes: 256 * 1024 * 1024 };
export interface OperatorCheckSourceFile { path: string; content: Buffer; mode: number }
export interface OperatorCheckRun { exitCode: number; output: string; outputTruncated: boolean }
interface PinnedMount { handle: FileHandle; destination: string }
const execute = promisify(execFile);

function safeSourcePath(path: string) {
  return typeof path === 'string' && path.length > 0 && path.length <= OPERATOR_CHECK_LIMITS.pathChars
    && !path.startsWith('/') && !/[\\\0]/.test(path)
    && path.split('/').every(part => part !== '' && !['.', '..', '.git'].includes(part));
}

function safeSourceMode(mode: number) {
  return Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o100777
    && (mode & ~(constants.S_IFREG | 0o777)) === 0;
}

/** Validate before recording intent; literal source names need not be executable test arguments. */
export function validateOperatorCheckInput(command: string[], sourceFiles: OperatorCheckSourceFile[]) {
  const approved = OperatorCheckCommand.safeParse(command);
  if (!approved.success) throw new Error('operator_check_command_invalid');
  if (!sourceFiles.length || sourceFiles.length > OPERATOR_CHECK_RUNNER_LIMITS.sourceFiles) {
    throw new Error('operator_check_source_limit');
  }
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of sourceFiles) {
    if (!safeSourcePath(file.path) || paths.has(file.path)
      || !Buffer.isBuffer(file.content) || !safeSourceMode(file.mode)) {
      throw new Error('operator_check_source_invalid');
    }
    paths.add(file.path);
    bytes += file.content.length;
  }
  for (const path of paths) {
    const components = path.split('/');
    if (components.slice(1).some((_part, index) => paths.has(components.slice(0, index + 1).join('/')))) {
      throw new Error('operator_check_source_invalid');
    }
  }
  if (bytes > OPERATOR_CHECK_RUNNER_LIMITS.sourceBytes) throw new Error('operator_check_source_limit');
  if (approved.data.slice(2).some(path => !paths.has(path))) throw new Error('operator_check_test_missing');
  return approved.data;
}

async function copySource(directory: string, sourceFiles: OperatorCheckSourceFile[]) {
  for (const file of sourceFiles) {
    const destination = join(directory, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { flag: 'wx', mode: file.mode & 0o777 });
  }
}

async function pinFile(path: string, destination: string, mounts: PinnedMount[]) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  mounts.push({ handle, destination });
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.mode & 0o022) throw new Error('operator_check_runtime_changed');
}

/** Only the trusted Node runtime is inspected; no repository executable runs on the host. */
async function pinRuntime(node: string, mounts: PinnedMount[]) {
  await pinFile(node, '/runtime/node', mounts);
  const libraries = await execute('/usr/bin/ldd', [node], { env: {},
    timeout: OPERATOR_WRITER_LIMITS.timeoutMs, maxBuffer: OPERATOR_WRITER_LIMITS.capabilityOutputBytes })
    .catch(() => { throw new Error('operator_check_libraries_unavailable'); });
  const paths = [...new Set([...libraries.stdout.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(match => match[1]!))];
  if (!paths.length || paths.length > OPERATOR_CHECK_RUNNER_LIMITS.libraries || libraries.stdout.includes('not found')) {
    throw new Error('operator_check_libraries_unavailable');
  }
  for (const path of paths) {
    const canonical = await realpath(path);
    if (!/^\/(?:usr\/)?lib(?:64)?\//.test(path) || !/^\/(?:usr\/)?lib(?:64)?\//.test(canonical)) {
      throw new Error('operator_check_library_path_invalid');
    }
    await pinFile(canonical, path, mounts);
  }
}

/** Read-only capability/runtime checks can fail before durable intent; execution pins fresh handles again. */
export async function preflightOperatorCheck() {
  const { node } = await preflightOperatorFileWriter();
  const mounts: PinnedMount[] = [];
  try { await pinRuntime(node, mounts); }
  finally { for (const mount of mounts.reverse()) await mount.handle.close(); }
}

function bubblewrapArguments(command: string[], mounts: PinnedMount[]) {
  const binds = mounts.flatMap((mount, index) => ['--ro-bind-fd', String(index + 3), mount.destination]);
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    ...binds, '--proc', '/proc', '--dev', '/dev', '--size', String(OPERATOR_CHECK_RUNNER_LIMITS.temporaryBytes),
    '--tmpfs', '/tmp', '--dir', '/tmp/home', '--remount-ro', '/proc', '--remount-ro', '/dev', '--remount-ro', '/',
    '--clearenv', '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/runtime', '--setenv', 'LANG', 'C.UTF-8', '--chdir', '/workspace',
    '--', '/runtime/node', ...command.slice(1)];
}

async function isolatedCommand(command: string[], mounts: PinnedMount[]) {
  const args = bubblewrapArguments(command, mounts);
  const limits = OPERATOR_CHECK_RUNNER_LIMITS;
  if (await alreadyMemoryCapped(limits.memoryBytes, limits.tasksMax)) return { executable: '/usr/bin/bwrap', args };
  return { executable: '/usr/bin/systemd-run', args: ['--user', '--scope', '--quiet',
    '-p', `MemoryMax=${limits.memoryBytes}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${limits.tasksMax}`,
    '--', '/usr/bin/bwrap', ...args] };
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('operator_check_process_uncertain'); }
}

async function waitForGroupExit(pid: number | undefined) {
  if (!pid) return;
  const deadline = Date.now() + OPERATOR_CHECK_RUNNER_LIMITS.killMs;
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new Error('operator_check_process_uncertain');
    }
    signalGroup(pid, 'SIGKILL');
    if (Date.now() >= deadline) throw new Error('operator_check_process_uncertain');
    await new Promise(resolve => setTimeout(resolve, OPERATOR_CHECK_RUNNER_LIMITS.exitPollMs));
  }
}

function failureOutcome(exitCode: number, reason: string,
  captured = { output: '', outputTruncated: false }): OperatorCheckRun {
  const output = `[${reason}]\n${captured.output}`;
  return { exitCode, output: output.slice(0, OPERATOR_CHECK_LIMITS.outputChars),
    outputTruncated: captured.outputTruncated || output.length > OPERATOR_CHECK_LIMITS.outputChars };
}

async function executeCheck(command: Awaited<ReturnType<typeof isolatedCommand>>, mounts: PinnedMount[]): Promise<OperatorCheckRun> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, { detached: true,
        stdio: ['ignore', 'pipe', 'pipe', ...mounts.map(mount => mount.handle.fd)],
        env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
    } catch {
      resolve(failureOutcome(125, 'operator_check_launch_failed'));
      return;
    }
    let output = '';
    let outputTruncated = false;
    let timedOut = false;
    let spawnFailed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      outputTruncated ||= output.length + text.length > OPERATOR_CHECK_LIMITS.outputChars;
      output = (output + text).slice(0, OPERATOR_CHECK_LIMITS.outputChars);
    };
    const signal = (kind: NodeJS.Signals) => {
      try { signalGroup(child.pid, kind); }
      catch { /* Completion still requires independent proof that the process group exited. */ }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), OPERATOR_CHECK_RUNNER_LIMITS.killMs);
      stopTimer = setTimeout(() => reject(new Error('operator_check_process_uncertain')),
        OPERATOR_CHECK_RUNNER_LIMITS.killMs + OPERATOR_CHECK_RUNNER_LIMITS.stopWaitMs);
    }, OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs);
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(stopTimer);
      void waitForGroupExit(child.pid).then(() => {
        const captured = { output, outputTruncated };
        if (spawnFailed) resolve(failureOutcome(125, 'operator_check_launch_failed', captured));
        else if (timedOut) resolve(failureOutcome(124, 'operator_check_timeout', captured));
        else if (signal) resolve(failureOutcome(128 + operatingSystem.signals[signal], 'operator_check_terminated', captured));
        else if (code === null) reject(new Error('operator_check_process_uncertain'));
        else resolve({ exitCode: code, output, outputTruncated });
      }, reject);
    });
  });
}

async function cleanSnapshot(mounts: PinnedMount[], directory: string | undefined) {
  const handles = await Promise.allSettled(mounts.reverse().map(mount => mount.handle.close()));
  let removed = true;
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { removed = false; }
  }
  return removed && handles.every(handle => handle.status === 'fulfilled');
}

/** The host supplies only verified tracked files and receipted creations, never a live checkout mount. */
export async function runOperatorCheck(command: string[], sourceFiles: OperatorCheckSourceFile[]): Promise<OperatorCheckRun> {
  let directory: string | undefined;
  let started = false;
  let outcome: OperatorCheckRun;
  const mounts: PinnedMount[] = [];
  try {
    const approved = validateOperatorCheckInput(command, sourceFiles);
    const { node } = await preflightOperatorFileWriter();
    directory = await mkdtemp(join(tmpdir(), 'operator-check-'));
    await copySource(directory, sourceFiles);
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    mounts.push({ handle, destination: '/workspace' });
    await pinRuntime(node, mounts);
    const launch = await isolatedCommand(approved, mounts);
    started = true;
    outcome = await executeCheck(launch, mounts);
  } catch (error) {
    if (started) {
      await cleanSnapshot(mounts, directory);
      throw error;
    }
    outcome = failureOutcome(125, 'operator_check_setup_failed');
  }
  const cleaned = await cleanSnapshot(mounts, directory);
  return cleaned ? outcome : failureOutcome(125, 'operator_check_cleanup_failed', outcome);
}
