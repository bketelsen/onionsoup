import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { preflightOperatorFileWriter, runOperatorFileWriter } from './operator-write-writer.ts';

export const OPERATOR_WRITE_LIMITS = { approvedFiles: 8, trackedFiles: 4096, fileBytes: 256 * 1024, treeBytes: 128 * 1024 * 1024, gitTimeoutMs: 10_000 };
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BeforeHash = z.union([Hash, z.literal('absent')]);
const FileIdentity = z.object({ path: z.string(), sha256: Hash, bytes: z.number().int().nonnegative(), mode: z.number().int(),
  device: z.number().int(), inode: z.number().int(), links: z.number().int(), kind: z.enum(['file', 'symlink']), birthtimeNs: z.string().regex(/^[1-9][0-9]*$/).optional() });
type FileIdentity = z.infer<typeof FileIdentity>;
const DirectoryIdentity = z.object({ path: z.string(), device: z.number().int(), inode: z.number().int() });
export const OperatorWriteSnapshot = z.object({ version: z.literal(1), workspace: z.string(), directory: z.string(), gitDirectory: z.string(),
  head: z.string(), tree: z.string(), indexSha256: Hash, files: z.array(FileIdentity), parents: z.array(DirectoryIdentity),
  approvedPaths: z.array(z.string()), limits: z.object({ approvedFiles: z.number(), trackedFiles: z.number(), fileBytes: z.number(), treeBytes: z.number(), gitTimeoutMs: z.number() }), createFiles: z.array(z.string()).optional(), digest: Hash });
export type OperatorWriteSnapshot = z.infer<typeof OperatorWriteSnapshot>;
export const OperatorWriteMutation = z.object({ id: z.string().min(1), path: z.string(), beforeSha256: BeforeHash, afterSha256: Hash,
  content: z.string(), snapshotDigest: Hash });
export type OperatorWriteMutation = z.infer<typeof OperatorWriteMutation>;
export const OperatorWriteReceipt = z.object({ mutationID: z.string(), path: z.string(), beforeSha256: BeforeHash, afterSha256: Hash,
  snapshotDigest: Hash, created: FileIdentity.optional(), digest: Hash });
