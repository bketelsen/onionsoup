import type { MaintenanceContext } from './maintenance-context.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RepositoryOwner } from './declarations.ts';
import { recordSync, syncDesk } from './desk-sync.ts';
import { PlanWorktreeKept, type WorkItem, type WorkStatus } from './ledger.ts';
import type { OwnerSessionClient } from './owner-sessions.ts';
import { rememberSession, rememberedSession, itemSessionHistory, sessionHistory } from './session-history.ts';
import type { Runtime } from './runtime.ts';
import { ensureClone, git } from './workspace.ts';
import { isCommitContainedInBase } from './git-containment.ts';
import type { PlanWorktreeArchive } from './plan-worktree-archive.ts';

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

async function addPlanWorktree(owner: RepositoryOwner, path: string, itemId: string, context?: MaintenanceContext) {
  context?.check();
  await ensureClone(owner);
  context?.check();
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  // A worktree deleted by hand leaves its registration behind, which would refuse the path.
  context?.check();
  await git(owner.workspace, ['worktree', 'prune']);
  context?.check();
  await git(owner.workspace, ['worktree', 'add', '-q', '-B', planBranch(itemId), path, `origin/${owner.domain.baseBranch}`]);
}

/** The plan's worktree, made now if it does not exist yet, and recorded on the item. */
export async function ensurePlanWorktree(runtime: Runtime, item: WorkItem, context?: MaintenanceContext) {
  context?.check();
  const path = planWorktreePath(runtime, item);
  const isNew = !existsSync(path);
  // Persist identity before the filesystem effect: a crash after creation cannot reuse a resolved generation.
  if (isNew || item.planWorktree !== path) await runtime.ledger.update(item.id, current => ({
    ...current, planWorktree: path,
    planWorktreeGeneration: isNew || current.planWorktree !== path ? randomUUID() : current.planWorktreeGeneration,
  }));
  if (isNew) await addPlanWorktree(runtime.repositoryFor(item), path, item.id, context);
  return { path, isNew };
}

/** Bring a plan's worktree up to date with its base, keeping its uncommitted work, as a desk sync does. */
export async function syncPlanWorktree(runtime: Runtime, ownerId: string, itemId: string, context?: MaintenanceContext) {
  const item = await runtime.ledger.get(itemId);
  if (item.owner !== ownerId) throw new Error(`item_not_yours: ${item.id} belongs to ${item.owner}`);
  if (!item.planWorktree) throw new Error(`no_plan_worktree: ${item.id} has no worktree of its own; its work is on your desk`);
  const owner = runtime.repositoryFor(item);
  context?.check();
  const sync = await syncDesk(item.planWorktree, owner.domain.baseBranch, context);
  const report = { ...sync, desk: item.planWorktree, repository: owner.domain.name, place: `worktree for plan ${item.id}` };
  return recordSync(runtime, ownerId, report, item.id);
}

export type PlanWorktreeRemoval = 'removed' | 'absent' | PlanWorktreeKept;

async function isDirty(path: string) {
  return Boolean((await git(path, ['status', '--porcelain', '--untracked-files=all', '--ignored'])).trim());
}

/** Preserve identity before removal, without retiring a directory that might still need to be kept. */
async function recordWorktreeSessions(runtime: Runtime, item: WorkItem, isRetired = false) {
  const known = await sessionHistory(runtime, item.owner);
  const references = itemSessionHistory(item);
  const observed = known.filter(session => session.directory === item.planWorktree || references.some(reference => reference.id === session.id));
  const records = new Map([...references, ...observed].map(session => [session.id, session]));
  for (const session of records.values()) {
    await rememberSession(runtime, {
      ...session, archived: session.archived || (isRetired && session.directory === item.planWorktree),
    });
  }
}

async function archiveWorktreeSessions(runtime: Runtime, item: WorkItem) {
  await requireCleanupIdentity(runtime, item, item.planWorktree!);
  if (existsSync(item.planWorktree!)) throw new Error('plan_worktree_cleanup_scope_changed');
  await recordWorktreeSessions(runtime, item, true);
}

