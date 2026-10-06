import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImplementationReport, Verdict } from './artifacts.ts';
import { canChange, requireFreelancer } from './declarations.ts';
import { tellOwner } from './plan-work.ts';
import { pickModel } from './families.ts';
import { isFinished, isPaused, type WorkItem, type WorkStatus } from './ledger.ts';
import { settleItemPause, stoppedRunnerPause } from './work-pause.ts';
import type { Runtime } from './runtime.ts';
import { REPOSITORY_REVIEW, REPOSITORY_WRITING } from './repository-writing.ts';
import { createWorktree, diffAgainstBase, git, gitWithLiteralPathspecs, matchHead, verificationPassed, verify } from './workspace.ts';

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

const PullRequest = z.object({
  state: z.string(), mergeable: z.string(), mergeStateStatus: z.string().default('UNKNOWN'), headRefOid: z.string(),
});
export const PULL_REQUEST_MAINTENANCE_LIMITS = { settleAttempts: 5, settleDelayMs: 3_000 };

async function pullRequest(url: string) {
  const { stdout } = await run('gh', ['pr', 'view', url, '--json', 'state,mergeable,mergeStateStatus,headRefOid']);
  return PullRequest.parse(JSON.parse(stdout));
}

/** mergeable is computed lazily by GitHub; ask again briefly while it says UNKNOWN. */
async function settledPullRequest(url: string) {
  for (let attempt = 0; attempt < PULL_REQUEST_MAINTENANCE_LIMITS.settleAttempts; attempt += 1) {
    const current = await pullRequest(url);
    if (current.mergeable !== 'UNKNOWN' || current.state !== 'OPEN') return current;
    await new Promise(resolve => setTimeout(resolve, PULL_REQUEST_MAINTENANCE_LIMITS.settleDelayMs));
  }
  return pullRequest(url);
}

const PR_STATES: Record<string, 'open' | 'merged' | 'closed'> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

const PullRequestState = z.object({ state: z.string() });

async function publicationState(url: string) {
  const { stdout } = await run('gh', ['pr', 'view', url, '--json', 'state']);
  return PR_STATES[PullRequestState.parse(JSON.parse(stdout)).state] ?? 'open';
}

/** What a refresh saw: publications that merged or closed, and those whose state could not be read. */
export interface PublicationRefresh { changed: string[]; unreadable: string[] }

/**
 * Record merges and closes of every open publication (CI repairs too, which share their PR), with one state read each
 * and no wait for mergeability. The daemon runs it every tick, so delegated requests and merge notices
 * react within a minute instead of waiting for the next maintain-prs duty. Only the state is written.
 */
export async function refreshPublications(runtime: Runtime, ownerId?: string): Promise<PublicationRefresh> {
  const open = (await runtime.ledger.list())
    .filter(item => item.publication?.state === 'open' && (!ownerId || item.owner === ownerId));
  const refresh: PublicationRefresh = { changed: [], unreadable: [] };
  for (const item of open) {
    const url = item.publication!.url;
    const state = await publicationState(url).catch(() => undefined);
    if (!state) refresh.unreadable.push(url);
    if (!state || state === 'open') continue;
    // A merged plan's worktree stays: its session may still be working there. The plugin's cleanup pass removes it.
    await runtime.ledger.update(item.id, current => ({ ...current, publication: { ...current.publication!, state } }));
    refresh.changed.push(`${url} ${state}`);
  }
  return refresh;
}

export const CI_TRIAGE_LIMITS = { logChars: 12_000 };

const Check = z.object({ name: z.string(), bucket: z.string(), link: z.string().default('') });
type Check = z.infer<typeof Check>;

async function failingChecks(url: string) {
  const text = await run('gh', ['pr', 'checks', url, '--json', 'name,bucket,link']).then(result => result.stdout, error => (error as { stdout?: string }).stdout ?? '[]');
  return z.array(Check).parse(JSON.parse(text || '[]')).filter(check => check.bucket === 'fail');
}

