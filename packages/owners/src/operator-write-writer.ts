import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { OperatorWriteMutation, OperatorWriteSnapshot } from './operator-write-workspace.ts';

export const OPERATOR_WRITER_LIMITS = { memoryBytes: 6 * 1024 ** 3, outerMemoryBytes: 12 * 1024 ** 3, timeoutMs: 15_000, killMs: 1_000, outputBytes: 4096 };
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
  const node = await resolveOperatorWriterNode();
  const args = ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--bind-fd', '3', '/tmp/operator-approved-file', '--die-with-parent', '--new-session', '--clearenv',
    '--', node, '--max-old-space-size=128', helper];
  if (await alreadyMemoryCapped()) return { command: '/usr/bin/bwrap', args };
  return { command: '/usr/bin/systemd-run', args: ['--user', '--scope', '--quiet', '-p', `MemoryMax=${OPERATOR_WRITER_LIMITS.memoryBytes}`,
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

async function executeWriter(fd: number, payload: object) {
  const command = await operatorWriterCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe', fd], detached: true,
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

/** The descriptor bind cannot be redirected by replacing a pathname after validation. */
export async function runOperatorFileWriter(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation,
  identity: { device: number; inode: number; mode: number }) {
  const pinned = await openPinnedFile(snapshot, mutation.path);
  try {
    await executeWriter(pinned.file.fd, { ...mutation, ...identity, maxBytes: snapshot.limits.fileBytes });
  } finally { await pinned.close(); }
}