/** Forget only the active workspace; the recorded session keeps its actual transcript directory. */
async function forgetPlanWorktree(runtime: Runtime, item: WorkItem) {
  await archiveWorktreeSessions(runtime, item);
  await runtime.notebook(item.owner).ensureJournal();
  // Journal before forgetting: a failed append leaves the item available for a safe absent-path retry.
  await runtime.notebook(item.owner).journal({
    kind: 'attention-condition', workItem: item.id,
    condition: { key: `plan-worktree:${item.id}:${item.planWorktreeGeneration ?? 'legacy'}`, state: 'resolved' },
    provenance: { kind: 'plan-worktree', workItem: item.id, path: item.planWorktree!, generation: item.planWorktreeGeneration },
    note: `Plan worktree for ${item.id} is no longer present; cleanup is complete.`,
  });
  await runtime.ledger.update(item.id, current => {
    if (!cleanupIdentityMatches(current, item, item.planWorktree!)) throw new Error('plan_worktree_cleanup_scope_changed');
    return { ...current, planWorktree: undefined, planWorktreeKept: undefined };
  });
}

async function archiveCommit(runtime: Runtime, item: WorkItem, path: string, commit: string, base: string) {
  const ref = `refs/onionsoup/archive/plans/${item.owner}/${item.id}/${item.planWorktreeGeneration ?? 'legacy'}/${commit}`;
  await git(path, ['-c', 'core.fsync=reference', 'update-ref', ref, commit, '']).catch(async (error: unknown) => {
    const saved = await git(path, ['rev-parse', '--verify', ref]).catch(() => '');
    if (saved.trim() !== commit) throw error;
  });
  if ((await git(path, ['rev-parse', '--verify', ref])).trim() !== commit) throw new Error('plan_worktree_archive_ref_unverified');
  const archive: PlanWorktreeArchive = {
    ref, commit, base, directory: path, generation: item.planWorktreeGeneration, archivedAt: new Date().toISOString(),
  };
  await runtime.ledger.update(item.id, current => ({
    ...current,
    planWorktreeArchives: current.planWorktreeArchives?.some(saved => saved.ref === ref)
      ? current.planWorktreeArchives : [...current.planWorktreeArchives ?? [], archive],
  }));
  if (!item.planWorktreeArchives?.some(saved => saved.ref === ref)) await runtime.notebook(item.owner).journal({
    kind: 'plan-worktree-archived', workItem: item.id,
    note: `Unique terminal plan commit ${commit} is retained at ${ref}; archived intent is history, not accepted publication.`,
  });
}

