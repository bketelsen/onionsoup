import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { runOperatorFileWriter } from './operator-write-writer.ts';

export const OPERATOR_WRITE_LIMITS = { approvedFiles: 8, trackedFiles: 4096, fileBytes: 256 * 1024, treeBytes: 128 * 1024 * 1024, gitTimeoutMs: 10_000 };
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const FileIdentity = z.object({ path: z.string(), sha256: Hash, bytes: z.number().int().nonnegative(), mode: z.number().int(),
  device: z.number().int(), inode: z.number().int(), links: z.number().int(), kind: z.enum(['file', 'symlink']) });
const DirectoryIdentity = z.object({ path: z.string(), device: z.number().int(), inode: z.number().int() });
export const OperatorWriteSnapshot = z.object({ version: z.literal(1), workspace: z.string(), directory: z.string(), gitDirectory: z.string(),
  head: z.string(), tree: z.string(), indexSha256: Hash, files: z.array(FileIdentity), parents: z.array(DirectoryIdentity),
  approvedPaths: z.array(z.string()), limits: z.object({ approvedFiles: z.number(), trackedFiles: z.number(), fileBytes: z.number(), treeBytes: z.number(), gitTimeoutMs: z.number() }), digest: Hash });
export type OperatorWriteSnapshot = z.infer<typeof OperatorWriteSnapshot>;
export const OperatorWriteMutation = z.object({ id: z.string().min(1), path: z.string(), beforeSha256: Hash, afterSha256: Hash,
  content: z.string(), snapshotDigest: Hash });
export type OperatorWriteMutation = z.infer<typeof OperatorWriteMutation>;
export const OperatorWriteReceipt = z.object({ mutationID: z.string(), path: z.string(), beforeSha256: Hash, afterSha256: Hash,
  snapshotDigest: Hash, digest: Hash });
export type OperatorWriteReceipt = z.infer<typeof OperatorWriteReceipt>;
export const OperatorWriteArtifact = z.object({ snapshotDigest: Hash, head: z.string(), tree: z.string(), diff: z.string(), diffSha256: Hash,
  files: z.array(z.object({ path: z.string(), beforeSha256: Hash, afterSha256: Hash })), digest: Hash });
export type OperatorWriteArtifact = z.infer<typeof OperatorWriteArtifact>;
const execute = promisify(execFile);
export function operatorWriteSha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function digest(value: unknown) { return operatorWriteSha256(JSON.stringify(value)); }
function error(reason: string): never { throw new Error(`operator_write_${reason}`); }

function checkPath(path: string) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) error('path_invalid');
}
function inside(root: string, path: string) {
  const distance = relative(root, path);
  if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) error('outside_workspace');
}
async function git(directory: string, args: string[], limits = OPERATOR_WRITE_LIMITS, allowMissing = false) {
  const reply = await execute('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat', '-c', 'diff.external=', '-C', directory, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8', timeout: limits.gitTimeoutMs, maxBuffer: limits.treeBytes,
  }).catch(failure => {
    if (allowMissing && failure.code === 1) return { stdout: '' };
    return error('git_inspection_failed');
  });
  return reply.stdout;
}
async function repositoryIdentity(directory: string, limits = OPERATOR_WRITE_LIMITS) {
  if (await git(directory, ['config', '--get-regexp', '^filter\\.'], limits, true)) error('git_filters_unsupported');
  if (await git(directory, ['config', '--get-regexp', '^(extensions\\.partial[Cc]lone|remote\\..*\\.promisor)$'], limits, true)) error('partial_clone_unsupported');
  if ((await git(directory, ['config', '--get', 'core.sparseCheckout'], limits, true)).trim() === 'true') error('sparse_unsupported');
  const entries = (await git(directory, ['ls-files', '--stage', '-z'], limits)).split('\0').filter(Boolean);
  if (entries.some(entry => !/^(100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))) error('index_entries_unsupported');
  const flags = (await git(directory, ['ls-files', '-v', '-z'], limits)).split('\0').filter(Boolean);
  if (flags.some(entry => !entry.startsWith('H '))) error('index_flags_unsupported');
  const root = (await git(directory, ['rev-parse', '--show-toplevel'], limits)).trim();
  if (await realpath(root) !== directory) error('repository_root_required');
  const gitDirectory = await realpath((await git(directory, ['rev-parse', '--absolute-git-dir'], limits)).trim());
  const head = (await git(directory, ['rev-parse', '--verify', 'HEAD'], limits)).trim();
  const tree = (await git(directory, ['rev-parse', '--verify', 'HEAD^{tree}'], limits)).trim();
  const index = await lstat(join(gitDirectory, 'index'));
  if (!index.isFile() || index.isSymbolicLink()) error('index_invalid');
  return { gitDirectory, head, tree, indexSha256: operatorWriteSha256(await readFile(join(gitDirectory, 'index'))) };
}
async function parentsOf(directory: string, paths: string[]) {
  const names = new Set(['']);
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== '.') { names.add(parent); parent = dirname(parent); }
  }
  const parents = [];
  for (const path of [...names].sort()) {
    const stat = await lstat(join(directory, path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(join(directory, path)) !== join(directory, path)) error('parent_changed');
    parents.push({ path, device: stat.dev, inode: stat.ino });
  }
  return parents;
}
async function withPinnedParent<T>(directory: string, path: string, action: (target: string) => Promise<T>) {
  checkPath(path);
  const handles: FileHandle[] = [];
  try {
    let parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    const components = path.split('/');
    for (const component of components.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    return await action(`/proc/self/fd/${parent.fd}/${components.at(-1)}`);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
async function pinnedBytes(target: string, maxBytes: number) {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) error('file_invalid');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) error('file_changed');
    return { stat, content: buffer.subarray(0, offset) };
  } finally { await handle.close(); }
}
async function fileIdentity(directory: string, path: string, maxBytes: number) {
  return withPinnedParent(directory, path, async target => {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const link = await readlink(target);
      return { path, sha256: operatorWriteSha256(link), bytes: Buffer.byteLength(link), mode: stat.mode,
        device: stat.dev, inode: stat.ino, links: stat.nlink, kind: 'symlink' as const };
    }
    const opened = await pinnedBytes(target, maxBytes);
    if (opened.stat.dev !== stat.dev || opened.stat.ino !== stat.ino) error('file_changed');
    return { path, sha256: operatorWriteSha256(opened.content), bytes: opened.content.length, mode: opened.stat.mode,
      device: opened.stat.dev, inode: opened.stat.ino, links: opened.stat.nlink, kind: 'file' as const };
  });
}
async function trackedFiles(directory: string, limits: typeof OPERATOR_WRITE_LIMITS) {
  const paths = (await git(directory, ['ls-files', '-z'], limits)).split('\0').filter(Boolean);
  if (!paths.length || paths.length > limits.trackedFiles || new Set(paths).size !== paths.length) error('tracked_files_invalid');
  const files = [];
  let bytes = 0;
  for (const path of paths.sort()) {
    const file = await fileIdentity(directory, path, limits.treeBytes);
    bytes += file.bytes;
    if (bytes > limits.treeBytes) error('tree_too_large');
    files.push(file);
  }
  return files;
}
function textBytes(content: string, maxBytes: number) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > maxBytes || bytes.includes(0) || bytes.toString('utf8') !== content) error('text_invalid');
  return bytes;
}

