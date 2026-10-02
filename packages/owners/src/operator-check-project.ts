import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveOperatorWriterNode } from './operator-write-writer.ts';
import type { OperatorCheckRuntime, PinnedOperatorCheckMount } from './operator-check-runner.ts';

export const OPERATOR_PROJECT_LIMITS = { profileBytes: 64 * 1024, tools: 128, mounts: 512,
  fileBytes: 256 * 1024 * 1024, totalBytes: 768 * 1024 * 1024, inspectBytes: 1024 * 1024, inspectMs: 10_000 };
const ToolName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/);
const Profile = z.object({ tools: z.record(ToolName, z.string().min(1)).refine(tools =>
  Object.keys(tools).length > 0 && Object.keys(tools).length <= OPERATOR_PROJECT_LIMITS.tools) }).strict();
const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('./operator-project-launcher.mjs', import.meta.url));
const libraryPath = /^\/(?:usr\/)?lib(?:64)?\//;
interface RuntimeInventory {
  mounts: PinnedOperatorCheckMount[];
  evidence: { name: string; binarySha256: string }[];
  libraries: Map<string, string>;
  bytes: number;
  directory?: string;
}

async function readPinned(handle: FileHandle, limit: number, executable: boolean, shippedCode = false) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.mode & (shippedCode ? 0o7000n : 0o7022n) || before.size > BigInt(limit)
    || (executable && !(before.mode & 0o111n))) throw new Error('operator_check_project_runtime_invalid');
  const content = await handle.readFile();
  const after = await handle.stat({ bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error('operator_check_project_runtime_changed');
  }
  return content;
}

async function profile() {
  const path = process.env.ONIONSOUP_PROJECT_TOOLS_FILE;
  if (!path || !isAbsolute(path)) throw new Error('operator_check_project_runtime_unavailable');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const content = await readPinned(handle, OPERATOR_PROJECT_LIMITS.profileBytes, false);
    const parsed = Profile.safeParse(JSON.parse(content.toString('utf8')));
    if (!parsed.success) throw new Error('operator_check_project_profile_invalid');
    for (const tool of Object.values(parsed.data.tools)) {
      if (!isAbsolute(tool) || resolve(tool) !== tool) throw new Error('operator_check_project_profile_invalid');
    }
    return { tools: parsed.data.tools, digest: createHash('sha256').update(content).digest('hex') };
  } finally { await handle.close(); }
}

async function inspect(executable: string, args: string[]) {
  const inspected = await execute(executable, args, { env: { LC_ALL: 'C' },
    timeout: OPERATOR_PROJECT_LIMITS.inspectMs, maxBuffer: OPERATOR_PROJECT_LIMITS.inspectBytes });
  return inspected.stdout;
}

async function libraryCache() {
  const output = await inspect('/usr/sbin/ldconfig', ['-p']);
  const libraries = new Map<string, string>();
  for (const match of output.matchAll(/^\s*(\S+)\s+\([^\n]+\)\s+=>\s+(\/\S+)$/gm)) {
    if (!libraries.has(match[1]!)) libraries.set(match[1]!, match[2]!);
  }
  return libraries;
}

async function snapshot(handle: FileHandle, content: Buffer, inventory: RuntimeInventory) {
  if (!inventory.directory) return handle;
  const path = join(inventory.directory, `project-runtime-${inventory.mounts.length}`);
  await writeFile(path, content, { flag: 'wx', mode: 0o500 });
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
}

async function pin(path: string, destination: string, inventory: RuntimeInventory, executable = false, shippedCode = false) {
  if (inventory.mounts.some(mount => mount.destination === destination)) return undefined;
  if (inventory.mounts.length >= OPERATOR_PROJECT_LIMITS.mounts) throw new Error('operator_check_project_runtime_limit');
  const canonical = await realpath(path);
  const source = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let retained = false;
  try {
    const content = await readPinned(source, OPERATOR_PROJECT_LIMITS.fileBytes, executable, shippedCode);
    inventory.bytes += content.length;
    if (inventory.bytes > OPERATOR_PROJECT_LIMITS.totalBytes) throw new Error('operator_check_project_runtime_limit');
    if (executable && !content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('operator_check_project_executable_not_elf');
    }
    const handle = await snapshot(source, content, inventory);
    retained = handle === source;
    inventory.mounts.push({ handle, destination });
    inventory.evidence.push({ name: destination, binarySha256: createHash('sha256').update(content).digest('hex') });
    return handle;
  } finally { if (!retained) await source.close(); }
}