/** Remote reachability and landedCommit are not proof of squash containment in the declared base. */
async function preserveUniqueCommits(runtime: Runtime, item: WorkItem, path: string, context?: MaintenanceContext) {
  const owner = runtime.repositoryFor(item);
  const base = (await git(path, ['rev-parse', '--verify', `origin/${owner.domain.baseBranch}^{commit}`])).trim();
  const head = (await git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const plan = (await git(path, ['branch', '--list', '--format=%(objectname)', planBranch(item.id)])).trim();
  for (const commit of new Set([head, plan].filter(Boolean))) {
    if (await isCommitContainedInBase(path, base, commit)) continue;
    context?.check();
    await archiveCommit(runtime, item, path, commit, base);
  }
  return { head, plan };
}

async function requireCleanupIdentity(runtime: Runtime, item: WorkItem, path: string) {
  const current = await runtime.ledger.get(item.id);
  if (!cleanupIdentityMatches(current, item, path)) throw new Error('plan_worktree_cleanup_scope_changed');
}

function cleanupIdentityMatches(current: WorkItem, item: WorkItem, path: string) {
  return isFinishedPlan(current) && current.planWorktree === path && current.planWorktreeGeneration === item.planWorktreeGeneration
    && current.session?.sessionID === item.session?.sessionID;
}

async function detachPlanWorktree(runtime: Runtime, item: WorkItem, path: string, context?: MaintenanceContext): Promise<PlanWorktreeRemoval> {
  await requireCleanupIdentity(runtime, item, path);
  const known = new Set((await sessionHistory(runtime, item.owner)).map(session => session.id));
  for (const session of itemSessionHistory(item)) if (!known.has(session.id)) await rememberSession(runtime, session);
  if (!existsSync(path)) {
    await forgetPlanWorktree(runtime, item);
    return 'absent';
  }
  if (await isDirty(path)) return 'kept-uncommitted';
  const preserved = await preserveUniqueCommits(runtime, item, path, context);
  await recordWorktreeSessions(runtime, item);
  if ((await git(path, ['rev-parse', 'HEAD'])).trim() !== preserved.head) throw new Error('plan_worktree_head_changed');
  const { workspace } = runtime.repositoryFor(item);
  await requireCleanupIdentity(runtime, item, path);
  context?.check();
  if (await isDirty(path)) return 'kept-uncommitted';
  await git(workspace, ['worktree', 'remove', path]);
  if ((await git(workspace, ['branch', '--list', planBranch(item.id)])).trim()) {
    const branchHead = (await git(workspace, ['rev-parse', `refs/heads/${planBranch(item.id)}`])).trim();
    if (branchHead !== preserved.plan) throw new Error('plan_worktree_branch_changed');
    context?.check();
    await git(workspace, ['branch', '-D', planBranch(item.id)]);
  }
  await forgetPlanWorktree(runtime, item);
  return 'removed';
}

type RemovalJournal = (path: string, detail: string) => { kind: string; note: string };

const keptNote = (why: string) => (path: string) => ({
  kind: 'attention',
  note: `Owner maintenance kept plan worktree ${path}: ${why}. Inspect with \`git -C ${path} status\`; retain the work until its intent is recorded safely.`,
});

/** Kept work and cleanup failures belong to owner maintenance, never an implicit human gate. */
const REMOVAL_JOURNAL: Record<PlanWorktreeRemoval, RemovalJournal | undefined> = {
  removed: path => ({ kind: 'plan-worktree-removed', note: path }),
  absent: undefined,
  'kept-uncommitted': keptNote('it has uncommitted changes or ignored local files'),
  'kept-unpublished': keptNote('it has commits no remote branch holds'),
  failed: (path, detail) => ({ kind: 'attention', note: `plan worktree ${path} could not be removed: ${detail}` }),
};

/** A worktree that stays records why, so later passes journal only a change of reason. */
async function recordKept(runtime: Runtime, item: WorkItem, outcome: PlanWorktreeRemoval) {
  const kept = PlanWorktreeKept.safeParse(outcome);
  if (kept.success) await runtime.ledger.update(item.id, current => ({ ...current, planWorktreeKept: kept.data }));
}

/** Remove a clean terminal workspace only after unique commits and session identity have durable history. */
async function removePlanWorktree(runtime: Runtime, item: WorkItem, path: string, context?: MaintenanceContext): Promise<PlanWorktreeRemoval> {
  const { outcome, detail } = await detachPlanWorktree(runtime, item, path, context)
    .then(removal => ({ outcome: removal, detail: '' }))
    .catch((error: unknown) => ({
      outcome: 'failed' as const, detail: `plan_worktree_remove_failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  await recordRemoval(runtime, item, path, outcome, detail);
  return outcome;
}

async function recordRemoval(runtime: Runtime, item: WorkItem, path: string, outcome: PlanWorktreeRemoval, detail: string) {
  const isRepeat = outcome === item.planWorktreeKept;
  const entry = isRepeat ? undefined : REMOVAL_JOURNAL[outcome]?.(path, detail);
  if (entry) await runtime.notebook(item.owner).journal({
    ...entry, workItem: item.id, outcome,
    provenance: { kind: 'plan-worktree', workItem: item.id, path, generation: item.planWorktreeGeneration },
    ...(entry.kind === 'attention' ? { kind: 'attention-condition', condition: { key: `plan-worktree:${item.id}:${item.planWorktreeGeneration ?? 'legacy'}`, state: 'open' as const } } : {}),
  });
  await recordKept(runtime, item, outcome);
}

/** How long a finished plan's session must have been idle before the cleanup pass removes its worktree. */
export const PLAN_WORKTREE_LIMITS = { idleBeforeRemovalHours: 24 };

const HOUR_MS = 3_600_000;

/**
 * The states in which a plan is done with its worktree: landed with its PR merged or closed (a landed item cannot be
 * cancelled, so a closed PR would otherwise keep it forever), accepted without a PR, cancelled or rejected.
 * A failed item can still be resumed.
 */
const IS_FINISHED: Partial<Record<WorkStatus, (item: WorkItem) => boolean>> = {
  landed: item => item.publication?.state !== 'open',
  cancelled: () => true,
  rejected: () => true,
};

function isFinishedPlan(item: WorkItem) {
  return Boolean(item.planWorktree) && item.activeRunner === undefined && (IS_FINISHED[item.status]?.(item) ?? false);
}

type ActivityReader = Pick<OwnerSessionClient, 'activity'>;

/**
 * Whether the plan's session has been idle for the limit: not busy (or retrying), and last updated before it. An
 * item without a session, or whose session is gone, counts from the item's own last update.
 */
async function hasIdleSession(runtime: Runtime, item: WorkItem, sessions: ActivityReader, now: Date) {
  // A missing workspace is history, never a directory-scoped SDK admission that can recreate it.
  const known = item.session && await rememberedSession(runtime, item.session.sessionID);
  if (known && (known.owner !== item.owner || known.directory !== item.session!.directory)) {
    throw new Error('plan_worktree_session_identity_conflict');
  }
  const canProbe = item.session && existsSync(item.session.directory) && !known?.archived;
  const activity = canProbe ? await sessions.activity(item.session!) : { isBusy: false, updatedAt: undefined };
  const lastRecorded = known?.archived ? known.time.updated : undefined;
  const lastActive = activity.updatedAt ?? lastRecorded ?? Date.parse(item.updatedAt);
  if (!Number.isFinite(lastActive)) throw new Error('plan_worktree_activity_invalid');
  const isQuiet = now.getTime() - lastActive >= PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours * HOUR_MS;
  return !activity.isBusy && isQuiet;
}

async function removeIfIdle(runtime: Runtime, item: WorkItem, sessions: ActivityReader, now: Date, context?: MaintenanceContext) {
  context?.check();
  const isIdle = await hasIdleSession(runtime, item, sessions, now).catch(async (error: unknown) => {
    const detail = `plan_worktree_activity_unknown: ${error instanceof Error ? error.message : String(error)}`;
    await recordRemoval(runtime, item, item.planWorktree!, 'failed', detail);
    throw error;
  });
  if (isIdle) await removePlanWorktree(runtime, item, item.planWorktree!, context);
}

/**
 * The cleanup pass. Merging or cancelling a plan never removes its worktree at once: the session may still be working
 * there. Each finished plan's worktree goes once its session has been idle for `PLAN_WORKTREE_LIMITS`. The plugin
 * runs this, since it holds the opencode client; a failure leaves that item for the next pass.
 */
export async function removeIdlePlanWorktrees(
  runtime: Runtime, sessions: ActivityReader, onError: (itemId: string, error: unknown) => void, now = new Date(), context?: MaintenanceContext,
) {
  const finished = (await runtime.ledger.list()).filter(isFinishedPlan);
  for (const item of finished) await removeIfIdle(runtime, item, sessions, now, context).catch((error: unknown) => onError(item.id, error));
}