export type OperatorWriteReceipt = z.infer<typeof OperatorWriteReceipt>;
export const OperatorWriteArtifact = z.object({ snapshotDigest: Hash, head: z.string(), tree: z.string(), diff: z.string(), diffSha256: Hash,
  files: z.array(z.object({ path: z.string(), beforeSha256: BeforeHash, afterSha256: Hash })), digest: Hash });
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
async function git(directory: string, args: string[], limits = OPERATOR_WRITE_LIMITS, allowMissing = false, allowDifference = false): Promise<string> {
  const reply = await execute('/usr/bin/git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat', '-c', 'diff.external=', '-C', directory, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8', timeout: limits.gitTimeoutMs, maxBuffer: limits.treeBytes,
  }).catch(failure => {
    if (allowDifference && failure.code === 1 && typeof failure.stdout === 'string') return { stdout: failure.stdout };
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
/** Canonical repository identity for combining sibling worktrees, never merely matching commits. */
export async function operatorWriteCommonDirectory(snapshot: OperatorWriteSnapshot) {
  if (await realpath(snapshot.directory) !== snapshot.directory) error('workspace_changed');
  const identity = await repositoryIdentity(snapshot.directory, snapshot.limits);
  for (const key of ['gitDirectory', 'head', 'tree', 'indexSha256'] as const) {
    if (identity[key] !== snapshot[key]) error('repository_changed');
  }
  const path = (await git(snapshot.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], snapshot.limits)).trim();
  return realpath(path);
}

async function parentsOf(directory: string, paths: string[]) {
  const names = new Set(['']);
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== '.') {
      names.add(parent);
      parent = dirname(parent);
    }
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
async function pinnedBytes(target: string, maxBytes: number, identity?: FileIdentity) {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) error('file_invalid');
    if (identity && (stat.dev !== identity.device || stat.ino !== identity.inode
      || stat.mode !== identity.mode || stat.nlink !== identity.links)) error('source_changed');
    const birthtimeNs = identity?.birthtimeNs ? (await handle.stat({ bigint: true })).birthtimeNs.toString() : undefined;
    if (identity?.birthtimeNs && birthtimeNs !== identity.birthtimeNs) error('source_changed');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) error('file_changed');
    return { stat, content: buffer.subarray(0, offset), birthtimeNs };
  } finally { await handle.close(); }
}
async function fileIdentity(directory: string, path: string, maxBytes: number, identity?: FileIdentity) {
  return withPinnedParent(directory, path, async target => {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const link = await readlink(target);
      return { path, sha256: operatorWriteSha256(link), bytes: Buffer.byteLength(link), mode: stat.mode,
        device: stat.dev, inode: stat.ino, links: stat.nlink, kind: 'symlink' as const };
    }
    const opened = await pinnedBytes(target, maxBytes, identity);
    if (opened.stat.dev !== stat.dev || opened.stat.ino !== stat.ino) error('file_changed');
    return { path, sha256: operatorWriteSha256(opened.content), bytes: opened.content.length, mode: opened.stat.mode,
      device: opened.stat.dev, inode: opened.stat.ino, links: opened.stat.nlink, kind: 'file' as const,
      ...(opened.birthtimeNs ? { birthtimeNs: opened.birthtimeNs } : {}) };
  });
}
async function trackedFiles(directory: string, limits: typeof OPERATOR_WRITE_LIMITS, expected?: Map<string, FileIdentity>) {
  const paths = (await git(directory, ['ls-files', '-z'], limits)).split('\0').filter(Boolean);
  if (paths.length > limits.trackedFiles || new Set(paths).size !== paths.length) error('tracked_files_invalid');
  const files = [];
  let bytes = 0;
  for (const path of paths.sort()) {
    if (expected && !expected.has(path)) error('source_changed');
    const file = await fileIdentity(directory, path, limits.treeBytes, expected?.get(path));
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

interface SnapshotInput { workspace: string; directory: string; files: string[]; createFiles?: string[]; limits?: Partial<typeof OPERATOR_WRITE_LIMITS> }
function approvedScope(input: SnapshotInput, limits: typeof OPERATOR_WRITE_LIMITS) {
  const createFiles = [...(input.createFiles ?? [])].sort();
  const approvedPaths = [...input.files, ...createFiles].sort();
  if (!approvedPaths.length || approvedPaths.length > limits.approvedFiles || new Set(approvedPaths).size !== approvedPaths.length) error('scope_invalid');
  approvedPaths.forEach(checkPath);
  return { createFiles, approvedPaths };
}
async function requireAbsent(directory: string, path: string) {
  await withPinnedParent(directory, path, async target => {
    const entry = await lstat(target).catch(failure => {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw failure;
    });
    if (entry) error('creation_exists');
  });
}
async function requireNotIgnored(directory: string, paths: string[], limits: typeof OPERATOR_WRITE_LIMITS) {
  // check-ignore takes pathnames and rejects Git's global literal flag; ./ removes colon-magic ambiguity.
  if (paths.length && await git(directory, ['--no-literal-pathspecs', 'check-ignore', '--no-index', '--', ...paths.map(path => `./${path}`)], limits, true)) error('creation_ignored');
}
async function validateExistingScope(directory: string, paths: string[], files: FileIdentity[], limits: typeof OPERATOR_WRITE_LIMITS) {
  for (const path of paths) {
    const file = files.find(file => file.path === path);
    if (!file || file.kind !== 'file' || file.links !== 1 || file.bytes > limits.fileBytes) error('scope_file_invalid');
    const bytes = (await withPinnedParent(directory, path, target => pinnedBytes(target, limits.fileBytes, file))).content;
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    textBytes(content, limits.fileBytes);
    if (operatorWriteSha256(bytes) !== file.sha256) error('file_changed');
  }
}

export async function snapshotOperatorWriteWorkspace(input: SnapshotInput): Promise<OperatorWriteSnapshot> {
  const limits = { ...OPERATOR_WRITE_LIMITS, ...input.limits };
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || limit <= 0)) error('limits_invalid');
  const workspace = await realpath(input.workspace);
  const directory = await realpath(input.directory);
  inside(workspace, directory);
  const scope = approvedScope(input, limits);
  const identity = await repositoryIdentity(directory, limits);
  if (await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'], limits)) error('workspace_dirty');
  const files = await trackedFiles(directory, limits);
  const parents = await parentsOf(directory, [...files.map(file => file.path), ...scope.createFiles]);
  await validateExistingScope(directory, input.files, files, limits);
  await requireNotIgnored(directory, scope.createFiles, limits);
  for (const path of scope.createFiles) await requireAbsent(directory, path);
  if (JSON.stringify(identity) !== JSON.stringify(await repositoryIdentity(directory, limits))) error('repository_changed');
  const snapshot = { version: 1 as const, workspace, directory, ...identity, files, parents, approvedPaths: scope.approvedPaths, limits,
    ...(scope.createFiles.length ? { createFiles: scope.createFiles } : {}) };
  return OperatorWriteSnapshot.parse({ ...snapshot, digest: digest(snapshot) });
}

interface ExpectedFiles { digests: Map<string, string>; created: Map<string, FileIdentity> }
function validateCreationReceipt(snapshot: OperatorWriteSnapshot, receipt: OperatorWriteReceipt) {
  const created = receipt.created;
  if (!created || !(snapshot.createFiles ?? []).includes(receipt.path) || created.path !== receipt.path
    || created.kind !== 'file' || created.links !== 1 || created.mode !== 0o100600 || created.inode <= 0 || !created.birthtimeNs
    || created.sha256 !== receipt.afterSha256 || created.bytes > snapshot.limits.fileBytes) error('receipt_invalid');
  return created;
}
function expectedFiles(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[]): ExpectedFiles {
  const expected = new Map(snapshot.files.map(file => [file.path, file.sha256]));
  const created = new Map<string, FileIdentity>();
  for (const path of snapshot.createFiles ?? []) expected.set(path, 'absent');
  if (new Set(receipts.map(receipt => receipt.mutationID)).size !== receipts.length) error('receipt_invalid');
  for (const receipt of receipts) {
    const { digest: receiptDigest, ...body } = OperatorWriteReceipt.parse(receipt);
    if (digest(body) !== receiptDigest || receipt.snapshotDigest !== snapshot.digest
      || !snapshot.approvedPaths.includes(receipt.path) || expected.get(receipt.path) !== receipt.beforeSha256) error('receipt_invalid');
    if (receipt.beforeSha256 === 'absent') created.set(receipt.path, validateCreationReceipt(snapshot, receipt));
    else if (receipt.created) error('receipt_invalid');
    expected.set(receipt.path, receipt.afterSha256);
  }
  return { digests: expected, created };
}
function matchesIdentity(file: FileIdentity, original: FileIdentity | undefined, sha256: string | undefined) {
  return original && file.sha256 === sha256 && file.kind === original.kind && file.mode === original.mode
    && file.device === original.device && file.inode === original.inode && file.links === original.links
    && file.birthtimeNs === original.birthtimeNs;
}
async function inspectCreatedFiles(snapshot: OperatorWriteSnapshot, expected: ExpectedFiles, stages: FileIdentity[] = []) {
  await requireNotIgnored(snapshot.directory, snapshot.createFiles ?? [], snapshot.limits);
  for (const path of snapshot.createFiles ?? []) {
    const identity = expected.created.get(path);
    if (!identity) await requireAbsent(snapshot.directory, path);
    else {
      const actual = await fileIdentity(snapshot.directory, path, snapshot.limits.fileBytes, identity);
      if (!matchesIdentity(actual, identity, expected.digests.get(path))) error('source_changed');
    }
  }
  const untracked = (await git(snapshot.directory, ['ls-files', '--others', '--exclude-standard', '-z'], snapshot.limits)).split('\0').filter(Boolean);
  for (const stage of stages) {
    checkPath(stage.path);
    if (expected.digests.has(stage.path) || stage.kind !== 'file' || !stage.birthtimeNs || stage.links !== 1) error('stage_invalid');
    const actual = await fileIdentity(snapshot.directory, stage.path, snapshot.limits.fileBytes, stage);
    if (!matchesIdentity(actual, stage, stage.sha256)) error('stage_changed');
  }
  if (untracked.some(path => !expected.created.has(path) && !stages.some(stage => stage.path === path))) error('untracked_files');
}
async function inspectWorkspace(snapshot: OperatorWriteSnapshot, expected: ExpectedFiles, stages: FileIdentity[] = []) {
  const { digest: snapshotDigest, ...body } = OperatorWriteSnapshot.parse(snapshot);
  if (digest(body) !== snapshotDigest) error('snapshot_invalid');
  if (await realpath(snapshot.workspace) !== snapshot.workspace || await realpath(snapshot.directory) !== snapshot.directory) error('workspace_changed');
  inside(snapshot.workspace, snapshot.directory);
  const identity = await repositoryIdentity(snapshot.directory, snapshot.limits);
  for (const key of ['gitDirectory', 'head', 'tree', 'indexSha256'] as const) if (identity[key] !== snapshot[key]) error('repository_changed');
  const parents = await parentsOf(snapshot.directory, [...snapshot.files.map(file => file.path), ...(snapshot.createFiles ?? [])]);
  if (JSON.stringify(parents) !== JSON.stringify(snapshot.parents)) error('parent_changed');
  const current = await trackedFiles(snapshot.directory, snapshot.limits, new Map(snapshot.files.map(file => [file.path, file])));
  if (current.length !== snapshot.files.length) error('source_changed');
  for (const file of current) {
    const original = snapshot.files.find(candidate => candidate.path === file.path);
    if (!matchesIdentity(file, original, expected.digests.get(file.path))) error('source_changed');
  }
  await inspectCreatedFiles(snapshot, expected, stages);
}
export async function validateOperatorWriteWorkspace(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[]) {
  await inspectWorkspace(snapshot, expectedFiles(snapshot, receipts));
}

/** Application-only staging must have a durable exact identity; no ignored prefix or arbitrary untracked exception. */
export async function validateOperatorApplicationWorkspace(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], stages: FileIdentity[]) {
  await inspectWorkspace(snapshot, expectedFiles(snapshot, receipts), stages);
}

