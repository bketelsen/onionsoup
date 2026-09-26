import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryOwner } from './declarations.ts';
import type { Verification } from './ledger.ts';
import { runSandboxed } from './sandbox.ts';

const run = promisify(execFile);

export const WORKSPACE_LIMITS = { diffChars: 60_000 };

export async function git(directory: string, args: string[]) {
  const { stdout } = await run('git', ['-C', directory, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** As `git`, but with pathspec magic and globbing turned off: every path argument matches only itself, literally. */
export async function gitWithLiteralPathspecs(directory: string, args: string[]) {
  const { stdout } = await run('git', ['--literal-pathspecs', '-C', directory, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Clone a remote into a directory unless it already holds a clone; with a branch, that branch is checked out. */
export async function cloneIfMissing(remote: string, directory: string, branch?: string) {
  if (existsSync(join(directory, '.git'))) return;
  await run('git', ['clone', '-q', ...(branch ? ['--branch', branch] : []), remote, directory]);
}

/** Bring the owner's checkout to the tip of its base branch. The owner's checkout is never edited. */
export async function refreshCheckout(owner: RepositoryOwner) {
  await cloneIfMissing(owner.domain.remote, owner.workspace);
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  await git(owner.workspace, ['checkout', '-q', owner.domain.baseBranch]);
  await git(owner.workspace, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  await git(owner.workspace, ['clean', '-q', '-fdx']);
  return (await git(owner.workspace, ['rev-parse', 'HEAD'])).trim();
}

/** A fresh worktree per work item, on its own branch, next to (not inside) the checkout. */
export async function createWorktree(owner: RepositoryOwner, worktreesRoot: string, itemId: string, start?: string) {
  const path = join(worktreesRoot, owner.id, itemId);
  const branch = `owners/${itemId}`;
  if (!existsSync(path)) {
    await git(owner.workspace, ['worktree', 'add', '-q', '-b', branch, path, start ?? `origin/${owner.domain.baseBranch}`]);
  }
  return { path, branch };
}

/** A replanned item starts from the base again, not from the rejected attempt. */
export async function resetWorktree(owner: RepositoryOwner, worktree: string, start?: string) {
  await git(worktree, ['reset', '-q', '--hard', start ?? `origin/${owner.domain.baseBranch}`]);
  await git(worktree, ['clean', '-q', '-fd']);
}

export async function diffAgainstBase(owner: RepositoryOwner, worktree: string, start?: string) {
  await git(worktree, ['add', '-A', '--intent-to-add']);
  const stat = await git(worktree, ['diff', '--stat', start ?? `origin/${owner.domain.baseBranch}`]);
  const patch = await git(worktree, ['diff', start ?? `origin/${owner.domain.baseBranch}`]);
  return { stat: stat.trim(), patch: patch.slice(0, WORKSPACE_LIMITS.diffChars) };
}

/** Host-run verification, sandboxed and memory-capped: a freelancer's claim that tests pass is never evidence. */
export async function verify(owner: RepositoryOwner, worktree: string, toolsDirectory: string): Promise<Verification[]> {
  const results: Verification[] = [];
  for (const words of owner.domain.verify) {
    const [command, ...args] = words.map(word => word.replaceAll('{tools}', toolsDirectory));
    const outcome = await runSandboxed(command!, args, { cwd: worktree, writable: [worktree] });
    results.push({ command: words.join(' '), ...outcome });
  }
  return results;
}

/**
 * Verification judges only what the change can contain. Files git ignores (dependencies a hire installed, build
 * output) never reach a commit, so they are removed first: a repository check that walks the filesystem would
 * otherwise fail on, say, a README inside node_modules. Untracked files that are not ignored stay: they are part
 * of an uncommitted change.
 */
export async function removeIgnoredFiles(worktree: string) {
  await git(worktree, ['clean', '-q', '-f', '-d', '-X']);
}

/** After a commit, make the worktree exactly that commit, so verification sees what will be pushed. */
export async function matchHead(worktree: string) {
  await git(worktree, ['reset', '-q', '--hard', 'HEAD']);
  await git(worktree, ['clean', '-q', '-f', '-d', '-x']);
}

/** A new owner has no checkout yet: clone it, so worktrees can be made from it. */
export async function ensureClone(owner: RepositoryOwner) {
  await cloneIfMissing(owner.domain.remote, owner.workspace);
}

/**
 * An owner's desk: its own worktree on a desk branch, where chats with a person do their work. With `start`, the desk
 * branch is moved to that commit (a PR's head, to repair it); only a desk without uncommitted changes moves.
 */
export async function ensureDesk(owner: RepositoryOwner, desksRoot: string, start?: string) {
  const path = owner.desk ?? join(desksRoot, owner.id);
  const branch = `desk/${owner.id}`;
  await ensureClone(owner);
  if (!existsSync(path)) {
    await git(owner.workspace, ['fetch', '-q', 'origin']);
    await git(owner.workspace, ['worktree', 'add', '-q', '-B', branch, path, `origin/${owner.domain.baseBranch}`]);
  }
  if (start) await moveDesk(path, branch, start);
  return { path, branch };
}

async function moveDesk(path: string, branch: string, start: string) {
  if ((await git(path, ['status', '--porcelain'])).trim()) throw new Error('desk_not_clean: propose or discard the changes on your desk first');
  await git(path, ['fetch', '-q', 'origin']);
  await git(path, ['checkout', '-q', '-B', branch, start]);
}

export function verificationPassed(results: readonly Verification[]) {
  return results.every(result => result.exitCode === 0);
}

export async function commitWorktree(worktree: string, message: string) {
  await git(worktree, ['add', '-A']);
  await git(worktree, ['commit', '-q', '-m', message]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}

/**
 * A working tree as a tree object, built in a throwaway index so the tree's own staging is untouched. Kept with a
 * review round or an implementation, so a later review can see what changed since.
 */
export async function snapshotTree(directory: string) {
  const index = join(tmpdir(), `onionsoup-snapshot-index-${randomUUID()}`);
  const options = { cwd: directory, env: { ...process.env, GIT_INDEX_FILE: index }, maxBuffer: 32 * 1024 * 1024 };
  try {
    await run('git', ['read-tree', 'HEAD'], options);
    await run('git', ['add', '-A'], options);
    return (await run('git', ['write-tree'], options)).stdout.trim();
  } finally {
    await rm(index, { force: true });
  }
}

/** What changed between two snapshots; undefined when the earlier tree is gone. */
export async function changesSince(directory: string, reviewedTree: string, currentTree: string) {
  return git(directory, ['diff', reviewedTree, currentTree]).catch(() => undefined);
}
