import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImplementationReport, ProposedWork, Verdict } from './artifacts.ts';
import { requireFreelancer } from './declarations.ts';
import { pickModel } from './families.ts';
import type { WorkItem, WorkStatus } from './ledger.ts';
import type { Runtime } from './runtime.ts';
import { createWorktree, diffAgainstBase, git, gitWithLiteralPathspecs, verificationPassed, verify } from './workspace.ts';

const run = promisify(execFile);

/**
 * Keeping published PRs mergeable is part of owning a repository. A conflicting PR gets a rebase work
 * item: the landed commit is replayed onto the current base in a fresh worktree. Detection and a clean
 * replay that passes verification are deterministic and need no model. A conflict wakes the owner, who
 * decides whether to abandon the PR or how it must be combined; only then is an implementer hired, and a
 * reviewer from another family confirms it is still the same change. Force-pushing over the PR branch
 * rewrites history, so it always waits for a person (`approve-push`).
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

export const CI_TRIAGE_LIMITS = { logChars: 12_000 };

const Check = z.object({ name: z.string(), bucket: z.string(), link: z.string().default('') });

async function failingChecks(url: string) {
  const text = await run('gh', ['pr', 'checks', url, '--json', 'name,bucket,link']).then(result => result.stdout, error => (error as { stdout?: string }).stdout ?? '[]');
  return z.array(Check).parse(JSON.parse(text || '[]')).filter(check => check.bucket === 'fail');
}

async function failedLogs(checks: readonly z.infer<typeof Check>[]) {
  const runIds = [...new Set(checks.map(check => check.link.match(/\/actions\/runs\/(\d+)/)?.[1]).filter(Boolean))] as string[];
  const logs: string[] = [];
  for (const runId of runIds) {
    const text = await run('gh', ['run', 'view', runId, '--log-failed'], { maxBuffer: 64 * 1024 * 1024 }).then(result => result.stdout, () => '');
    logs.push(`run ${runId}:\n${text.slice(-CI_TRIAGE_LIMITS.logChars / Math.max(1, runIds.length))}`);
  }
  return logs.join('\n\n');
}

export const CiTriage = z.object({
  decision: z.enum(['fix', 'flaky', 'person']),
  reason: z.string(),
  fix: ProposedWork.optional().describe('Required for fix: the work item to plan'),
});

async function readTriaged(runtime: Runtime, ownerId: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(join(runtime.stateDirectory, `ci-triage-${ownerId}.json`), 'utf8').catch(() => '{}')) as Record<string, string>;
}

/** CI failed on a published PR's head commit: wake the owner once for that commit to decide fix, flaky or person. */
async function triageFailingCi(runtime: Runtime, item: WorkItem, headSha: string) {
  const triaged = await readTriaged(runtime, item.owner);
  if (triaged[item.publication!.url] === headSha) return undefined;
  const failing = await failingChecks(item.publication!.url);
  if (!failing.length) return undefined;
  const owner = runtime.owner(item.owner);
  const notebook = runtime.notebook(owner.id);
  const brief = [
    `CI failed on your published PR ${item.publication!.url} ("${item.proposal.title}") at ${headSha.slice(0, 12)}.`,
    `<failing-checks>\n${failing.map(check => `- ${check.name}: ${check.link}`).join('\n')}\n</failing-checks>`,
    `<failed-logs>\n${await failedLogs(failing)}\n</failed-logs>`,
    `<notebook>\n${await notebook.orientation()}\n</notebook>`,
    'Decide as the owner: fix (describe the work to plan; the person approves the plan), flaky (not caused by the change; say why), or person (needs the person: secrets, infrastructure, policy).',
  ].join('\n\n');
  const decision = (await runtime.hire(owner.id, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${owner.id}: CI triage`, brief, schema: CiTriage })).value;
  triaged[item.publication!.url] = headSha;
  await writeFile(join(runtime.stateDirectory, `ci-triage-${owner.id}.json`), JSON.stringify(triaged, null, 2) + '\n');
  const kind = decision.decision === 'person' ? 'attention' : 'ci-triage';
  await notebook.journal({ kind, workItem: item.id, outcome: decision.decision, note: `CI on ${item.publication!.url}: ${decision.reason}` });
  if (decision.decision === 'fix' && decision.fix && owner.workflow) return runtime.ledger.create(owner.id, owner.workflow, { ...decision.fix, repository: item.proposal.repository });
  return undefined;
}

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
    const fix = await triageFailingCi(runtime, item, pr.headRefOid).catch(error => {
      notes.push(`${item.publication!.url} CI triage failed: ${error instanceof Error ? error.message : error}`);
      return undefined;
    });
    if (fix) {
      opened.push(fix);
      notes.push(`${item.publication!.url} CI failing → ${fix.id}`);
    }
    if (pr.mergeable !== 'CONFLICTING' || openRebases.has(item.id)) continue;
    const rebase = await runtime.ledger.create(ownerId, REBASE_WORKFLOW, {
      title: `Rebase "${item.proposal.title}" onto the current base`,
      goal: `Bring ${item.publication!.url} up to date with the base branch without changing what it does.`,
      rationale: 'GitHub reports the PR as conflicting with the base branch.',
      acceptance: ['The PR applies cleanly to the current base', 'Host verification passes', 'The change is the same change the plan approved'],
      size: 'small',
      repository: item.proposal.repository,
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

/**
 * Every path git sees changed in the worktree or untracked, outside what conflict resolution staged, so it can
 * be reported instead of silently swept in. A path whose only change is already staged (the non-conflicting
 * part of an in-progress cherry-pick, committed by the `cherry-pick --continue` that follows) is not a
 * leftover: it was never left out of the commit.
 */
async function unstagedPaths(worktree: string, staged: ReadonlySet<string>) {
  const { stdout } = await run('git', ['-C', worktree, 'status', '--porcelain', '-z'], { maxBuffer: 32 * 1024 * 1024 });
  const fields = stdout.split('\0').filter(Boolean);
  const leftovers: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    const path = entry.slice(3);
    if (/^[RC]/.test(entry)) index += 1; // a rename or copy record is followed by the old path in its own field
    const worktreeStatus = entry[1];
    const isUntracked = entry.startsWith('??');
    const hasUncommittedWorktreeChange = isUntracked || worktreeStatus !== ' ';
    if (hasUncommittedWorktreeChange && !staged.has(path)) leftovers.push(path);
  }
  return leftovers;
}

/**
 * Stage only the paths a conflict resolution actually concerns: the originally conflicted files plus whatever
 * the implementer reports it touched. `git add -A` would sweep in anything else left in the worktree, tracked
 * or not (a regenerated lockfile from verification, a scratch directory) — never a complete approved change,
 * unlike `commitWorktree`. Pathspec magic is disabled so a conflicted or reported filename containing `*`,
 * `?`, `[]` or a leading `-` matches only itself, never anything else in the worktree. A path that no longer
 * matches anything (a hallucinated report) is skipped rather than failing the whole stage, since `git add --`
 * is otherwise all-or-nothing across its pathspecs.
 */
export async function stageConflictResolution(worktree: string, files: readonly string[], filesChanged: readonly string[]) {
  const staged = new Set([...files, ...filesChanged]);
  for (const path of staged) await gitWithLiteralPathspecs(worktree, ['add', '--', path]).catch(() => undefined);
  const leftovers = await unstagedPaths(worktree, staged);
  return { staged: [...staged], leftovers };
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

export const ConflictDecision = z.object({
  decision: z.enum(['resolve', 'abandon']),
  guidance: z.string().describe('For resolve: what the implementer must keep from each side and how to combine them'),
  reason: z.string().describe('Why, citing what landed on the base branch'),
});
export type ConflictDecision = z.infer<typeof ConflictDecision>;

function conflictBrief(source: WorkItem, files: readonly string[], originalPatch: string, baseChanges: string, notebook: string) {
  return [
    `Your published PR ${source.publication?.url ?? ''} ("${source.proposal.title}") conflicts with the base branch.`,
    `<conflicted-files>\n${files.join('\n')}\n</conflicted-files>`,
    `<your-original-change>\n${originalPatch}\n</your-original-change>`,
    `<what-landed-on-the-base-since>\n${baseChanges}\n</what-landed-on-the-base-since>`,
    `<notebook>\n${notebook}\n</notebook>`,
    `As the owner, decide. resolve: the change is still wanted; tell the implementer you will hire exactly how to combine
both sides. abandon: the base already covers it or it no longer makes sense; say why. You do not edit anything.`,
  ].join('\n\n');
}

/** The owner is the project manager: it decides whether and how a conflict is resolved before anyone is hired. */
async function ownerDecidesConflict(runtime: Runtime, item: WorkItem, source: WorkItem, worktree: string, files: string[], originalPatch: string) {
  const owner = runtime.repositoryFor(item);
  const originalBase = (await git(worktree, ['rev-parse', `${source.landedCommit!}~1`])).trim();
  const baseChanges = (await git(worktree, ['log', '--stat', '--format=%h %s', `${originalBase}..origin/${owner.domain.baseBranch}`])).slice(0, 20_000);
  const brief = conflictBrief(source, files, originalPatch, baseChanges, await runtime.notebook(owner.id).orientation());
  return runtime.hireFor(item, 'decide', 'owner', { role: 'owner', model: owner.model, directory: owner.workspace, title: `${item.id}: owner decides conflict`, brief, schema: ConflictDecision });
}

class Abandoned extends Error {}

async function resolveConflicts(runtime: Runtime, item: WorkItem, source: WorkItem, worktree: string, files: string[]) {
  const originalPatch = (await git(worktree, ['show', source.landedCommit!])).slice(0, 40_000);
  const decision = await ownerDecidesConflict(runtime, item, source, worktree, files, originalPatch);
  await runtime.notebook(item.owner).journal({ kind: 'conflict-decision', workItem: item.id, outcome: decision.decision, note: decision.reason });
  if (decision.decision === 'abandon') throw new Abandoned(`owner_abandoned: ${decision.reason}`);
  const declaration = requireFreelancer(runtime.declarations, 'implementation');
  const { model } = pickModel(runtime.declarations.families, declaration.models, []);
  const report = await runtime.hireFor(item, 'implement', 'implementation', {
    role: 'implementer', model, directory: worktree, title: `${item.id}: resolve conflicts`,
    brief: `${resolveBrief(item, source, files, originalPatch)}\n\n<owner-guidance>\n${decision.guidance}\n</owner-guidance>`, schema: ImplementationReport,
  });
  if (await hasConflictMarkers(worktree)) throw new Error('conflict_markers_remain');
  const { leftovers } = await stageConflictResolution(worktree, files, report.filesChanged);
  await git(worktree, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
  if (!leftovers.length) return report;
  return { ...report, summary: `${report.summary}\n\nLeft out of the commit (not part of this conflict resolution): ${leftovers.join(', ')}` };
}

async function replay(runtime: Runtime, item: WorkItem): Promise<WorkItem> {
  const owner = runtime.repositoryFor(item);
  const source = await runtime.ledger.get(item.rebaseOf!.itemId);
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  const { path, branch } = await createWorktree(owner, runtime.worktreesRoot, item.id);
  await git(path, ['cherry-pick', '--abort']).catch(() => '');
  await git(path, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  await git(path, ['clean', '-q', '-fd']);
  const picked = await git(path, ['cherry-pick', source.landedCommit!]).then(() => true, () => false);
  const files = picked ? [] : await conflictedFiles(path);
  if (!picked && !files.length) throw new Error('cherry_pick_failed_without_conflicts');
  const report = picked
    ? { summary: 'Replayed cleanly; no conflicts.', filesChanged: [], deviationsFromPlan: [] }
    : await resolveConflicts(runtime, item, source, path, files);
  const diff = await diffAgainstBase(owner, path);
  const verification = await verify(owner, path, runtime.toolsDirectory);
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
  const owner = runtime.repositoryFor(item);
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
    const current = await runtime.ledger.save({ ...item, activeRunner: process.pid });
    try {
      item = await step(runtime, current);
    } catch (error) {
      const status = error instanceof Abandoned ? 'rejected' : 'failed';
      item = transition(current, status, error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
    item = await runtime.ledger.save({ ...item, activeRunner: undefined });
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