export async function prepareOperatorFileMutation(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: { id: string; path: string; expectedBeforeSha256: string; content: string }): Promise<OperatorWriteMutation> {
  checkPath(input.path);
  if (!snapshot.approvedPaths.includes(input.path)) error('file_not_approved');
  const expected = expectedFiles(snapshot, receipts);
  if (expected.digests.get(input.path) !== input.expectedBeforeSha256) error('before_digest_mismatch');
  await inspectWorkspace(snapshot, expected);
  const afterSha256 = operatorWriteSha256(textBytes(input.content, snapshot.limits.fileBytes));
  if (afterSha256 === input.expectedBeforeSha256) error('no_change');
  await preflightOperatorFileWriter();
  return OperatorWriteMutation.parse({ id: input.id, path: input.path, content: input.content,
    beforeSha256: input.expectedBeforeSha256, afterSha256, snapshotDigest: snapshot.digest });
}

function mutationReceipt(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation, created?: FileIdentity): OperatorWriteReceipt {
  const receipt = { mutationID: mutation.id, path: mutation.path, beforeSha256: mutation.beforeSha256,
    afterSha256: mutation.afterSha256, snapshotDigest: snapshot.digest, ...(created ? { created } : {}) };
  return { ...receipt, digest: digest(receipt) };
}
async function mutationState(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: OperatorWriteMutation) {
  const mutation = OperatorWriteMutation.parse(input);
  const expected = expectedFiles(snapshot, receipts);
  if (mutation.snapshotDigest !== snapshot.digest || !snapshot.approvedPaths.includes(mutation.path)
    || expected.digests.get(mutation.path) !== mutation.beforeSha256 || mutation.beforeSha256 === mutation.afterSha256
    || operatorWriteSha256(textBytes(mutation.content, snapshot.limits.fileBytes)) !== mutation.afterSha256) error('mutation_invalid');
  if (mutation.beforeSha256 === 'absent') {
    await requireAbsent(snapshot.directory, mutation.path).catch(() => error('mutation_uncertain'));
    await inspectWorkspace(snapshot, expected);
    return { mutation, expected, current: undefined };
  }
  const known = expected.created.get(mutation.path) ?? snapshot.files.find(file => file.path === mutation.path);
  const current = await fileIdentity(snapshot.directory, mutation.path, snapshot.limits.fileBytes, known);
  if (![mutation.beforeSha256, mutation.afterSha256].includes(current.sha256)) error('mutation_uncertain');
  expected.digests.set(mutation.path, current.sha256);
  await inspectWorkspace(snapshot, expected);
  return { mutation, current, expected };
}
/** Disk observation is diagnostic; an unreceipted creation is never inferred from matching bytes. */
export async function inspectOperatorFileMutation(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: OperatorWriteMutation) {
  const { mutation, current } = await mutationState(snapshot, receipts, input);
  if (current?.sha256 === mutation.afterSha256) return { status: 'applied' as const, receipt: mutationReceipt(snapshot, mutation) };
  return { status: 'not-applied' as const };
}
async function performCreation(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation) {
  const response = await runOperatorFileWriter(snapshot, mutation);
  const created = FileIdentity.parse(response);
  validateCreationReceipt(snapshot, mutationReceipt(snapshot, mutation, created));
  const current = await fileIdentity(snapshot.directory, mutation.path, snapshot.limits.fileBytes, created);
  if (JSON.stringify(current) !== JSON.stringify(created)) error('creation_uncertain');
  return created;
}
/** Caller durably records intent first and must never re-enter while a previous writer may still run. */
export async function applyOperatorFileMutation(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[], input: OperatorWriteMutation): Promise<OperatorWriteReceipt> {
  const { mutation, current, expected } = await mutationState(snapshot, receipts, input);
  let created: FileIdentity | undefined;
  if (!current) {
    created = await performCreation(snapshot, mutation);
    expected.created.set(mutation.path, created);
  } else if (current.sha256 !== mutation.afterSha256) await runOperatorFileWriter(snapshot, mutation, current);
  expected.digests.set(mutation.path, mutation.afterSha256);
  await inspectWorkspace(snapshot, expected);
  return mutationReceipt(snapshot, mutation, created);
}

