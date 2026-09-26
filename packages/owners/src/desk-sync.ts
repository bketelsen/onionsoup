import { isFinished, type WorkItem } from './ledger.ts';
import type { Runtime } from './runtime.ts';
import { ensureDesk, git } from './workspace.ts';

/**
 * Bringing a desk up to date with its base branch, in host code. A desk is made from `origin/<base>` and reset only
 * after its own change lands, so other merges leave it behind; a change built there then reads to the reviewer as
 * reverting them. Owners may not run history-changing git, so this does it for them: uncommitted work is set aside
 * under a unique stash, the desk moves to the base, and the work comes back. A conflict keeps the stash and names the
 * files; nothing is ever discarded.
 */
export type DeskSyncOutcome = 'current' | 'updated' | 'conflicts';

export interface DeskSync {
  outcome: DeskSyncOutcome;
  from: string;
  to: string;
  conflicts: string[];
  stash?: string;
}

async function isAncestor(deskPath: string, ancestor: string, descendant: string) {
  return git(deskPath, ['merge-base', '--is-ancestor', ancestor, descendant]).then(() => true, () => false);
}

/**
 * Whether the base already has everything the desk's commits change: merging the desk into the base leaves the base's
 * tree as it is. True after a squash merge, whose original commits no remote holds once the PR branch is deleted.
 */
async function isContainedInBase(deskPath: string, base: string) {
  const merged = await git(deskPath, ['merge-tree', '--write-tree', base, 'HEAD']).then(output => output.split('\n')[0]!.trim(), () => undefined);
  return merged === (await git(deskPath, ['rev-parse', `${base}^{tree}`])).trim();
}

/** Commits on the desk that no remote branch holds and the base does not contain would be lost by moving the desk. */
async function requireNothingUnpublished(deskPath: string, base: string) {
  const unpublished = (await git(deskPath, ['rev-list', 'HEAD', '--not', base, '--remotes'])).trim();
  if (!unpublished || await isContainedInBase(deskPath, base)) return;
  throw new Error(`desk_has_unpublished_commits: ${unpublished.split('\n').length} commit(s) on the desk are in no remote branch and not in ${base}; propose them first`);
}

async function stashWork(deskPath: string) {
  const tag = `onionsoup-desk-sync-${Date.now()}`;
  // Intent-to-add entries (left by propose_changes) make `git stash` refuse; clearing the index keeps every file.
  await git(deskPath, ['reset', '-q']);
  await git(deskPath, ['stash', 'push', '-q', '-u', '-m', tag]);
  const entry = (await git(deskPath, ['stash', 'list', '--format=%H %gs'])).split('\n').find(line => line.endsWith(tag));
  if (!entry) throw new Error('desk_sync_stash_missing: the work was not set aside; nothing was moved');
  return entry.split(' ')[0]!;
}

/** Drop exactly the stash this sync made; stashes are shared by every worktree of the checkout. */
async function dropStash(deskPath: string, sha: string) {
  const entry = (await git(deskPath, ['stash', 'list', '--format=%H %gd'])).split('\n').find(line => line.startsWith(`${sha} `));
  if (entry) await git(deskPath, ['stash', 'drop', '-q', entry.split(' ')[1]!]);
}

