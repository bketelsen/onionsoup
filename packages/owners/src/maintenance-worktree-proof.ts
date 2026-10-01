import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkItem } from './ledger.ts';
import { PLAN_WORKTREE_LIMITS } from './plan-worktrees.ts';

const execute = promisify(execFile);
export const WORKTREE_PROOF_LIMITS = { files: 100_000, bytes: 128 * 1024 * 1024, commandMs: 10_000 };
export interface MaintenanceSessionActivity {
  sessionID: string;
  directory: string;
  updatedAt: number;
  sessionDigest: string;
}
export interface WorktreePreservationProof {
  classification: 'time-gated' | 'single-use-protected' | 'blocked';
  reason: string;
  proofDigest?: string;
  validUntil?: string;
}
interface Budget { files: number; bytes: number }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function git(path: string, args: string[]) {
  const output = await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', path, ...args], {
    encoding: 'utf8', timeout: WORKTREE_PROOF_LIMITS.commandMs, maxBuffer: WORKTREE_PROOF_LIMITS.bytes,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return output.stdout;
}

function identity(stat: Awaited<ReturnType<typeof lstat>>) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
}

async function readRegularFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function fileEvidence(path: string, budget: Budget) {
  const before = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!before) return 'absent';
  if (++budget.files > WORKTREE_PROOF_LIMITS.files || (budget.bytes += before.size) > WORKTREE_PROOF_LIMITS.bytes) {
    throw new Error('worktree_proof_limit');
  }
  if (!before.isFile() && !before.isSymbolicLink()) throw new Error('worktree_proof_unsupported_file');
  const contents = before.isSymbolicLink() ? await readlink(path) : await readRegularFile(path);
  const after = await lstat(path);
  if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after))) throw new Error('worktree_proof_changed');
  return { identity: identity(before), digest: digest(contents) };
}

async function workingFiles(path: string, budget: Budget) {
  const listed = await git(path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const names = [...new Set(listed.split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const name of names) {
    const target = resolve(path, name);
    if (isAbsolute(name) || relative(path, target).split(sep).includes('..')) throw new Error('worktree_proof_path_invalid');
    // Do not follow a symlinked ancestor, including an absent tracked file's parent.
    let parent = dirname(target);
    while (parent !== path) {
      const stat = await lstat(parent).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (stat && !stat.isDirectory()) throw new Error('worktree_proof_path_invalid');
      parent = dirname(parent);
    }
    entries.push({ name, evidence: await fileEvidence(target, budget) });
  }
  return entries;
}

async function snapshot(path: string, landedCommit: string | undefined) {
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('worktree_proof_path_invalid');
  if ((await git(path, ['rev-parse', '--show-toplevel'])).trim() !== path) throw new Error('worktree_proof_path_invalid');
  const gitDir = (await git(path, ['rev-parse', '--absolute-git-dir'])).trim();
  const commonDir = resolve(path, (await git(path, ['rev-parse', '--git-common-dir'])).trim());
  if (await realpath(gitDir) !== gitDir || await realpath(commonDir) !== commonDir) throw new Error('worktree_proof_git_identity_invalid');
  const budget = { files: 0, bytes: 0 };
  const metadata = [];
  const directoryIdentities = [identity(await lstat(gitDir)), identity(await lstat(commonDir))];
  for (const target of [...new Set([join(path, '.git'), join(gitDir, 'HEAD'), join(gitDir, 'index'),
    join(gitDir, 'config.worktree'), join(commonDir, 'config'), join(commonDir, 'packed-refs')])]) {
    if ((await lstat(target).catch(() => undefined))?.isDirectory()) continue;
    metadata.push({ path: target, evidence: await fileEvidence(target, budget) });
  }
  const configurationDigest = digest(await git(path, ['config', '--null', '--list', '--show-origin']));
  const head = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
  const refs = await git(path, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']);
  const status = await git(path, ['status', '--porcelain', '-z']);
  const unpublished = await git(path, ['rev-list', 'HEAD', '--not', '--remotes', ...(landedCommit ? [landedCommit] : [])]);
  const files = await workingFiles(path, budget);
  return { path, pathIdentity: identity(await lstat(path)), gitDir, commonDir, directoryIdentities, configurationDigest, head, refs, status, unpublished, metadata, files };
}

function retentionDeadline(item: WorkItem, activity: MaintenanceSessionActivity | undefined, now: number) {
  if (item.session && (!activity || activity.sessionID !== item.session.sessionID
    || activity.directory !== item.session.directory || activity.directory !== item.planWorktree
    || !/^[a-f0-9]{64}$/.test(activity.sessionDigest))) return undefined;
  const lastActive = item.session ? activity!.updatedAt : Date.parse(item.updatedAt);
  if (!Number.isFinite(lastActive) || lastActive > now) return undefined;
  const deadline = lastActive + PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours * 3_600_000;
  return deadline > now ? new Date(deadline).toISOString() : undefined;
}

/** Read-only proof of the ordinary cleanup guard, never permission to remove a worktree.
 * The caller binds the complete item and authenticated session evidence into its release
 * snapshot and reruns this inspection at every approval/commit freshness boundary. */
export async function inspectWorktreePreservation(
  item: WorkItem, activity: MaintenanceSessionActivity | undefined, now: number,
): Promise<WorktreePreservationProof> {
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES'].some(name => process.env[name])) {
    return { classification: 'blocked', reason: 'worktree_proof_git_environment_unsupported' };
  }
  if ((item.landedCommit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.landedCommit))
    || !Number.isFinite(now) || !item.planWorktree || !isAbsolute(item.planWorktree)
    || !(item.status === 'cancelled' || (item.status === 'landed'
      && (item.publication?.state === 'merged' || item.publication?.state === 'closed')))) {
    return { classification: 'blocked', reason: 'worktree_proof_item_invalid' };
  }
  try {
    const first = await snapshot(item.planWorktree, item.landedCommit);
    const second = await snapshot(item.planWorktree, item.landedCommit);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('worktree_proof_changed');
    const proofDigest = digest(JSON.stringify({ item, activity, snapshot: second }));
    const validUntil = retentionDeadline(item, activity, now);
    if (validUntil) return { classification: 'time-gated', reason: 'worktree_retention_preserved', proofDigest, validUntil };
    if (second.status) return { classification: 'single-use-protected', reason: 'worktree_kept_uncommitted', proofDigest };
    if (second.unpublished.trim()) return { classification: 'single-use-protected', reason: 'worktree_kept_unpublished', proofDigest };
    return { classification: 'blocked', reason: 'worktree_cleanup_unprotected', proofDigest };
  } catch (error) {
    const reason = error instanceof Error && /^worktree_proof_[a-z_]+$/.test(error.message)
      ? error.message : 'worktree_proof_read_failed';
    return { classification: 'blocked', reason };
  }
}
