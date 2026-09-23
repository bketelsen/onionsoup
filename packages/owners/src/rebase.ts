import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ImplementationReport, Verdict } from './artifacts.ts';
import { requireFreelancer } from './declarations.ts';
import { pickModel } from './families.ts';
import type { WorkItem, WorkStatus } from './ledger.ts';
import type { Runtime } from './runtime.ts';
import { createWorktree, diffAgainstBase, git, verificationPassed, verify } from './workspace.ts';

const run = promisify(execFile);

/**
 * Keeping published PRs mergeable is part of owning a repository. A conflicting PR gets a rebase work
 * item: the landed commit is replayed onto the current base in a fresh worktree. A clean replay that
 * passes verification is mechanical and needs no model; a conflicted one hires an implementer to
 * resolve it and a reviewer from another family to confirm it is still the same change. Force-pushing
 * over the PR branch rewrites history, so it always waits for a person (`approve-push`).
 */
export const REBASE_WORKFLOW = 'rebase';

const PullRequest = z.object({ state: z.string(), mergeable: z.string(), headRefOid: z.string() });

async function pullRequest(url: string) {
  const { stdout } = await run('gh', ['pr', 'view', url, '--json', 'state,mergeable,headRefOid']);
  return PullRequest.parse(JSON.parse(stdout));
}

/** mergeable is computed lazily by GitHub; ask again briefly while it says UNKNOWN. */
async function settledPullRequest(url: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await pullRequest(url);
    if (current.mergeable !== 'UNKNOWN' || current.state !== 'OPEN') return current;
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  return pullRequest(url);
}

const PR_STATES: Record<string, 'open' | 'merged' | 'closed'> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** The maintain-prs duty: record merges and closes, and open a rebase work item for each conflicting PR. */
export async function maintainPullRequests(runtime: Runtime, ownerId: string) {
  const items = (await runtime.ledger.list()).filter(item => item.owner === ownerId);
  const openRebases = new Set(items.filter(item => item.rebaseOf && !['landed', 'failed', 'rejected'].includes(item.status)).map(item => item.rebaseOf!.itemId));
  const notes: string[] = [];
  const opened: WorkItem[] = [];
  for (const item of items.filter(candidate => candidate.publication?.state === 'open')) {
    const pr = await settledPullRequest(item.publication!.url);
    const state = PR_STATES[pr.state] ?? 'open';
    if (state !== 'open') {
      await runtime.ledger.save({ ...item, publication: { ...item.publication!, state } });
      notes.push(`${item.publication!.url} ${state}`);
      continue;
    }
    if (pr.mergeable !== 'CONFLICTING' || openRebases.has(item.id)) continue;
    const rebase = await runtime.ledger.create(ownerId, REBASE_WORKFLOW, {
      title: `Rebase "${item.proposal.title}" onto the current base`,
      goal: `Bring ${item.publication!.url} up to date with the base branch without changing what it does.`,
      rationale: 'GitHub reports the PR as conflicting with the base branch.',
      acceptance: ['The PR applies cleanly to the current base', 'Host verification passes', 'The change is the same change the plan approved'],
      size: 'small',
    }, { status: 'implementing', rebaseOf: { itemId: item.id, branch: item.branch!, prUrl: item.publication!.url, previousHead: pr.headRefOid } });
    opened.push(rebase);
    notes.push(`${item.publication!.url} conflicting → ${rebase.id}`);
  }
  const notebook = runtime.notebook(ownerId);
  await notebook.journal({ kind: 'maintain-prs', note: notes.join('; ') || 'all published PRs are mergeable' });
  await notebook.commit('journal maintain-prs');
  return { summary: notes.join('; ') || 'all published PRs are mergeable', opened };
}

function transition(item: WorkItem, status: WorkStatus, reason?: string): WorkItem {
  return { ...item, status, reason };
}

async function conflictedFiles(worktree: string) {
  return (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
}

async function hasConflictMarkers(worktree: string) {
  const grep = await run('git', ['-C', worktree, 'grep', '-n', '-E', '^(<<<<<<<|>>>>>>>)( |$)'], { maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: '' }));
  return grep.stdout.trim().length > 0;
}

function resolveBrief(item: WorkItem, source: WorkItem, files: readonly string[], originalPatch: string) {
  return [
    'You have been hired to finish a cherry-pick that stopped on conflicts. The working tree is mid cherry-pick.',
    `The change being replayed: "${source.proposal.title}". Its approved plan: ${source.plan?.summary ?? source.proposal.goal}`,
    `<conflicted-files>\n${files.join('\n')}\n</conflicted-files>`,
    `<original-change>\n${originalPatch}\n</original-change>`,
    `Resolve every conflict so the result is the original change applied on top of the new base: keep everything the base
added, and re-apply the original change's intent. Remove all conflict markers. Run the tests. Do not commit and do not
run git commands that change history; the runtime continues the cherry-pick after you.`,
  ].join('\n\n');
}

