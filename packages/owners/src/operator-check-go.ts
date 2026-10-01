import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { OperatorGoVersion } from './operator-check-types.ts';
import type { OperatorCheckRuntime, PinnedOperatorCheckMount } from './operator-check-runner.ts';

export const OPERATOR_GO_LIMITS = { runtimeFiles: 16_384, runtimeBytes: 512 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024, runtimeDepth: 32, runtimeEntries: 32_768, versionBytes: 256 };
const architecture: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
const environment = { GOROOT: '/goroot', GOCACHE: '/tmp/go-cache', GOMODCACHE: '/tmp/go-mod-cache',
  GOPATH: '/tmp/go', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOWORK: 'off', GOENV: 'off',
  CGO_ENABLED: '0', GOFLAGS: '-mod=readonly', GOTELEMETRY: 'off' };
interface RuntimeCopy { files: number; bytes: number; entries: number; destination?: string }

async function trustedDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || metadata.mode & 0o7022) throw new Error('operator_check_go_runtime_invalid');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function withDirectory<T>(root: FileHandle, path: string, action: (handle: FileHandle) => Promise<T>) {
  const handles: FileHandle[] = [];
  try {
    let parent = root;
    for (const component of path.split('/')) {
      parent = await trustedDirectory(`/proc/self/fd/${parent.fd}/${component}`);
      handles.push(parent);
    }
    return await action(parent);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

function includedRuntimePath(path: string) {
  return path !== 'src/cmd' && !path.split('/').includes('testdata') && !path.endsWith('_test.go');
}

async function copyRuntimeFile(parent: FileHandle, name: string, path: string, copy: RuntimeCopy) {
  const handle = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.mode & 0o7022n || before.size > BigInt(OPERATOR_GO_LIMITS.fileBytes)) {
      throw new Error('operator_check_go_runtime_invalid');
    }
    if (path === 'bin/go' || path.startsWith('pkg/tool/')) {
      const signature = Buffer.alloc(4);
      await handle.read(signature, 0, signature.length, 0);
      if (!before.mode || !(before.mode & 0o111n) || !signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        throw new Error('operator_check_go_runtime_invalid');
      }
    }
    copy.files++;
    copy.bytes += Number(before.size);
    if (copy.files > OPERATOR_GO_LIMITS.runtimeFiles || copy.bytes > OPERATOR_GO_LIMITS.runtimeBytes) {
      throw new Error('operator_check_go_runtime_limit');
    }
    if (copy.destination) {
      await copyFile(`/proc/self/fd/${handle.fd}`, join(copy.destination, path), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('operator_check_go_runtime_changed');
    }
  } finally { await handle.close(); }
}

async function walkRuntime(parent: FileHandle, path: string, copy: RuntimeCopy) {
  if (path.split('/').length > OPERATOR_GO_LIMITS.runtimeDepth) throw new Error('operator_check_go_runtime_limit');
  if (copy.destination) await mkdir(join(copy.destination, path), { recursive: true, mode: 0o700 });
  const entries = await readdir(`/proc/self/fd/${parent.fd}`, { withFileTypes: true });
  copy.entries += entries.length;
  if (copy.entries > OPERATOR_GO_LIMITS.runtimeEntries) throw new Error('operator_check_go_runtime_limit');
  for (const entry of entries) {
    const child = `${path}/${entry.name}`;
    if (!includedRuntimePath(child)) continue;
    if (entry.isDirectory()) {
      await withDirectory(parent, entry.name, handle => walkRuntime(handle, child, copy));
    } else {
      if (!entry.isFile()) throw new Error('operator_check_go_runtime_invalid');
      await copyRuntimeFile(parent, entry.name, child, copy);
    }
  }
}

async function goVersion(root: FileHandle) {
  const handle = await open(`/proc/self/fd/${root.fd}/VERSION`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.mode & 0o7022n || before.size > BigInt(OPERATOR_GO_LIMITS.versionBytes)) {
      throw new Error('operator_check_go_runtime_invalid');
    }
    const content = Buffer.alloc(OPERATOR_GO_LIMITS.versionBytes);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    const version = content.subarray(0, bytesRead).toString('utf8').split('\n')[0]!;
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || !OperatorGoVersion.safeParse(version).success) {
      throw new Error('operator_check_go_runtime_invalid');
    }
    return version;
  } finally { await handle.close(); }
}

async function inspectGoRuntime(destination?: string) {
  const selected = process.env.ONIONSOUP_HOST_GO_ROOT;
  if (!selected || !isAbsolute(selected)) throw new Error('operator_check_go_runtime_unavailable');
  if (process.platform !== 'linux' || !architecture[process.arch]) throw new Error('operator_check_go_platform_unsupported');
  const rootPath = await realpath(selected).catch(() => { throw new Error('operator_check_go_runtime_unavailable'); });
  if (rootPath !== selected || resolve(selected) !== selected) throw new Error('operator_check_go_runtime_invalid');
  const root = await trustedDirectory(rootPath);
  const copy: RuntimeCopy = { files: 0, bytes: 0, entries: 0, destination };
  try {
    const version = await goVersion(root);
    if (destination) await mkdir(join(destination, 'bin'), { recursive: true, mode: 0o700 });
    await copyRuntimeFile(root, 'VERSION', 'VERSION', copy);
    await withDirectory(root, 'bin', handle => copyRuntimeFile(handle, 'go', 'bin/go', copy));
    for (const path of ['src', `pkg/tool/linux_${architecture[process.arch]}`, 'pkg/include', 'lib/time']) {
      await withDirectory(root, path, handle => walkRuntime(handle, path, copy));
    }
    return version;
  } finally { await root.close(); }
}

/** Host configuration chooses the toolchain; requests cannot select a host path or inherit a Go configuration. */
export async function preflightOperatorGoCheck() {
  try { await inspectGoRuntime(); }
  catch (error) {
    if (error instanceof Error && /^operator_check_go_[a-z_]+$/.test(error.message)) throw error;
    throw new Error('operator_check_go_runtime_invalid');
  }
}

/** Copy through pinned descriptors: replacing nested host entries cannot redirect the sandbox's runtime. */
export async function prepareOperatorGoCheck(directory: string, mounts: PinnedOperatorCheckMount[]): Promise<OperatorCheckRuntime> {
  const destination = join(directory, 'go-runtime');
  await inspectGoRuntime(destination);
  const handle = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  mounts.push({ handle, destination: '/goroot' });
  const version = await goVersion(handle);
  const binarySha256 = createHash('sha256').update(await readFile(join(destination, 'bin/go'))).digest('hex');
  return { executable: '/goroot/bin/go', environment, evidence: { kind: 'go', version, binarySha256 } };
}
