import { constants } from 'node:fs';
import { mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface OperatorCheckSourceFile { path: string; content: Buffer; mode: number }
export const OPERATOR_CHECK_SOURCE_LIMITS = { sourceFiles: 4_104, sourceBytes: 128 * 1024 * 1024, pathChars: 2_048 };
function invalid(): never { throw new Error('operator_check_source_invalid'); }
export function operatorCheckSourceIsSymlink(file: OperatorCheckSourceFile) { return file.mode === 0o120000; }
function safePath(path: string, max: number) {
  return typeof path === 'string' && path.length > 0 && path.length <= max && !path.startsWith('/')
    && !/[\\\0]/.test(path) && path.split('/').every(part => part && !['.', '..', '.git'].includes(part));
}
function safeMode(mode: number) {
  return mode === 0o120000 || (Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o100777
    && (mode & ~(constants.S_IFREG | 0o777)) === 0);
}
function linkTarget(file: OperatorCheckSourceFile) {
  const target = file.content.toString('utf8');
  if (!target || target.startsWith('/') || /[\\\0]/.test(target)
    || !Buffer.from(target).equals(file.content)) invalid();
  return target;
}
function sourceTree(files: OperatorCheckSourceFile[], limits: typeof OPERATOR_CHECK_SOURCE_LIMITS) {
  const entries = new Map<string, OperatorCheckSourceFile>();
  const directories = new Set(['']);
  let bytes = 0;
  for (const file of files) {
    if (!safePath(file.path, limits.pathChars) || entries.has(file.path)
      || !Buffer.isBuffer(file.content) || !safeMode(file.mode)) invalid();
    entries.set(file.path, file);
    bytes += file.content.length;
    const components = file.path.split('/');
    for (let count = 1; count < components.length; count++) directories.add(components.slice(0, count).join('/'));
  }
  if (bytes > limits.sourceBytes) throw new Error('operator_check_source_limit');
  for (const directory of directories) if (entries.has(directory)) invalid();
  return { entries, directories };
}
/** Resolve each component before '..', matching filesystem semantics even through directory aliases. */
function resolveTarget(target: string, base: string[], tree: ReturnType<typeof sourceTree>, visiting = new Set<string>()): string {
  let resolved = [...base];
  const components = target.split('/');
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!resolved.length) invalid();
      resolved.pop();
      continue;
    }
    if (component === '.git') invalid();
    const path = [...resolved, component].join('/');
    const entry = tree.entries.get(path);
    if (!entry && !tree.directories.has(path)) invalid();
    if (entry && operatorCheckSourceIsSymlink(entry)) {
      if (visiting.has(path)) invalid();
      const expanded = resolveTarget(linkTarget(entry), resolved, tree, new Set([...visiting, path]));
      resolved = expanded ? expanded.split('/') : [];
    } else resolved.push(component);
    if (index < components.length - 1 && !tree.directories.has(resolved.join('/'))) invalid();
  }
  return resolved.join('/');
}
function validateLinks(tree: ReturnType<typeof sourceTree>) {
  const edges = new Map<string, string[]>([...tree.directories].map(path => [path, []]));
  for (const directory of tree.directories) {
    if (directory) edges.get(dirname(directory) === '.' ? '' : dirname(directory))!.push(directory);
  }
  for (const file of tree.entries.values()) {
    if (!operatorCheckSourceIsSymlink(file)) continue;
    const parent = dirname(file.path) === '.' ? '' : dirname(file.path);
    const target = resolveTarget(linkTarget(file), parent ? parent.split('/') : [], tree, new Set([file.path]));
    if (tree.directories.has(target)) edges.get(parent)!.push(target);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (directory: string) => {
    if (active.has(directory)) invalid();
    if (visited.has(directory)) return;
    active.add(directory);
    for (const target of edges.get(directory)!) visit(target);
    active.delete(directory);
    visited.add(directory);
  };
  visit('');
}
/** A closed tracked tree: no dereferencing host paths, hidden metadata or symlink ancestors. */
export function validateOperatorCheckSourceFiles(files: OperatorCheckSourceFile[], overrides: Partial<typeof OPERATOR_CHECK_SOURCE_LIMITS> = {}) {
  const limits = { ...OPERATOR_CHECK_SOURCE_LIMITS, ...overrides };
  if (!files.length || files.length > limits.sourceFiles) throw new Error('operator_check_source_limit');
  const tree = sourceTree(files, limits);
  validateLinks(tree);
  return new Set(tree.entries.keys());
}
/** The destination must be a fresh private directory, never a live repository or shared writable tree. */
export async function copyOperatorCheckSourceFiles(directory: string, files: OperatorCheckSourceFile[]) {
  validateOperatorCheckSourceFiles(files);
  if (await realpath(directory) !== resolve(directory) || (await readdir(directory)).length) invalid();
  for (const file of files) await mkdir(dirname(join(directory, file.path)), { recursive: true, mode: 0o700 });
  for (const file of files.filter(file => !operatorCheckSourceIsSymlink(file))) {
    await writeFile(join(directory, file.path), file.content,
      { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: file.mode & 0o777 });
  }
  for (const file of files.filter(operatorCheckSourceIsSymlink)) await symlink(linkTarget(file), join(directory, file.path));
}