async function resolveConflicts(runtime: Runtime, item: WorkItem, source: WorkItem, worktree: string, files: string[]) {
  const declaration = requireFreelancer(runtime.declarations, 'implementation');
  const { model } = pickModel(runtime.declarations.families, declaration.models, []);
  const originalPatch = (await git(worktree, ['show', source.landedCommit!])).slice(0, 40_000);
  const report = await runtime.hireFor(item, 'implement', 'implementation', {
    role: 'implementer', model, directory: worktree, title: `${item.id}: resolve conflicts`,
    brief: resolveBrief(item, source, files, originalPatch), schema: ImplementationReport,
  });
  if (await hasConflictMarkers(worktree)) throw new Error('conflict_markers_remain');
  await git(worktree, ['add', '-A']);
  await git(worktree, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
  return report;
}

async function replay(runtime: Runtime, item: WorkItem): Promise<WorkItem> {
  const owner = runtime.repositoryOwner(item.owner);
  const source = await runtime.ledger.get(item.rebaseOf!.itemId);
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  const { path, branch } = await createWorktree(owner, runtime.worktreesRoot, item.id);
  await git(path, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  const picked = await git(path, ['cherry-pick', source.landedCommit!]).then(() => true, () => false);
  const files = picked ? [] : await conflictedFiles(path);
  if (!picked && !files.length) throw new Error('cherry_pick_failed_without_conflicts');
  const report = picked
    ? { summary: 'Replayed cleanly; no conflicts.', filesChanged: [], deviationsFromPlan: [] }
    : await resolveConflicts(runtime, item, source, path, files);
  const diff = await diffAgainstBase(owner, path);
  const verification = await verify(owner, path);
  const replayed = { ...item, worktree: path, branch, implementations: [...item.implementations, { report, diffStat: diff.stat, verification }] };
  await runtime.notebook(item.owner).journal({ kind: 'rebase', workItem: item.id, outcome: picked ? 'clean' : `resolved ${files.length} conflicted files`, note: diff.stat.split('\n').at(-1) });
  if (!verificationPassed(verification)) return transition(replayed, 'failed', 'verification_failed_after_rebase');
  return transition(replayed, picked ? 'awaiting-push-approval' : 'reviewing');
}

function reviewResolutionBrief(source: WorkItem, originalPatch: string, rebasedPatch: string) {
  return [
    'You have been hired to review a conflict resolution. Do not edit anything.',
    `An approved change ("${source.proposal.title}") conflicted with the new base branch and a freelancer resolved it.`,
    `<original-change>\n${originalPatch}\n</original-change>`,
    `<rebased-change-against-new-base>\n${rebasedPatch}\n</rebased-change-against-new-base>`,
    'Approve only if the rebased change does what the original did, drops nothing the base added, and adds nothing else. Otherwise revise, with findings.',
  ].join('\n\n');
}

async function reviewResolution(runtime: Runtime, item: WorkItem): Promise<WorkItem> {
  const owner = runtime.repositoryOwner(item.owner);
  const source = await runtime.ledger.get(item.rebaseOf!.itemId);
  const implementerFamily = item.hires.filter(hire => hire.stage === 'implement' && hire.outcome === 'delivered').at(-1)?.family;
  const declaration = requireFreelancer(runtime.declarations, 'review');
  const { model } = pickModel(runtime.declarations.families, declaration.models, implementerFamily ? [implementerFamily] : []);
  const originalPatch = (await git(owner.workspace, ['show', source.landedCommit!])).slice(0, 30_000);
  const rebasedPatch = (await diffAgainstBase(owner, item.worktree!)).patch.slice(0, 30_000);
  const verdict = await runtime.hireFor(item, 'review', 'review', {
    role: 'reviewer', model, directory: item.worktree!, title: `${item.id}: review resolution`,
    brief: reviewResolutionBrief(source, originalPatch, rebasedPatch), schema: Verdict,
  });
  const reviewed = { ...item, verdicts: [...item.verdicts, verdict] };
  return verdict.decision === 'approve' ? transition(reviewed, 'awaiting-push-approval') : transition(reviewed, 'failed', `resolution_not_approved: ${verdict.summary}`);
}

/** Only after a person approved: overwrite the PR branch, refusing if it moved since we looked. */
async function push(runtime: Runtime, item: WorkItem): Promise<WorkItem> {
  const { branch, previousHead, itemId } = item.rebaseOf!;
  await git(item.worktree!, ['push', '-q', `--force-with-lease=${branch}:${previousHead}`, 'origin', `HEAD:${branch}`]);
  const head = (await git(item.worktree!, ['rev-parse', 'HEAD'])).trim();
  const source = await runtime.ledger.get(itemId);
  await runtime.ledger.save({ ...source, landedCommit: head });
  await runtime.notebook(item.owner).journal({ kind: 'rebase-pushed', workItem: item.id, outcome: head.slice(0, 8), note: item.rebaseOf!.prUrl });
  return { ...transition(item, 'landed'), landedCommit: head };
}

type Step = (runtime: Runtime, item: WorkItem) => Promise<WorkItem>;

const REBASE_STEPS: Partial<Record<WorkStatus, Step>> = {
  implementing: replay,
  reviewing: reviewResolution,
  landing: push,
};

export async function advanceRebase(runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void) {
  let item = await runtime.ledger.get(itemId);
  if (item.status === 'interrupted') item = transition(item, 'implementing');
  let step = REBASE_STEPS[item.status];
  while (step) {
    const current = await runtime.ledger.save(item);
    try {
      item = await step(runtime, current);
    } catch (error) {
      item = transition(current, 'failed', error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
    item = await runtime.ledger.save(item);
    onProgress(item);
    step = REBASE_STEPS[item.status];
  }
  await runtime.notebook(item.owner).commit(`journal ${item.id}`);
  return item;
}

/** The destructive-action gate for rebases. Only records the decision; the runtime pushes. */
export async function approvePush(runtime: Runtime, itemId: string, by: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.status !== 'awaiting-push-approval') throw new Error(`not_awaiting_push_approval: ${item.status}`);
  await runtime.notebook(item.owner).journal({ kind: 'push-approved', workItem: item.id, note: by });
  return runtime.ledger.save({ ...transition(item, 'landing'), humanNotes: [...item.humanNotes, { kind: 'approval', by, at: new Date().toISOString(), note: 'force-push approved' }] });
}
