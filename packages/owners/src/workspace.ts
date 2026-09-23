import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/** Bring the owner's checkout to the tip of its base branch. The owner's checkout is never edited. */
export async function refreshCheckout(owner: RepositoryOwner) {
  if (!existsSync(join(owner.workspace, '.git'))) {
    await run('git', ['clone', '-q', owner.domain.remote, owner.workspace]);
  }
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  await git(owner.workspace, ['checkout', '-q', owner.domain.baseBranch]);
  await git(owner.workspace, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  await git(owner.workspace, ['clean', '-q', '-fdx']);
  return (await git(owner.workspace, ['rev-parse', 'HEAD'])).trim();
}

/** A fresh worktree per work item, on its own branch, next to (not inside) the checkout. */
export async function createWorktree(owner: RepositoryOwner, worktreesRoot: string, itemId: string) {
  const path = join(worktreesRoot, owner.id, itemId);
  const branch = `owners/${itemId}`;
  if (!existsSync(path)) {
    await git(owner.workspace, ['worktree', 'add', '-q', '-b', branch, path, `origin/${owner.domain.baseBranch}`]);
  }
  return { path, branch };
}

/** A replanned item starts from the base again, not from the rejected attempt. */
export async function resetWorktree(owner: RepositoryOwner, worktree: string) {
  await git(worktree, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  await git(worktree, ['clean', '-q', '-fd']);
}

export async function diffAgainstBase(owner: RepositoryOwner, worktree: string) {
  await git(worktree, ['add', '-A', '--intent-to-add']);
  const stat = await git(worktree, ['diff', '--stat', `origin/${owner.domain.baseBranch}`]);
  const patch = await git(worktree, ['diff', `origin/${owner.domain.baseBranch}`]);
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

/** An owner's desk: its own worktree on a desk branch, where chats with a person do their work. */
export async function ensureDesk(owner: RepositoryOwner, desksRoot: string) {
  const path = join(desksRoot, owner.id);
  const branch = `desk/${owner.id}`;
  if (!existsSync(path)) {
    await git(owner.workspace, ['fetch', '-q', 'origin']);
    await git(owner.workspace, ['worktree', 'add', '-q', '-B', branch, path, `origin/${owner.domain.baseBranch}`]);
  }
  return { path, branch };
}

export function verificationPassed(results: readonly Verification[]) {
  return results.every(result => result.exitCode === 0);
}

export async function commitWorktree(worktree: string, message: string) {
  await git(worktree, ['add', '-A']);
  await git(worktree, ['commit', '-q', '-m', message]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}