export async function snapshotOperatorWriteWorkspace(input: { workspace: string; directory: string; files: string[]; limits?: Partial<typeof OPERATOR_WRITE_LIMITS> }): Promise<OperatorWriteSnapshot> {
  const limits = { ...OPERATOR_WRITE_LIMITS, ...input.limits };
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || limit <= 0)) error('limits_invalid');
  const workspace = await realpath(input.workspace);
  const directory = await realpath(input.directory);
  inside(workspace, directory);
  if (!input.files.length || input.files.length > limits.approvedFiles || new Set(input.files).size !== input.files.length) error('scope_invalid');
  input.files.forEach(checkPath);
  const approvedPaths = [...input.files].sort();
  const identity = await repositoryIdentity(directory, limits);
  if (await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'], limits)) error('workspace_dirty');
  const files = await trackedFiles(directory, limits);
  const parents = await parentsOf(directory, files.map(file => file.path));
  for (const path of approvedPaths) {
    const file = files.find(file => file.path === path);
    if (!file || file.kind !== 'file' || file.links !== 1 || file.bytes > limits.fileBytes) error('scope_file_invalid');
    const bytes = (await withPinnedParent(directory, path, target => pinnedBytes(target, limits.fileBytes))).content;
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    textBytes(content, limits.fileBytes);
    if (operatorWriteSha256(bytes) !== file.sha256) error('file_changed');
  }
  if (JSON.stringify(identity) !== JSON.stringify(await repositoryIdentity(directory, limits))) error('repository_changed');
  const snapshot = { version: 1 as const, workspace, directory, ...identity, files, parents, approvedPaths, limits };
  return OperatorWriteSnapshot.parse({ ...snapshot, digest: digest(snapshot) });
}

