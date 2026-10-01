import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { OperatorWriteMutation, OperatorWriteSnapshot } from './operator-write-workspace.ts';

export const OPERATOR_WRITER_LIMITS = { memoryBytes: 6 * 1024 ** 3, outerMemoryBytes: 12 * 1024 ** 3, timeoutMs: 15_000, killMs: 1_000, outputBytes: 4096, capabilityOutputBytes: 16 * 1024 };
const helper = fileURLToPath(new URL('./operator-write-file.mjs', import.meta.url));

const execute = promisify(execFile);

/** Surface supplies its real Node path; OpenCode/Bun's executable and model-controlled PATH are never used. */
export async function resolveOperatorWriterNode(): Promise<string> {
  const candidate = process.env.ONIONSOUP_HOST_NODE ?? (process.versions.bun ? undefined : process.execPath);
  if (!candidate || !isAbsolute(candidate)) throw new Error('operator_write_node_unavailable');
  const canonical = await realpath(candidate).catch(() => undefined);
  if (!canonical || !['node', 'nodejs'].includes(basename(canonical))) throw new Error('operator_write_node_invalid');
  const metadata = await stat(canonical);
  if (!metadata.isFile() || metadata.mode & 0o022) throw new Error('operator_write_node_invalid');
  const probe = await execute(canonical, ['--input-type=module', '-e',
    'if (!process.versions.node || process.versions.bun) process.exit(1); process.stdout.write(process.execPath);'], {
    env: {}, timeout: OPERATOR_WRITER_LIMITS.timeoutMs, maxBuffer: OPERATOR_WRITER_LIMITS.outputBytes,
  }).catch(() => undefined);
  if (!probe || await realpath(probe.stdout).catch(() => undefined) !== canonical) throw new Error('operator_write_node_invalid');
  return canonical;
}

export function requireOperatorWriterBwrapFeatures(help: string) {
  if (!/^\s+--bind-fd\s/m.test(help) || !/^\s+--ro-bind-fd\s/m.test(help)) {
    throw new Error('operator_write_bwrap_unsupported: bubblewrap >= 0.10 with descriptor binds is required');
  }
}

/** Read-only host checks run before durable mutation intent; old bubblewrap never falls back to pathname binds. */
export async function preflightOperatorFileWriter() {
  const node = await resolveOperatorWriterNode();
  const help = await execute('/usr/bin/bwrap', ['--help'], { env: {}, timeout: OPERATOR_WRITER_LIMITS.timeoutMs,
    maxBuffer: OPERATOR_WRITER_LIMITS.capabilityOutputBytes }).catch(() => undefined);
  if (!help) throw new Error('operator_write_bwrap_unavailable');
  requireOperatorWriterBwrapFeatures(help.stdout);
  return { node };
}

/** A nested staging sandbox may reuse an already enforced memory cgroup, never a caller's environment flag. */
async function alreadyMemoryCapped() {
  try {
    const membership = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!membership || membership.split('/').includes('..')) return false;
    let directory = join('/sys/fs/cgroup', membership);
    while (directory.startsWith('/sys/fs/cgroup')) {
      const value = await readFile(join(directory, 'memory.max'), 'utf8').catch(() => 'max');
      const limit = Number(value.trim());
      if (Number.isSafeInteger(limit) && limit > 0 && limit <= OPERATOR_WRITER_LIMITS.outerMemoryBytes) return true;
      if (directory === '/sys/fs/cgroup') return false;
      directory = dirname(directory);
    }
  } catch { /* Unavailable proof requires a new scope. */ }
  return false;
}

export async function operatorWriterCommand() {
  const { node } = await preflightOperatorFileWriter();
  const args = ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--bind-fd', '3', '/tmp/operator-approved-file',
    '--ro-bind-fd', '4', '/tmp/operator-write-file.mjs', '--ro-bind-fd', '5', '/tmp/operator-node',
    '--die-with-parent', '--new-session', '--clearenv',
    '--', '/tmp/operator-node', '--max-old-space-size=128', '/tmp/operator-write-file.mjs'];
  if (await alreadyMemoryCapped()) return { command: '/usr/bin/bwrap', args, node };
  return { command: '/usr/bin/systemd-run', node, args: ['--user', '--scope', '--quiet', '-p', `MemoryMax=${OPERATOR_WRITER_LIMITS.memoryBytes}`,
    '-p', 'MemorySwapMax=0', '-p', 'TasksMax=32', '--', '/usr/bin/bwrap', ...args] };
}

async function openPinnedFile(snapshot: OperatorWriteSnapshot, path: string) {
  const handles: FileHandle[] = [];
  try {
    let directory = await open(snapshot.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(directory);
    const components = path.split('/');
    const directories = ['', ...components.slice(0, -1).map((_part, index) => components.slice(0, index + 1).join('/'))];
    for (let index = 0; index < directories.length; index++) {
      if (index) {
        directory = await open(`/proc/self/fd/${directory.fd}/${components[index - 1]}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(directory);
      }
      const stat = await directory.stat();
      const expected = snapshot.parents.find(parent => parent.path === directories[index]);
      if (!expected || stat.dev !== expected.device || stat.ino !== expected.inode) throw new Error('operator_write_parent_changed');
    }
    const file = await open(`/proc/self/fd/${directory.fd}/${components.at(-1)}`, constants.O_RDWR | constants.O_NOFOLLOW);
    handles.push(file);
    const stat = await file.stat();
    const expected = snapshot.files.find(file => file.path === path);
    if (!expected || !stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.device || stat.ino !== expected.inode
      || stat.mode !== expected.mode) throw new Error('operator_write_file_changed');
    return { file, close: async () => { for (const handle of handles.reverse()) await handle.close(); } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}

async function executeWriterProcess(command: Awaited<ReturnType<typeof operatorWriterCommand>>, fds: number[], payload: object) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe', ...fds], detached: true,
      env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
    let output = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (kind: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, kind); } catch { /* Exited. */ } } };
    const timeout = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), OPERATOR_WRITER_LIMITS.killMs);
    }, OPERATOR_WRITER_LIMITS.timeoutMs);
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(0, OPERATOR_WRITER_LIMITS.outputBytes); });
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => {});
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (timedOut || code !== 0 || output.trim() !== 'operator_write_applied') reject(new Error('operator_write_writer_uncertain'));
      else resolve();
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** Pin code and runtime as read-only files after /tmp is masked, including staged releases located under /tmp. */
async function executeWriter(fd: number, payload: object) {
  const command = await operatorWriterCommand();
  const handles: FileHandle[] = [];
  try {
    for (const path of [helper, command.node]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      const metadata = await handle.stat();
      if (!metadata.isFile() || path === command.node && metadata.mode & 0o022) throw new Error('operator_write_runtime_changed');
    }
    await executeWriterProcess(command, [fd, ...handles.map(handle => handle.fd)], payload);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

/** The descriptor bind cannot be redirected by replacing a pathname after validation. */
export async function runOperatorFileWriter(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation,
  identity: { device: number; inode: number; mode: number }) {
  const pinned = await openPinnedFile(snapshot, mutation.path);
  try {
    await executeWriter(pinned.file.fd, { ...mutation, ...identity, maxBytes: snapshot.limits.fileBytes });
  } finally { await pinned.close(); }
}