async function pinLibrary(path: string, inventory: RuntimeInventory) {
  if (!libraryPath.test(path) || !libraryPath.test(await realpath(path))) {
    throw new Error('operator_check_project_library_path_invalid');
  }
  await pinExecutable(path, path, inventory, false);
}

async function pinExecutable(path: string, destination: string, inventory: RuntimeInventory, executable = true) {
  const handle = await pin(path, destination, inventory, executable);
  if (!handle) return;
  // readelf only parses pinned bytes. In contrast to ldd it cannot execute an ELF interpreter on the host.
  const signature = Buffer.alloc(4);
  await handle.read(signature, 0, signature.length, 0);
  if (!signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error('operator_check_project_executable_not_elf');
  }
  const metadata = await inspect('/usr/bin/readelf', ['-l', '-d', `/proc/${process.pid}/fd/${handle.fd}`]);
  const interpreter = metadata.match(/Requesting program interpreter:\s*([^\]]+)\]/)?.[1];
  if (interpreter) await pinLibrary(interpreter, inventory);
  for (const needed of metadata.matchAll(/\(NEEDED\).*Shared library:\s*\[([^\]]+)\]/g)) {
    const library = inventory.libraries.get(needed[1]!);
    if (!library) throw new Error('operator_check_project_library_unavailable');
    await pinLibrary(library, inventory);
  }
}

async function aliasTool(name: string, destination: string, inventory: RuntimeInventory) {
  if (inventory.mounts.length >= OPERATOR_PROJECT_LIMITS.mounts) throw new Error('operator_check_project_runtime_limit');
  const original = inventory.mounts.find(mount => mount.destination === `/runtime/bin/${name}`)!;
  const evidence = inventory.evidence.find(tool => tool.name === original.destination)!;
  const handle = await open(`/proc/self/fd/${original.handle.fd}`, constants.O_RDONLY);
  inventory.mounts.push({ handle, destination });
  inventory.evidence.push({ name: destination, binarySha256: evidence.binarySha256 });
}

async function prepare(directory: string | undefined, mounts: PinnedOperatorCheckMount[]): Promise<OperatorCheckRuntime> {
  const selected = await profile();
  const inventory: RuntimeInventory = { mounts, evidence: [], libraries: await libraryCache(), bytes: 0, directory };
  await pinExecutable(await resolveOperatorWriterNode(), '/runtime/node', inventory);
  // Fixed shipped code has the same trust as this module, like operator-check-guard.mjs.
  await pin(launcher, '/runtime/operator-project-launcher.mjs', inventory, false, true);
  for (const [name, path] of Object.entries(selected.tools).sort(([left], [right]) => left.localeCompare(right))) {
    await pinExecutable(path, `/runtime/bin/${name}`, inventory);
    for (const directory of ['/usr/bin', '/bin']) {
      await aliasTool(name, `${directory}/${name}`, inventory);
    }
  }
  return { executable: '/runtime/node', invocationPrefix: ['/runtime/operator-project-launcher.mjs'],
    environment: { PATH: '/runtime/bin:/runtime', XDG_CONFIG_HOME: '/tmp/home/config', XDG_DATA_HOME: '/tmp/home/data',
      XDG_CACHE_HOME: '/tmp/home/cache', XDG_STATE_HOME: '/tmp/home/state', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_TEMPLATE_DIR: '/tmp/empty-git-template',
      MISE_YES: '1', MISE_OFFLINE: '1', MISE_AUTO_INSTALL: '0' },
    evidence: { kind: 'project', profileSha256: selected.digest, tools: inventory.evidence } };
}

/** Deployment selects tools once; the approved command never selects a host executable path. */
export async function prepareOperatorProjectCheck(directory: string, mounts: PinnedOperatorCheckMount[]) {
  try { return await prepare(directory || undefined, mounts); }
  catch (error) {
    if (error instanceof Error && /^operator_check_project_[a-z_]+$/.test(error.message)) throw error;
    throw new Error('operator_check_project_runtime_invalid');
  }
}

export async function preflightOperatorProjectCheck() {
  const mounts: PinnedOperatorCheckMount[] = [];
  try { await prepareOperatorProjectCheck('', mounts); }
  finally { for (const mount of mounts.reverse()) await mount.handle.close(); }
}