async function createdFileDiffs(snapshot: OperatorWriteSnapshot, expected: ExpectedFiles) {
  const diffs = [];
  for (const path of snapshot.createFiles ?? []) {
    if (!expected.created.has(path)) continue;
    diffs.push(await git(snapshot.directory, ['diff', '--no-index', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', '/dev/null', path], snapshot.limits, false, true));
  }
  return diffs.join('');
}
export async function operatorWriteArtifact(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[]): Promise<OperatorWriteArtifact> {
  const expected = expectedFiles(snapshot, receipts);
  await inspectWorkspace(snapshot, expected);
  const existing = snapshot.approvedPaths.filter(path => !(snapshot.createFiles ?? []).includes(path));
  const trackedDiff = existing.length ? await git(snapshot.directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', ...existing], snapshot.limits) : '';
  const diff = trackedDiff + await createdFileDiffs(snapshot, expected);
  await inspectWorkspace(snapshot, expected);
  const files = snapshot.files.filter(file => snapshot.approvedPaths.includes(file.path)).map(file => ({ path: file.path, beforeSha256: file.sha256, afterSha256: expected.digests.get(file.path)! }));
  for (const path of snapshot.createFiles ?? []) {
    if (expected.created.has(path)) files.push({ path, beforeSha256: 'absent', afterSha256: expected.digests.get(path)! });
  }
  const artifact = { snapshotDigest: snapshot.digest, head: snapshot.head, tree: snapshot.tree, diff, diffSha256: operatorWriteSha256(diff), files };
  return { ...artifact, digest: digest(artifact) };
}

/** Exact bounded bytes for an isolated check copy; no symlinks, Git metadata or unrelated untracked files. */
export async function readOperatorWriteSourceFiles(snapshot: OperatorWriteSnapshot, receipts: OperatorWriteReceipt[]) {
  const expected = expectedFiles(snapshot, receipts);
  await inspectWorkspace(snapshot, expected);
  const identities = [...snapshot.files, ...expected.created.values()];
  const source = [];
  let total = 0;
  for (const identity of identities) {
    if (identity.kind !== 'file') error('source_symlink_unsupported');
    const opened = await withPinnedParent(snapshot.directory, identity.path, target => pinnedBytes(target, snapshot.limits.treeBytes, identity));
    const current = { ...identity, sha256: operatorWriteSha256(opened.content), device: opened.stat.dev, inode: opened.stat.ino,
      mode: opened.stat.mode, links: opened.stat.nlink };
    if (!matchesIdentity(current, identity, expected.digests.get(identity.path))) error('source_changed');
    total += opened.content.length;
    if (total > snapshot.limits.treeBytes) error('tree_too_large');
    source.push({ path: identity.path, content: opened.content, mode: opened.stat.mode });
  }
  await inspectWorkspace(snapshot, expected);
  return source;
}
