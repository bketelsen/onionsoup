import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inheritedCgroupBudget } from './cgroup-budget.ts';
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
export async function alreadyMemoryCapped(maxBytes = OPERATOR_WRITER_LIMITS.outerMemoryBytes, tasksMax?: number) {
  return inheritedCgroupBudget({ memoryBytes: maxBytes, tasksMax });
}

export async function operatorWriterCommand(create = false) {
  const { node } = await preflightOperatorFileWriter();
  const args = ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--bind-fd', '3', create ? '/tmp/operator-approved-parent' : '/tmp/operator-approved-file',
    '--ro-bind-fd', '4', '/tmp/operator-write-file.mjs', '--ro-bind-fd', '5', '/tmp/operator-node',
    '--die-with-parent', '--new-session', '--clearenv',
    '--', '/tmp/operator-node', '--max-old-space-size=128', '/tmp/operator-write-file.mjs'];
  if (await alreadyMemoryCapped()) return { command: '/usr/bin/bwrap', args, node };
  return { command: '/usr/bin/systemd-run', node, args: ['--user', '--scope', '--quiet', '-p', `MemoryMax=${OPERATOR_WRITER_LIMITS.memoryBytes}`,
    '-p', 'MemorySwapMax=0', '-p', 'TasksMax=32', '--', '/usr/bin/bwrap', ...args] };
}

async function openPinnedParent(snapshot: OperatorWriteSnapshot, path: string) {
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
    return { directory, close: async () => { for (const handle of handles.reverse()) await handle.close(); } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}

async function openPinnedFile(snapshot: OperatorWriteSnapshot, path: string, identity: { device: number; inode: number; mode: number; birthtimeNs?: string }) {
  const pinned = await openPinnedParent(snapshot, path);
  let file: FileHandle | undefined;
  try {
    file = await open(`/proc/self/fd/${pinned.directory.fd}/${basename(path)}`, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = await file.stat();
    const expected = snapshot.files.find(file => file.path === path) ?? identity;
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.device || stat.ino !== expected.inode
      || stat.mode !== expected.mode) throw new Error('operator_write_file_changed');
    if (expected.birthtimeNs && (await file.stat({ bigint: true })).birthtimeNs.toString() !== expected.birthtimeNs) {
      throw new Error('operator_write_file_changed');
    }
    const handle = file;
    return { file: handle, close: async () => {
      await handle.close();
      await pinned.close();
    } };
  } catch (error) {
    await file?.close();
    await pinned.close();
    throw error;
  }
}

async function executeWriterProcess(command: Awaited<ReturnType<typeof operatorWriterCommand>>, fds: number[], payload: object) {
  return new Promise<unknown>((resolve, reject) => {
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
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (timedOut || code !== 0) {
        reject(new Error('operator_write_writer_uncertain'));
        return;
      }
      if (output.trim() === 'operator_write_applied') {
        resolve(undefined);
        return;
      }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('operator_write_writer_uncertain')); }
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** Pin code and runtime as read-only files after /tmp is masked, including staged releases located under /tmp. */
async function executeWriter(fd: number, payload: object, create = false) {
  const command = await operatorWriterCommand(create);
  const handles: FileHandle[] = [];
  try {
    for (const path of [helper, command.node]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      const metadata = await handle.stat();
      if (!metadata.isFile() || path === command.node && metadata.mode & 0o022) throw new Error('operator_write_runtime_changed');
    }
    return await executeWriterProcess(command, [fd, ...handles.map(handle => handle.fd)], payload);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

/** Only the fixed helper receives the pinned parent for an explicitly approved exclusive creation. */
async function runCreator(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation) {
  if (!(snapshot.createFiles ?? []).includes(mutation.path)) throw new Error('operator_write_creation_not_approved');
  const pinned = await openPinnedParent(snapshot, mutation.path);
  try {
    const parent = await pinned.directory.stat();
    return await executeWriter(pinned.directory.fd, { ...mutation, filename: basename(mutation.path),
      parent: { device: parent.dev, inode: parent.ino }, maxBytes: snapshot.limits.fileBytes }, true);
  } finally { await pinned.close(); }
}

/** The descriptor bind cannot be redirected by replacing a pathname after validation. */
export async function runOperatorFileWriter(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation,
  identity?: { device: number; inode: number; mode: number; birthtimeNs?: string }) {
  if (mutation.beforeSha256 === 'absent') return runCreator(snapshot, mutation);
  if (!identity) throw new Error('operator_write_identity_required');
  const pinned = await openPinnedFile(snapshot, mutation.path, identity);
  try {
    return await executeWriter(pinned.file.fd, { ...mutation, ...identity, maxBytes: snapshot.limits.fileBytes });
  } finally { await pinned.close(); }
}
