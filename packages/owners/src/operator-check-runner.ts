import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { constants as operatingSystem, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SANDBOX_LIMITS } from './sandbox.ts';
import { OPERATOR_CHECK_LIMITS, OperatorCheckCommand, operatorCheckKind,
  validateOperatorCheckSourcePaths, type OperatorCheckRuntimeEvidence } from './operator-check-types.ts';
import { alreadyMemoryCapped, OPERATOR_WRITER_LIMITS, preflightOperatorFileWriter,
  requireOperatorWriterBwrapFeatures } from './operator-write-writer.ts';
import { preflightOperatorGoCheck, prepareOperatorGoCheck } from './operator-check-go.ts';
import { operatorNamespaceWitness } from './operator-check-process.ts';
import type { OperatorCheckWitness } from './operator-check-execution.ts';

export const OPERATOR_CHECK_RUNNER_LIMITS = { memoryBytes: OPERATOR_WRITER_LIMITS.memoryBytes,
  tasksMax: SANDBOX_LIMITS.tasksMax, timeoutMs: 60_000, killMs: OPERATOR_WRITER_LIMITS.killMs,
  stopWaitMs: 5_000, exitPollMs: 20,
  sourceFiles: 4_104, sourceBytes: 128 * 1024 * 1024, libraries: 64, temporaryBytes: 256 * 1024 * 1024 };
export interface OperatorCheckSourceFile { path: string; content: Buffer; mode: number }
export interface OperatorCheckRun { exitCode: number; output: string; outputTruncated: boolean; runtime?: OperatorCheckRuntimeEvidence }
export interface OperatorCheckExecutionOptions { onWitness(witness: OperatorCheckWitness): Promise<void> }
export interface PinnedOperatorCheckMount { handle: FileHandle; destination: string }
export interface OperatorCheckRuntime { executable: string; environment: Record<string, string>; evidence?: OperatorCheckRuntimeEvidence }
interface CheckAdapter {
  preflight(): Promise<void>;
  prepare(directory: string, mounts: PinnedOperatorCheckMount[]): Promise<OperatorCheckRuntime>;
}
const execute = promisify(execFile);
const guard = fileURLToPath(new URL('./operator-check-guard.mjs', import.meta.url));

const goAdapter: CheckAdapter = { preflight: preflightOperatorGoCheck, prepare: prepareOperatorGoCheck };
const adapters: Record<ReturnType<typeof operatorCheckKind>, CheckAdapter> = {
  'node-test': { preflight: preflightNodeCheck, prepare: prepareNodeCheck },
  'go-test': goAdapter,
  'go-vet': goAdapter,
};

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
  validateOperatorCheckSourcePaths(approved.data, paths);
  return approved.data;
}

async function copySource(directory: string, sourceFiles: OperatorCheckSourceFile[]) {
  for (const file of sourceFiles) {
    const destination = join(directory, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { flag: 'wx', mode: file.mode & 0o777 });
  }
}

async function pinFile(path: string, destination: string, mounts: PinnedOperatorCheckMount[]) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  mounts.push({ handle, destination });
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.mode & 0o022) throw new Error('operator_check_runtime_changed');
}