/** An Actions run link names its repository; the daemon runs outside any checkout, so gh needs it as `--repo`. */
const ACTIONS_RUN_LINK = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/;

function actionsRuns(checks: readonly Check[]) {
  const runs = new Map<string, { repository: string; runId: string }>();
  for (const check of checks) {
    const [, repository, runId] = check.link.match(ACTIONS_RUN_LINK) ?? [];
    if (repository && runId) runs.set(`${repository}#${runId}`, { repository, runId });
  }
  return [...runs.values()];
}

function commandFailure(error: unknown) {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}

/** The failed steps' log, or why it could not be read, so triage never takes a gh failure for an empty log. */
async function failedLog(repository: string, runId: string) {
  const args = ['run', 'view', runId, '--repo', repository, '--log-failed'];
  return run('gh', args, { maxBuffer: 64 * 1024 * 1024 }).then(result => result.stdout, error => `logs_unavailable: ${commandFailure(error)}`);
}

async function failedLogs(checks: readonly Check[]) {
  const runs = actionsRuns(checks);
  const logs: string[] = [];
  for (const { repository, runId } of runs) {
    const text = await failedLog(repository, runId);
    logs.push(`run ${runId}:\n${text.slice(-CI_TRIAGE_LIMITS.logChars / Math.max(1, runs.length))}`);
  }
  return logs.join('\n\n');
}

export const CiTriage = z.object({
  decision: z.enum(['fix', 'flaky', 'person']),
  reason: z.string(),
});
export type CiTriage = z.infer<typeof CiTriage>;

async function readTriaged(runtime: Runtime, ownerId: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(join(runtime.stateDirectory, `ci-triage-${ownerId}.json`), 'utf8').catch(() => '{}')) as Record<string, string>;
}

function fixNotice(item: WorkItem, headSha: string, reason: string) {
  return `CI fails on your PR ${item.publication!.url} ("${item.proposal.title}") at ${headSha.slice(0, 12)}, and you decided to fix it: ${reason}. `
    + `Put your desk on the PR with onionsoup_checkout_pr item "${item.id}", fix and verify it (systematic-debugging), then propose with onionsoup_propose_changes item "${item.id}": `
    + 'host code reviews the fix and pushes it onto the same PR.';
}

type TriageOutcome = (runtime: Runtime, item: WorkItem, headSha: string, reason: string) => Promise<void>;

/** What the owner's decision leads to: a fix is its own to make on its desk; anything it cannot do goes to the person. */
const TRIAGE_OUTCOMES: Record<CiTriage['decision'], TriageOutcome> = {
  fix: async (runtime, item, headSha, reason) => {
    if (!canChange(runtime.owner(item.owner))) return TRIAGE_OUTCOMES.person(runtime, item, headSha, `owner_cannot_change: ${reason}`);
    await runtime.notebook(item.owner).journal({ kind: 'ci-triage', workItem: item.id, outcome: 'fix', note: `CI on ${item.publication!.url}: ${reason}` });
    await tellOwner(runtime, item, `ci-fix-${headSha.slice(0, 8)}`, fixNotice(item, headSha, reason));
  },
  flaky: async (runtime, item, _headSha, reason) => {
    await runtime.notebook(item.owner).journal({ kind: 'ci-triage', workItem: item.id, outcome: 'flaky', note: `CI on ${item.publication!.url}: ${reason}` });
  },
  person: async (runtime, item, _headSha, reason) => {
    await runtime.notebook(item.owner).journal({
      kind: 'attention', workItem: item.id, outcome: 'person',
      provenance: { kind: 'human-decision', code: 'ci_person', workItem: item.id },
      note: `CI on ${item.publication!.url}: ${reason}`,
    });
  },
};