async function restoreWork(deskPath: string, sha: string) {
  const applied = await git(deskPath, ['stash', 'apply', sha]).then(() => true, () => false);
  const conflicts = (await git(deskPath, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
  if (!applied && !conflicts.length) throw new Error(`desk_sync_restore_failed: the work is kept in stash ${sha}; restore it with the person`);
  if (applied && !conflicts.length) await dropStash(deskPath, sha);
  return conflicts;
}

export async function syncDesk(deskPath: string, baseBranch: string): Promise<DeskSync> {
  await git(deskPath, ['fetch', '-q', 'origin']);
  const base = `origin/${baseBranch}`;
  const from = (await git(deskPath, ['rev-parse', 'HEAD'])).trim();
  const to = (await git(deskPath, ['rev-parse', base])).trim();
  if (await isAncestor(deskPath, to, from)) return { outcome: 'current', from, to, conflicts: [] };
  await requireNothingUnpublished(deskPath, base);
  const isDirty = Boolean((await git(deskPath, ['status', '--porcelain'])).trim());
  const stash = isDirty ? await stashWork(deskPath) : undefined;
  await git(deskPath, ['reset', '-q', '--hard', to]);
  const conflicts = stash ? await restoreWork(deskPath, stash) : [];
  return { outcome: conflicts.length ? 'conflicts' : 'updated', from, to, conflicts, stash: conflicts.length ? stash : undefined };
}

/** A sync as the owner hears of it: which worktree moved (`place`, e.g. "desk for org/repo") and where it is. */
export interface DeskSyncReport extends DeskSync { desk: string; repository: string; place: string }

/** Journal a sync in the owner's notebook, naming the plan item when it was a plan's worktree. */
export async function recordSync(runtime: Runtime, ownerId: string, report: DeskSyncReport, workItem?: string) {
  const conflicts = report.conflicts.length ? `; conflicts in ${report.conflicts.join(', ')}` : '';
  const note = `${report.place}: ${report.from.slice(0, 12)} → ${report.to.slice(0, 12)}${conflicts}`;
  const notebook = runtime.notebook(ownerId);
  await notebook.journal({ kind: 'desk-synced', workItem, outcome: report.outcome, note });
  await notebook.commit('journal desk-synced').catch(() => undefined);
  return report;
}

/**
 * The open PR the desk is on, after onionsoup_checkout_pr: its head is in the desk's history and not yet in the base.
 * Syncing would move the desk to the base and drop the PR's commits from under the repair.
 */
async function pullRequestUnderDesk(deskPath: string, baseBranch: string, items: readonly WorkItem[]) {
  const head = (await git(deskPath, ['rev-parse', 'HEAD'])).trim();
  for (const item of items.filter(candidate => candidate.publication?.state === 'open')) {
    const prHead = `origin/${item.publication!.branch}`;
    const isUnderDesk = await isAncestor(deskPath, prHead, head);
    if (isUnderDesk && !(await isAncestor(deskPath, prHead, `origin/${baseBranch}`))) return item;
  }
  return undefined;
}

/** Why a desk on a PR is not synced, and what brings that PR up to date with its base instead. */
function onPullRequestText(pullRequest: WorkItem, items: readonly WorkItem[]) {
  const rebase = items.find(item => item.rebaseOf?.itemId === pullRequest.id && !isFinished(item));
  const upToDate = rebase
    ? `${rebase.id} is already rebasing it onto the base; wait for it rather than resolving the conflict yourself`
    : 'conflicts with the base are resolved by your maintain-prs rebase, not on your desk';
  return `desk_on_pull_request: your desk is on ${pullRequest.publication!.url} (${pullRequest.id}); syncing would drop its commits. ${upToDate}. To change the PR's content, fix it on the desk and propose with item "${pullRequest.id}".`;
}

/** An owner's desk for one of its repositories, synced; a desk on a PR (a repair) is left where it is. */
export async function syncOwnerDesk(runtime: Runtime, ownerId: string, repository?: string) {
  const owner = runtime.repositoryOwner(ownerId, repository);
  const desk = await ensureDesk(owner, runtime.desksRoot);
  const branch = (await git(desk.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (branch !== desk.branch) throw new Error(`desk_on_pull_request: the desk is on ${branch}; propose or finish that repair first`);
  await git(desk.path, ['fetch', '-q', 'origin']);
  const items = await runtime.ledger.list();
  const pullRequest = await pullRequestUnderDesk(desk.path, owner.domain.baseBranch, items.filter(item => item.owner === ownerId && runtime.repositoryFor(item).domain.name === owner.domain.name));
  if (pullRequest) throw new Error(onPullRequestText(pullRequest, items));
  const sync = await syncDesk(desk.path, owner.domain.baseBranch);
  const place = `desk for ${owner.domain.name}`;
  return recordSync(runtime, ownerId, { ...sync, desk: desk.path, repository: owner.domain.name, place });
}

const SYNC_TEXT: Record<DeskSyncOutcome, (sync: DeskSyncReport) => string> = {
  current: sync => `Your ${sync.place} already includes origin at ${sync.to.slice(0, 12)}; nothing to do.`,
  updated: sync => `Your ${sync.place} moved from ${sync.from.slice(0, 12)} to ${sync.to.slice(0, 12)}, with your uncommitted work restored. Re-run your checks before proposing.`,
  conflicts: sync => `Your ${sync.place} moved to ${sync.to.slice(0, 12)}, but restoring your work conflicted in: ${sync.conflicts.join(', ')}. Resolve the conflict markers in those files (your work is also kept in stash ${sync.stash?.slice(0, 12)}), then re-run your checks.`,
};

export function deskSyncText(sync: DeskSyncReport) {
  return SYNC_TEXT[sync.outcome](sync);
}