/** Only the trusted Node runtime is inspected; no repository executable runs on the host. */
async function pinRuntime(node: string, mounts: PinnedOperatorCheckMount[]) {
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
async function preflightNodeCheck() {
  const { node } = await preflightOperatorFileWriter();
  const mounts: PinnedOperatorCheckMount[] = [];
  try { await pinRuntime(node, mounts); }
  finally { for (const mount of mounts.reverse()) await mount.handle.close(); }
}

async function prepareNodeCheck(_directory: string, mounts: PinnedOperatorCheckMount[]) {
  const { node } = await preflightOperatorFileWriter();
  await pinRuntime(node, mounts);
  return { executable: '/runtime/node', environment: {} };
}

async function pinGuard(mounts: PinnedOperatorCheckMount[]) {
  const handle = await open(guard, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  mounts.push({ handle, destination: '/runtime/operator-check-guard.mjs' });
  // This is fixed host code shipped with this module, like the existing fixed file writer helper.
  if (!(await handle.stat()).isFile()) throw new Error('operator_check_runtime_changed');
}

export async function preflightOperatorCheck(command = ['node', '--test', 'preflight.test.mjs']) {
  const approved = OperatorCheckCommand.safeParse(command);
  if (!approved.success) throw new Error('operator_check_command_invalid');
  const help = await execute('/usr/bin/bwrap', ['--help'], { env: {}, timeout: OPERATOR_WRITER_LIMITS.timeoutMs,
    maxBuffer: OPERATOR_WRITER_LIMITS.capabilityOutputBytes }).catch(() => { throw new Error('operator_check_bwrap_unavailable'); });
  requireOperatorWriterBwrapFeatures(help.stdout);
  await adapters[operatorCheckKind(approved.data)].preflight();
}

function bubblewrapArguments(command: string[], mounts: PinnedOperatorCheckMount[], runtime: OperatorCheckRuntime, guarded: boolean) {
  const binds = mounts.flatMap((mount, index) => ['--ro-bind-fd', String(index + 3), mount.destination]);
  const environment = Object.entries(runtime.environment).flatMap(([key, value]) => ['--setenv', key, value]);
  const invocation = [runtime.executable, ...command.slice(1)];
  if (guarded) invocation.unshift('/runtime/node', '/runtime/operator-check-guard.mjs');
  // The parent pins namespace init before releasing execution, then proves its death even after forced shutdown.
  return ['--unshare-all', '--as-pid-1', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--info-fd', String(mounts.length + 3), '--block-fd', String(mounts.length + 4),
    ...binds, '--proc', '/proc', '--dev', '/dev', '--size', String(OPERATOR_CHECK_RUNNER_LIMITS.temporaryBytes),
    '--tmpfs', '/tmp', '--dir', '/tmp/home', '--remount-ro', '/proc', '--remount-ro', '/dev', '--remount-ro', '/',
    '--clearenv', '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/runtime', '--setenv', 'LANG', 'C.UTF-8', ...environment, '--chdir', '/workspace',
    '--', ...invocation];
}

async function isolatedCommand(command: string[], mounts: PinnedOperatorCheckMount[], runtime: OperatorCheckRuntime, guarded: boolean) {
  const args = bubblewrapArguments(command, mounts, runtime, guarded);
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

async function executeCheck(command: Awaited<ReturnType<typeof isolatedCommand>>, mounts: PinnedOperatorCheckMount[],
  options?: OperatorCheckExecutionOptions): Promise<OperatorCheckRun> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, { detached: true,
        stdio: [options ? 'pipe' : 'ignore', 'pipe', 'pipe', ...mounts.map(mount => mount.handle.fd), 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
    } catch {
      resolve(failureOutcome(125, 'operator_check_launch_failed'));
      return;
    }
    let output = '';
    const namespace = operatorNamespaceWitness(child, mounts.length + 3, mounts.length + 4, options?.onWitness);
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
      let groupExited = false;
      void waitForGroupExit(child.pid).then(async () => {
        groupExited = true;
        const released = await namespace.wait();
        const captured = { output, outputTruncated };
        if (spawnFailed) resolve(failureOutcome(125, 'operator_check_launch_failed', captured));
        else if (!released) resolve(failureOutcome(125, 'operator_check_setup_failed', captured));
        else if (timedOut) resolve(failureOutcome(124, 'operator_check_timeout', captured));
        else if (signal) resolve(failureOutcome(128 + operatingSystem.signals[signal], 'operator_check_terminated', captured));
        else if (code === null) reject(new Error('operator_check_process_uncertain'));
        else resolve({ exitCode: code, output, outputTruncated });
      }).catch(reject).finally(() => namespace.close(groupExited)).catch(reject);
    });
  });
}

async function cleanSnapshot(mounts: PinnedOperatorCheckMount[], directory: string | undefined) {
  const handles = await Promise.allSettled(mounts.reverse().map(mount => mount.handle.close()));
  let removed = true;
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { removed = false; }
  }
  return removed && handles.every(handle => handle.status === 'fulfilled');
}

/** The host supplies only verified tracked files and receipted creations, never a live checkout mount. */
export async function runOperatorCheck(command: string[], sourceFiles: OperatorCheckSourceFile[],
  options?: OperatorCheckExecutionOptions): Promise<OperatorCheckRun> {
  let directory: string | undefined;
  let started = false;
  let outcome: OperatorCheckRun;
  const mounts: PinnedOperatorCheckMount[] = [];
  try {
    const approved = validateOperatorCheckInput(command, sourceFiles);
    directory = await mkdtemp(join(tmpdir(), 'operator-check-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace, { mode: 0o700 });
    await copySource(workspace, sourceFiles);
    const handle = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    mounts.push({ handle, destination: '/workspace' });
    const runtime = await adapters[operatorCheckKind(approved)].prepare(directory, mounts);
    if (options) {
      if (operatorCheckKind(approved) !== 'node-test') await prepareNodeCheck(directory, mounts);
      await pinGuard(mounts);
    }
    const launch = await isolatedCommand(approved, mounts, runtime, !!options);
    started = true;
    outcome = await executeCheck(launch, mounts, options);
    if (runtime.evidence) outcome.runtime = runtime.evidence;
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