/** CI failed on a published PR's head commit: the owner decides once for that commit whether to fix it, call it flaky, or ask the person. */
async function triageFailingCi(runtime: Runtime, item: WorkItem, headSha: string) {
  const triaged = await readTriaged(runtime, item.owner);
  if (triaged[item.publication!.url] === headSha) return undefined;
  const failing = await failingChecks(item.publication!.url);
  if (!failing.length) return undefined;
  const owner = runtime.owner(item.owner);
  const brief = [
    `CI failed on your published PR ${item.publication!.url} ("${item.proposal.title}") at ${headSha.slice(0, 12)}.`,
    `<failing-checks>\n${failing.map(check => `- ${check.name}: ${check.link}`).join('\n')}\n</failing-checks>`,
    `<failed-logs>\n${await failedLogs(failing)}\n</failed-logs>`,
    `<notebook>\n${await runtime.notebook(owner.id).orientation()}\n</notebook>`,
    'Decide as the owner: fix (you will fix it on your desk and push onto this PR; say what is wrong), flaky (not caused by the change; say why), or person (needs the person: secrets, infrastructure, policy).',
  ].join('\n\n');
  const decision = (await runtime.hire(owner.id, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${owner.id}: CI triage`, brief, schema: CiTriage })).value;
  await TRIAGE_OUTCOMES[decision.decision](runtime, item, headSha, decision.reason);
  triaged[item.publication!.url] = headSha;
  await writeFile(join(runtime.stateDirectory, `ci-triage-${owner.id}.json`), JSON.stringify(triaged, null, 2) + '\n');
  return decision.decision;
}

type PrMaintenance = { mode?: 'update-base'; description: string };

const PR_MAINTENANCE: Record<string, PrMaintenance> = {
  CONFLICTING: { description: 'conflicting' },
  BEHIND: { mode: 'update-base', description: 'behind its base' },
};

/** A refresh brings a mergeable but stale PR up to date: GitHub says BEHIND only when protection requires it. */
const STALE_ON_REFRESH: PrMaintenance = { mode: 'update-base', description: 'behind its base (refresh requested)' };

/** One maintain-prs pass: what it notes, the heads whose updates were given up, and whether a refresh was asked for. */
interface MaintenancePass { notes: string[]; suppressed: Set<string>; refresh: boolean }

/** `git merge-base --is-ancestor` exits 1 for "not an ancestor"; anything else is an error. */
const GIT_NOT_ANCESTOR = 1;

/** Whether the PR's head lacks the current tip of its base branch, read from the owner's checkout after a fetch. */
async function lacksBaseTip(runtime: Runtime, item: WorkItem, head: string) {
  const repository = runtime.repositoryFor(item);
  await git(repository.workspace, ['fetch', '-q', 'origin']);
  const base = `origin/${repository.domain.baseBranch}`;
  return git(repository.workspace, ['merge-base', '--is-ancestor', base, head]).then(() => false, error => {
    if ((error as { code?: unknown }).code === GIT_NOT_ANCESTOR) return true;
    throw new Error(`base_tip_unreadable: ${commandFailure(error)}`);
  });
}

async function neededMaintenance(runtime: Runtime, item: WorkItem, pass: MaintenancePass) {
  const { notes, suppressed } = pass;
  const pr = await settledPullRequest(item.publication!.url);
  if (PR_STATES[pr.state] !== 'open') return undefined;
  const triage = await triageFailingCi(runtime, item, pr.headRefOid).catch(error => {
    notes.push(`${item.publication!.url} CI triage failed: ${error instanceof Error ? error.message : error}`);
    return 'unavailable';
  });
  if (triage) {
    notes.push(`${item.publication!.url} CI failing: ${triage}`);
    return undefined;
  }
  const maintenance = PR_MAINTENANCE[pr.mergeable] ?? PR_MAINTENANCE[pr.mergeStateStatus]
    ?? (pass.refresh && await lacksBaseTip(runtime, item, pr.headRefOid) ? STALE_ON_REFRESH : undefined);
  if (!maintenance || suppressed.has(`${item.id}:${pr.headRefOid}`)) {
    notes.push(`${item.publication!.url} ${maintenance ? 'update previously cancelled or abandoned at this head' : pr.mergeStateStatus.toLowerCase()}`);
    return undefined;
  }
  return { ...maintenance, head: pr.headRefOid };
}

async function openPrUpdate(runtime: Runtime, item: WorkItem, pass: MaintenancePass) {
  const { notes } = pass;
  const maintenance = await neededMaintenance(runtime, item, pass);
  if (!maintenance) return undefined;
  if (!canChange(runtime.owner(item.owner))) {
    notes.push(`${item.publication!.url} owner_cannot_change: update retained for owner maintenance`);
    return undefined;
  }
  const update = await runtime.ledger.create(item.owner, REBASE_WORKFLOW, {
    title: `Update "${item.proposal.title}" onto the current base`,
    goal: `Bring ${item.publication!.url} up to date with the base branch without changing what it does.`,
    rationale: `The PR is ${maintenance.description}.`,
    acceptance: ['The PR applies cleanly to the current base', 'Host verification passes', 'The change is the same change the plan approved'],
    size: 'small', repository: item.proposal.repository,
  }, {
    status: 'implementing',
    rebaseOf: {
      itemId: item.id, branch: item.publication!.branch, prUrl: item.publication!.url,
      previousHead: maintenance.head, mode: maintenance.mode,
    },
  });
  notes.push(`${item.publication!.url} ${maintenance.description} → ${update.id}`);
  return update;
}

/**
 * The maintain-prs duty: record lifecycle, triage CI, and update stale or conflicting published branches. The
 * duty acts on what GitHub reports; `refresh` (asked for by the owner) also updates a mergeable PR whose head
 * lacks the base tip.
 */
export async function maintainPullRequests(runtime: Runtime, ownerId: string, options: { refresh?: boolean } = {}) {
  const refreshed = await refreshPublications(runtime, ownerId);
  const items = (await runtime.ledger.list()).filter(item => item.owner === ownerId);
  const openRebases = new Set(items.filter(item => item.rebaseOf && !isFinished(item)).map(item => item.rebaseOf!.itemId));
  const suppressed = new Set(items.filter(item => item.rebaseOf && (
    item.status === 'cancelled' || (item.status === 'rejected' && /^owner_abandoned(?::|$)/.test(item.reason ?? ''))))
    .map(item => `${item.rebaseOf!.itemId}:${item.rebaseOf!.previousHead}`));
  const notes = [...refreshed.changed, ...refreshed.unreadable.map(url => `${url} state unreadable`)];
  const pass: MaintenancePass = { notes, suppressed, refresh: options.refresh ?? false };
  const opened: WorkItem[] = [];
  for (const item of items.filter(candidate => candidate.publication?.state === 'open'
    && !candidate.repairOf && !isPaused(candidate))) {
    const hasRepair = items.some(candidate => candidate.repairOf?.itemId === item.id
      && !['failed', 'rejected', 'cancelled'].includes(candidate.status)
      && !candidate.publication);
    if (hasRepair) continue;
    if (openRebases.has(item.id)) continue;
    const update = await openPrUpdate(runtime, item, pass);
    if (update) opened.push(update);
  }
  const notebook = runtime.notebook(ownerId);
  await notebook.journal({ kind: 'maintain-prs', note: notes.join('; ') || 'no published PRs need updating' });
  await notebook.commit('journal maintain-prs');
  return { summary: notes.join('; ') || 'no published PRs need updating', opened };
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
    REPOSITORY_WRITING,
    `The change being replayed: "${source.proposal.title}". Its approved plan: ${source.plan?.summary ?? source.proposal.goal}`,
    `<conflicted-files>\n${files.join('\n')}\n</conflicted-files>`,
    `<original-change>\n${originalPatch}\n</original-change>`,
    `Resolve every conflict so the result is the original change applied on top of the new base: keep everything the base
added, and re-apply the original change's intent. Remove all conflict markers. Do not run the repository's test suite or its
verification commands: host code verifies the result before anything is pushed. When a conflicted file is code, a fast
check of just that file (a syntax check, or the one test file that covers it) is enough. Do not commit, do not stage (the index is read-only here) and do not
run git commands that change history; the runtime stages your resolution and continues the cherry-pick after you.
Anything you install or generate is discarded before host verification.`,
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
  const originalBase = (await git(worktree, ['merge-base', item.rebaseOf!.previousHead, `origin/${owner.domain.baseBranch}`])).trim();
  const baseChanges = (await git(worktree, ['log', '--stat', '--format=%h %s', `${originalBase}..origin/${owner.domain.baseBranch}`])).slice(0, 20_000);
  const brief = conflictBrief(source, files, originalPatch, baseChanges, await runtime.notebook(owner.id).orientation());
  return runtime.hireFor(item, 'decide', 'owner', { role: 'owner', model: owner.model, directory: owner.workspace, title: `${item.id}: owner decides conflict`, brief, schema: ConflictDecision });
}

class Abandoned extends Error {}

async function resolveConflicts(runtime: Runtime, item: WorkItem, source: WorkItem, worktree: string, files: string[]) {
  const originalPatch = (await git(worktree, ['diff', `origin/${runtime.repositoryFor(item).domain.baseBranch}...${item.rebaseOf!.previousHead}`])).slice(0, 40_000);
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
  const replayedCommits = await replayCommits(runtime, item, source, path);
  const report = replayedCommits.report;
  const diff = await diffAgainstBase(owner, path);
  await matchHead(path);
  const verification = await verify(owner, path, runtime.toolsDirectory);
  const replayed = { ...item, worktree: path, branch, implementations: [...item.implementations, { report, diffStat: diff.stat, verification }] };
  await runtime.notebook(item.owner).journal({ kind: 'rebase', workItem: item.id, outcome: replayedCommits.resolved ? 'resolved conflicts' : 'clean', note: diff.stat.split('\n').at(-1) });
  if (!verificationPassed(verification)) return transition(replayed, 'failed', 'verification_failed_after_rebase');
  return transition(replayed, replayedCommits.resolved ? 'reviewing' : 'awaiting-push-approval');
}

/** A clean base merge preserves the published head as an ancestor: it needs no destructive push approval. */
async function updateBase(runtime: Runtime, item: WorkItem): Promise<WorkItem> {
  const owner = runtime.repositoryFor(item);
  await git(owner.workspace, ['fetch', '-q', 'origin']);
  const { path, branch } = await createWorktree(owner, runtime.worktreesRoot, item.id);
  await requireKnownUpdateWorktree(item, path, `origin/${owner.domain.baseBranch}`);
  const merged = await mergePublishedHead(path, `origin/${owner.domain.baseBranch}`)
    && await mergePublishedHead(path, item.rebaseOf!.previousHead);
  if (!merged) {
    await git(path, ['merge', '--abort']);
    await runtime.notebook(item.owner).journal({
      kind: 'maintain-prs', workItem: item.id,
      note: 'base_update_conflicted: clean update requires the existing owner conflict-resolution path',
    });
    return replay(runtime, { ...item, rebaseOf: { ...item.rebaseOf!, mode: undefined } });
  }
  await matchHead(path);
  const tree = (await git(path, ['rev-parse', 'HEAD^{tree}'])).trim();
  const diff = await diffAgainstBase(owner, path);
  const verification = await verify(owner, path, runtime.toolsDirectory);
  await requireVerifiedBaseUpdate(path, tree);
  const updated = {
    ...item, worktree: path, branch,
    implementations: [...item.implementations, {
      report: { summary: 'Merged the current base without changing the approved PR goal.', filesChanged: [], deviationsFromPlan: [] },
      diffStat: diff.stat, verification, tree,
    }],
  };
  return transition(updated, verificationPassed(verification) ? 'landing' : 'failed',
    verificationPassed(verification) ? undefined : 'verification_failed_after_base_update');
}

async function requireKnownUpdateWorktree(item: WorkItem, path: string, base: string) {
  if ((await git(path, ['status', '--porcelain'])).trim()) throw new Error('base_update_worktree_not_clean');
  const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
  const baseHead = (await git(path, ['rev-parse', base])).trim();
  const tree = (await git(path, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (head !== baseHead && tree !== item.implementations.at(-1)?.tree) {
    throw new Error('base_update_workspace_needs_reverification');
  }
}

async function mergePublishedHead(path: string, head: string) {
  try {
    await git(path, ['merge', '--no-edit', head]);
    return true;
  } catch (error) {
    if ((await conflictedFiles(path)).length) return false;
    throw new Error(`base_update_merge_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requireVerifiedBaseUpdate(path: string, tree: string | undefined) {
  if (!tree) throw new Error('base_update_verification_missing');
  const current = (await git(path, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (current !== tree || (await git(path, ['status', '--porcelain'])).trim()) {
    throw new Error('base_update_source_changed_after_verification');
  }
}

const PR_UPDATE_STEPS: Record<string, Step> = { 'update-base': updateBase };

async function replayCommits(runtime: Runtime, item: WorkItem, source: WorkItem, path: string) {
  const base = runtime.repositoryFor(item).domain.baseBranch;
  const commits = (await git(path, [
    'rev-list', '--reverse', '--no-merges', '--cherry-pick', '--right-only',
    `origin/${base}...${item.rebaseOf!.previousHead}`,
  ]))
    .trim().split('\n').filter(Boolean);
  if (!commits.length) throw new Error('rebase_has_no_commits');
  let resolved = false;
  let report = { summary: 'Replayed cleanly; no conflicts.', filesChanged: [] as string[], deviationsFromPlan: [] as string[] };
  for (const commit of commits) {
    const picked = await git(path, ['cherry-pick', commit]).then(() => true, () => false);
    if (picked) continue;
    const files = await conflictedFiles(path);
    if (!files.length) throw new Error('cherry_pick_failed_without_conflicts');
    report = await resolveConflicts(runtime, item, source, path, files);
    resolved = true;
  }
  return { resolved, report };
}

function reviewResolutionBrief(source: WorkItem, originalPatch: string, rebasedPatch: string) {
  return [
    'You have been hired to review a conflict resolution. Do not edit anything.',
    `${REPOSITORY_REVIEW}\nApply this check to text changed by the resolution; do not request unrelated rewrites of the approved change.`,
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
  const originalPatch = (await git(owner.workspace, ['diff', `origin/${owner.domain.baseBranch}...${item.rebaseOf!.previousHead}`])).slice(0, 30_000);
  const rebasedPatch = (await diffAgainstBase(owner, item.worktree!)).patch.slice(0, 30_000);
  const verdict = await runtime.hireFor(item, 'review', 'review', {
    role: 'reviewer', model, directory: item.worktree!, title: `${item.id}: review resolution`,
    brief: reviewResolutionBrief(source, originalPatch, rebasedPatch), schema: Verdict,
  });
  const reviewed = { ...item, verdicts: [...item.verdicts, verdict] };
  return verdict.decision === 'approve' ? transition(reviewed, 'awaiting-push-approval') : transition(reviewed, 'failed', `resolution_not_approved: ${verdict.summary}`);
}

type PublishedPush = (item: WorkItem, head: string, remoteHead: string | undefined) => Promise<void>;

const PUBLICATION_CHECKS: Record<string, (item: WorkItem) => Promise<void>> = {
  'update-base': item => requireVerifiedBaseUpdate(item.worktree!, item.implementations.at(-1)?.tree),
};

const PUBLISHED_PUSH: Record<string, PublishedPush> = {
  'update-base': async (item, head, remoteHead) => {
    const { branch, previousHead } = item.rebaseOf!;
    if (remoteHead !== previousHead) throw new Error('published_head_changed_before_base_update');
    await git(item.worktree!, ['merge-base', '--is-ancestor', previousHead, head]);
    await git(item.worktree!, ['push', '-q', `--force-with-lease=${branch}:${previousHead}`, 'origin', `${head}:${branch}`]);
  },
  rebase: async (item, head) => {
    const { branch, previousHead } = item.rebaseOf!;
    await git(item.worktree!, ['push', '-q', `--force-with-lease=${branch}:${previousHead}`, 'origin', `${head}:${branch}`]);
  },
};

/** An ancestry-preserving update, or a human-approved rewrite, with exact published-head protection. */
async function push(runtime: Runtime, item: WorkItem): Promise<WorkItem> {
  const { branch, itemId } = item.rebaseOf!;
  const head = (await git(item.worktree!, ['rev-parse', 'HEAD'])).trim();
  await PUBLICATION_CHECKS[item.rebaseOf?.mode ?? '']?.(item);
  const remoteHead = (await git(item.worktree!, ['ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s/)[0];
  if (remoteHead !== head) {
    await PUBLISHED_PUSH[item.rebaseOf?.mode ?? 'rebase']!(item, head, remoteHead);
  }
  await runtime.ledger.update(itemId, source => ({ ...source, landedCommit: head }));
  await runtime.notebook(item.owner).journal({ kind: 'rebase-pushed', workItem: item.id, outcome: head.slice(0, 8), note: item.rebaseOf!.prUrl });
  return { ...transition(item, 'landed'), landedCommit: head };
}

type Step = (runtime: Runtime, item: WorkItem) => Promise<WorkItem>;

const REBASE_STEPS: Partial<Record<WorkStatus, Step>> = {
  implementing: (runtime, item) => (PR_UPDATE_STEPS[item.rebaseOf?.mode ?? ''] ?? replay)(runtime, item),
  reviewing: reviewResolution,
  landing: push,
};

export async function advanceRebase(runtime: Runtime, itemId: string, onProgress: (item: WorkItem) => void) {
  let item = await runtime.ledger.get(itemId);
  let step = REBASE_STEPS[item.status];
  while (step) {
    const expectedStatus = item.status;
    const current = await runtime.ledger.update(item.id, latest => {
      if (latest.status !== expectedStatus || latest.activeRunner) throw new Error('work_item_changed');
      return { ...latest, resumeStatus: latest.status, activeRunner: process.pid, runnerClaim: randomUUID() };
    });
    try {
      item = await step(runtime, current);
    } catch (error) {
      const status = error instanceof Abandoned ? 'rejected' : 'failed';
      item = transition(current, status, error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
    const completed = item;
    item = await runtime.ledger.update(item.id, latest =>
      stoppedRunnerPause(latest, completed, current));
    if (isPaused(item)) item = await settleItemPause(runtime, item.id);
    onProgress(item);
    step = REBASE_STEPS[item.status];
  }
  await runtime.notebook(item.owner).commit(`journal ${item.id}`);
  return item;
}

/** The destructive-action gate for rebases. Only records the decision; the runtime pushes. */
export async function approvePush(runtime: Runtime, itemId: string, by: string) {
  const approved = await runtime.ledger.update(itemId, item => {
    if (item.status !== 'awaiting-push-approval' || item.activeRunner) throw new Error(`not_awaiting_push_approval: ${item.status}`);
    return {
      ...transition(item, 'landing'),
      humanNotes: [...item.humanNotes, { kind: 'approval' as const, by, at: new Date().toISOString(), note: 'force-push approved' }],
    };
  });
  await runtime.notebook(approved.owner).journal({ kind: 'push-approved', workItem: itemId, note: by });
  return approved;
}