function expectedFiles(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[]) {
  const expected = new Map(snapshot.files.map(file => [file.path, file.sha256]));
  if (new Set(receipts.map(receipt => receipt.mutationID)).size !== receipts.length) error('receipt_invalid');
  for (const receipt of receipts) {
    const { digest: receiptDigest, ...body } = OperatorWriteReceipt.parse(receipt);
    if (digest(body) !== receiptDigest || receipt.snapshotDigest !== snapshot.digest
      || !snapshot.approvedPaths.includes(receipt.path) || expected.get(receipt.path) !== receipt.beforeSha256) error('receipt_invalid');
    expected.set(receipt.path, receipt.afterSha256);
  }
  return expected;
}
async function inspectWorkspace(snapshot: OperatorWriteSnapshot, expected: Map<string, string>) {
  const { digest: snapshotDigest, ...body } = OperatorWriteSnapshot.parse(snapshot);
  if (digest(body) !== snapshotDigest) error('snapshot_invalid');
  if (await realpath(snapshot.workspace) !== snapshot.workspace || await realpath(snapshot.directory) !== snapshot.directory) error('workspace_changed');
  inside(snapshot.workspace, snapshot.directory);
  const identity = await repositoryIdentity(snapshot.directory, snapshot.limits);
  for (const key of ['gitDirectory', 'head', 'tree', 'indexSha256'] as const) if (identity[key] !== snapshot[key]) error('repository_changed');
  const parents = await parentsOf(snapshot.directory, snapshot.files.map(file => file.path));
  if (JSON.stringify(parents) !== JSON.stringify(snapshot.parents)) error('parent_changed');
  const current = await trackedFiles(snapshot.directory, snapshot.limits);
  if (current.length !== snapshot.files.length) error('source_changed');
  for (const file of current) {
    const original = snapshot.files.find(candidate => candidate.path === file.path);
    if (!original || file.sha256 !== expected.get(file.path) || file.kind !== original.kind || file.mode !== original.mode
      || file.device !== original.device || file.inode !== original.inode || file.links !== original.links) error('source_changed');
  }
  if (await git(snapshot.directory, ['ls-files', '--others', '--exclude-standard', '-z'], snapshot.limits)) error('untracked_files');
}

export async function prepareOperatorFileMutation(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: { id: string; path: string; expectedBeforeSha256: string; content: string }): Promise<OperatorWriteMutation> {
  checkPath(input.path);
  if (!snapshot.approvedPaths.includes(input.path)) error('file_not_approved');
  const expected = expectedFiles(snapshot, receipts);
  if (expected.get(input.path) !== input.expectedBeforeSha256) error('before_digest_mismatch');
  await inspectWorkspace(snapshot, expected);
  const afterSha256 = operatorWriteSha256(textBytes(input.content, snapshot.limits.fileBytes));
  if (afterSha256 === input.expectedBeforeSha256) error('no_change');
  return OperatorWriteMutation.parse({ id: input.id, path: input.path, content: input.content,
    beforeSha256: input.expectedBeforeSha256, afterSha256, snapshotDigest: snapshot.digest });
}

function mutationReceipt(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation): OperatorWriteReceipt {
  const receipt = { mutationID: mutation.id, path: mutation.path, beforeSha256: mutation.beforeSha256,
    afterSha256: mutation.afterSha256, snapshotDigest: snapshot.digest };
  return { ...receipt, digest: digest(receipt) };
}
async function mutationState(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: OperatorWriteMutation) {
  const mutation = OperatorWriteMutation.parse(input);
  const expected = expectedFiles(snapshot, receipts);
  if (mutation.snapshotDigest !== snapshot.digest || !snapshot.approvedPaths.includes(mutation.path)
    || expected.get(mutation.path) !== mutation.beforeSha256 || mutation.beforeSha256 === mutation.afterSha256
    || operatorWriteSha256(textBytes(mutation.content, snapshot.limits.fileBytes)) !== mutation.afterSha256) error('mutation_invalid');
  const current = await fileIdentity(snapshot.directory, mutation.path, snapshot.limits.fileBytes);
  if (![mutation.beforeSha256, mutation.afterSha256].includes(current.sha256)) error('mutation_uncertain');
  expected.set(mutation.path, current.sha256);
  await inspectWorkspace(snapshot, expected);
  return { mutation, current, expected };
}
/** Disk observation is diagnostic; it does not prove that an uncertain prior writer has exited. */
export async function inspectOperatorFileMutation(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: OperatorWriteMutation) {
  const { mutation, current } = await mutationState(snapshot, receipts, input);
  if (current.sha256 === mutation.afterSha256) return { status: 'applied' as const, receipt: mutationReceipt(snapshot, mutation) };
  return { status: 'not-applied' as const };
}

/** Caller durably records intent first and must never re-enter while a previous writer may still run. */
export async function applyOperatorFileMutation(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: OperatorWriteMutation): Promise<OperatorWriteReceipt> {
  const { mutation, current, expected } = await mutationState(snapshot, receipts, input);
  if (current.sha256 !== mutation.afterSha256) await runOperatorFileWriter(snapshot, mutation, current);
  expected.set(mutation.path, mutation.afterSha256);
  await inspectWorkspace(snapshot, expected);
  return mutationReceipt(snapshot, mutation);
}

export async function operatorWriteArtifact(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[]): Promise<OperatorWriteArtifact> {
  const expected = expectedFiles(snapshot, receipts);
  await inspectWorkspace(snapshot, expected);
  const diff = await git(snapshot.directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', ...snapshot.approvedPaths], snapshot.limits);
  await inspectWorkspace(snapshot, expected);
  const artifact = { snapshotDigest: snapshot.digest, head: snapshot.head, tree: snapshot.tree, diff, diffSha256: operatorWriteSha256(diff),
    files: snapshot.files.filter(file => snapshot.approvedPaths.includes(file.path)).map(file => ({ path: file.path, beforeSha256: file.sha256, afterSha256: expected.get(file.path)! })) };
  return { ...artifact, digest: digest(artifact) };
}
