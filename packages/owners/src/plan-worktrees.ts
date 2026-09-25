import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RepositoryOwner } from './declarations.ts';
import { recordSync, syncDesk } from './desk-sync.ts';
import type { WorkItem } from './ledger.ts';
import type { Runtime } from './runtime.ts';
import { ensureClone, ensureDesk, git } from './workspace.ts';

/**
 * Each approved plan works in its own git worktree, made by host code from the repository's checkout at the current
 * `origin/<base>`, at `<plansRoot>/<owner>/<item>` on branch `plan/<item>`. Two plans in one repository once shared
 * the owner's desk: proposing either would have bundled the other's unreviewed changes, so both stopped. With a
 * worktree each, they proceed and propose independently; the desk stays for chat and small direct changes. The
 * worktree is removed once its PR merges or the item is cancelled, unless that would lose work.
 */
export function planBranch(itemId: string) {
  return `plan/${itemId}`;
}

function planWorktreePath(runtime: Runtime, item: WorkItem) {
  return join(runtime.plansRoot, item.owner, item.id);
}

async function addPlanWorktree(owner: RepositoryOwner, path: string, itemId: string) {
  await ensureClone(owner);
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  // A worktree deleted by hand leaves its registration behind, which would refuse the path.
  await git(owner.workspace, ['worktree', 'prune']);
  await git(owner.workspace, ['worktree', 'add', '-q', '-B', planBranch(itemId), path, `origin/${owner.domain.baseBranch}`]);
}

/** The plan's worktree, made now if it does not exist yet, and recorded on the item. */
export async function ensurePlanWorktree(runtime: Runtime, item: WorkItem) {
  const path = planWorktreePath(runtime, item);
  const isNew = !existsSync(path);
  if (isNew) await addPlanWorktree(runtime.repositoryFor(item), path, item.id);
  if (item.planWorktree !== path) await runtime.ledger.update(item.id, current => ({ ...current, planWorktree: path }));
  return { path, isNew };
}

/** Bring a plan's worktree up to date with its base, keeping its uncommitted work, as a desk sync does. */
export async function syncPlanWorktree(runtime: Runtime, ownerId: string, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.owner !== ownerId) throw new Error(`item_not_yours: ${item.id} belongs to ${item.owner}`);
  if (!item.planWorktree) throw new Error(`no_plan_worktree: ${item.id} has no worktree of its own; its work is on your desk`);
  const owner = runtime.repositoryFor(item);
  const sync = await syncDesk(item.planWorktree, owner.domain.baseBranch);
  const report = { ...sync, desk: item.planWorktree, repository: owner.domain.name, place: `worktree for plan ${item.id}` };
  return recordSync(runtime, ownerId, report, item.id);
}

export type PlanWorktreeRemoval = 'removed' | 'absent' | 'kept-uncommitted' | 'kept-unpublished' | 'failed';

/** Why a plan's worktree must stay: removing it would lose changes no commit holds, or commits no remote holds. */
async function keepReason(path: string, landedCommit: string | undefined): Promise<PlanWorktreeRemoval | undefined> {
  if ((await git(path, ['status', '--porcelain'])).trim()) return 'kept-uncommitted';
  const published = landedCommit ? ['--remotes', landedCommit] : ['--remotes'];
  const unpublished = (await git(path, ['rev-list', 'HEAD', '--not', ...published])).trim();
  return unpublished ? 'kept-unpublished' : undefined;
}

/**
 * Forget the worktree on the item. Its session moves to the repository's desk (the same repository, so opencode
 * still finds it), so later notices about the work reach a directory that exists.
 */
async function forgetPlanWorktree(runtime: Runtime, item: WorkItem) {
  const desk = await ensureDesk(runtime.repositoryFor(item), runtime.desksRoot);
  await runtime.ledger.update(item.id, current => ({
    ...current, planWorktree: undefined, session: current.session && { ...current.session, directory: desk.path },
  }));
}

async function detachPlanWorktree(runtime: Runtime, item: WorkItem, path: string): Promise<PlanWorktreeRemoval> {
  if (!existsSync(path)) {
    await forgetPlanWorktree(runtime, item);
    return 'absent';
  }
  const kept = await keepReason(path, item.landedCommit);
  if (kept) return kept;
  const { workspace } = runtime.repositoryFor(item);
  await git(workspace, ['worktree', 'remove', path]);
  if ((await git(workspace, ['branch', '--list', planBranch(item.id)])).trim()) await git(workspace, ['branch', '-D', planBranch(item.id)]);
  await forgetPlanWorktree(runtime, item);
  return 'removed';
}

type RemovalJournal = (path: string, detail: string) => { kind: string; note: string };

const keptNote = (why: string) => (path: string) => ({
  kind: 'attention',
  note: `plan worktree ${path} was kept: ${why}. Look at it with \`git -C ${path} status\`; remove it with \`git worktree remove\` once nothing in it is needed.`,
});

/** What the owner's journal says about each outcome; the kept ones and failures raise the person's attention. */
const REMOVAL_JOURNAL: Record<PlanWorktreeRemoval, RemovalJournal | undefined> = {
  removed: path => ({ kind: 'plan-worktree-removed', note: path }),
  absent: undefined,
  'kept-uncommitted': keptNote('it has uncommitted changes'),
  'kept-unpublished': keptNote('it has commits no remote branch holds'),
  failed: (path, detail) => ({ kind: 'attention', note: `plan worktree ${path} could not be removed: ${detail}` }),
};

/** Remove a finished plan's worktree and its branch (merged or cancelled); never one that holds unpublished work. */
export async function removePlanWorktree(runtime: Runtime, item: WorkItem): Promise<PlanWorktreeRemoval> {
  const path = item.planWorktree;
  if (!path) return 'absent';
  const { outcome, detail } = await detachPlanWorktree(runtime, item, path)
    .then(removal => ({ outcome: removal, detail: '' }))
    .catch((error: unknown) => ({
      outcome: 'failed' as const, detail: `plan_worktree_remove_failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  const entry = REMOVAL_JOURNAL[outcome]?.(path, detail);
  if (entry) await runtime.notebook(item.owner).journal({ ...entry, workItem: item.id, outcome });
  return outcome;
}
