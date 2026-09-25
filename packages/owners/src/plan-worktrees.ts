import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RepositoryOwner } from './declarations.ts';
import { recordSync, syncDesk } from './desk-sync.ts';
import { PlanWorktreeKept, type WorkItem, type WorkStatus } from './ledger.ts';
import type { OwnerSessionClient } from './owner-sessions.ts';
import type { Runtime } from './runtime.ts';
import { ensureClone, git } from './workspace.ts';

/**
 * Each approved plan works in its own git worktree, made by host code from the repository's checkout at the current
 * `origin/<base>`, at `<plansRoot>/<owner>/<item>` on branch `plan/<item>`. Two plans in one repository once shared
 * the owner's desk: proposing either would have bundled the other's unreviewed changes, so both stopped. With a
 * worktree each, they proceed and propose independently; the desk stays for chat and small direct changes. The
 * worktree outlives its PR, since the plan's session may still be working there (a rollout after the merge): a
 * cleanup pass removes it once the item is finished and its session has been idle for a while, unless that would
 * lose work.
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

export type PlanWorktreeRemoval = 'removed' | 'absent' | PlanWorktreeKept;

/** Why a plan's worktree must stay: removing it would lose changes no commit holds, or commits no remote holds. */
async function keepReason(path: string, landedCommit: string | undefined): Promise<PlanWorktreeKept | undefined> {
  if ((await git(path, ['status', '--porcelain'])).trim()) return 'kept-uncommitted';
  const published = landedCommit ? ['--remotes', landedCommit] : ['--remotes'];
  const unpublished = (await git(path, ['rev-list', 'HEAD', '--not', ...published])).trim();
  return unpublished ? 'kept-unpublished' : undefined;
}

/** Forget the worktree on the item. Its session keeps its real directory: that is where opencode knows it. */
async function forgetPlanWorktree(runtime: Runtime, item: WorkItem) {
  await runtime.ledger.update(item.id, current => ({ ...current, planWorktree: undefined, planWorktreeKept: undefined }));
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

/** A worktree that stays records why, so later passes journal only a change of reason. */
async function recordKept(runtime: Runtime, item: WorkItem, outcome: PlanWorktreeRemoval) {
  const kept = PlanWorktreeKept.safeParse(outcome);
  if (kept.success) await runtime.ledger.update(item.id, current => ({ ...current, planWorktreeKept: kept.data }));
}

/** Remove a finished plan's worktree and its branch; never one that holds uncommitted or unpublished work. */
async function removePlanWorktree(runtime: Runtime, item: WorkItem, path: string): Promise<PlanWorktreeRemoval> {
  const { outcome, detail } = await detachPlanWorktree(runtime, item, path)
    .then(removal => ({ outcome: removal, detail: '' }))
    .catch((error: unknown) => ({
      outcome: 'failed' as const, detail: `plan_worktree_remove_failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  const isRepeat = outcome === item.planWorktreeKept;
  const entry = isRepeat ? undefined : REMOVAL_JOURNAL[outcome]?.(path, detail);
  if (entry) await runtime.notebook(item.owner).journal({ ...entry, workItem: item.id, outcome });
  await recordKept(runtime, item, outcome);
  return outcome;
}

/** How long a finished plan's session must have been idle before the cleanup pass removes its worktree. */
export const PLAN_WORKTREE_LIMITS = { idleBeforeRemovalHours: 24 };

const HOUR_MS = 3_600_000;

/**
 * The states in which a plan is done with its worktree: landed with its PR merged or closed (a landed item cannot be
 * cancelled, so a closed PR would otherwise keep it forever), or cancelled. A failed item can still be resumed.
 */
const IS_FINISHED: Partial<Record<WorkStatus, (item: WorkItem) => boolean>> = {
  landed: item => item.publication?.state === 'merged' || item.publication?.state === 'closed',
  cancelled: () => true,
};

function isFinishedPlan(item: WorkItem) {
  return Boolean(item.planWorktree) && (IS_FINISHED[item.status]?.(item) ?? false);
}

type ActivityReader = Pick<OwnerSessionClient, 'activity'>;

/**
 * Whether the plan's session has been idle for the limit: not busy (or retrying), and last updated before it. An
 * item without a session, or whose session is gone, counts from the item's own last update.
 */
async function hasIdleSession(item: WorkItem, sessions: ActivityReader, now: Date) {
  const activity = item.session ? await sessions.activity(item.session) : { isBusy: false, updatedAt: undefined };
  const lastActive = activity.updatedAt ?? Date.parse(item.updatedAt);
  const isQuiet = now.getTime() - lastActive >= PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours * HOUR_MS;
  return !activity.isBusy && isQuiet;
}

async function removeIfIdle(runtime: Runtime, item: WorkItem, sessions: ActivityReader, now: Date) {
  if (await hasIdleSession(item, sessions, now)) await removePlanWorktree(runtime, item, item.planWorktree!);
}

/**
 * The cleanup pass. Merging or cancelling a plan never removes its worktree at once: the session may still be working
 * there. Each finished plan's worktree goes once its session has been idle for `PLAN_WORKTREE_LIMITS`. The plugin
 * runs this, since it holds the opencode client; a failure leaves that item for the next pass.
 */
export async function removeIdlePlanWorktrees(
  runtime: Runtime, sessions: ActivityReader, onError: (itemId: string, error: unknown) => void, now = new Date(),
) {
  const finished = (await runtime.ledger.list()).filter(isFinishedPlan);
  for (const item of finished) await removeIfIdle(runtime, item, sessions, now).catch((error: unknown) => onError(item.id, error));
}
