import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OwnerDeclaration } from './declarations.ts';
import type { Verification } from './ledger.ts';
import { runSandboxed } from './sandbox.ts';

const run = promisify(execFile);

export const WORKSPACE_LIMITS = { diffChars: 60_000 };

export async function git(directory: string, args: string[]) {
  const { stdout } = await run('git', ['-C', directory, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Bring the owner's checkout to the tip of its base branch. The owner's checkout is never edited. */
export async function refreshCheckout(owner: OwnerDeclaration) {
  if (!existsSync(join(owner.checkout, '.git'))) {
    await run('git', ['clone', '-q', owner.domain.remote, owner.checkout]);
  }
  await git(owner.checkout, ['fetch', '-q', 'origin']);
  await git(owner.checkout, ['checkout', '-q', owner.baseBranch]);
  await git(owner.checkout, ['reset', '-q', '--hard', `origin/${owner.baseBranch}`]);
  await git(owner.checkout, ['clean', '-q', '-fdx']);
  return (await git(owner.checkout, ['rev-parse', 'HEAD'])).trim();
}

/** A fresh worktree per work item, on its own branch, next to (not inside) the checkout. */
export async function createWorktree(owner: OwnerDeclaration, worktreesRoot: string, itemId: string) {
  const path = join(worktreesRoot, owner.id, itemId);
  const branch = `owners/${itemId}`;
  if (!existsSync(path)) {
    await git(owner.checkout, ['worktree', 'add', '-q', '-b', branch, path, `origin/${owner.baseBranch}`]);
  }
  return { path, branch };
}

/** A replanned item starts from the base again, not from the rejected attempt. */
export async function resetWorktree(owner: OwnerDeclaration, worktree: string) {
  await git(worktree, ['reset', '-q', '--hard', `origin/${owner.baseBranch}`]);
  await git(worktree, ['clean', '-q', '-fd']);
}

export async function diffAgainstBase(owner: OwnerDeclaration, worktree: string) {
  await git(worktree, ['add', '-A', '--intent-to-add']);
  const stat = await git(worktree, ['diff', '--stat', `origin/${owner.baseBranch}`]);
  const patch = await git(worktree, ['diff', `origin/${owner.baseBranch}`]);
  return { stat: stat.trim(), patch: patch.slice(0, WORKSPACE_LIMITS.diffChars) };
}

/** Host-run verification, sandboxed and memory-capped: a freelancer's claim that tests pass is never evidence. */
export async function verify(owner: OwnerDeclaration, worktree: string): Promise<Verification[]> {
  const results: Verification[] = [];
  for (const [command, ...args] of owner.verify) {
    const outcome = await runSandboxed(command!, args, { cwd: worktree, writable: [worktree] });
    results.push({ command: [command, ...args].join(' '), ...outcome });
  }
  return results;
}

export function verificationPassed(results: readonly Verification[]) {
  return results.every(result => result.exitCode === 0);
}

export async function commitWorktree(worktree: string, message: string) {
  await git(worktree, ['add', '-A']);
  await git(worktree, ['commit', '-q', '-m', message]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}
