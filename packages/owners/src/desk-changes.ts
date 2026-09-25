import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Verification, WorkItem } from './ledger.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { effectiveDecision, Verdict } from './artifacts.ts';
import { requestPublish } from './brokering.ts';
import { findingsSection, findingsText, previousReviewText } from './briefs.ts';
import { clearDeskReviews, deskReviewRounds, recordDeskReview, reviewSubject, type DeskReviewRound } from './desk-reviews.ts';
import { removePlanWorktree } from './plan-worktrees.ts';
import { requireFreelancer, type RepositoryOwner } from './declarations.ts';
import { pickModel } from './families.ts';
import type { Runtime } from './runtime.ts';
import { REPOSITORY_REVIEW } from './repository-writing.ts';
import { changesSince, ensureDesk, git, snapshotTree, verificationPassed, verify } from './workspace.ts';

const run = promisify(execFile);

/**
 * `failedOutputChars`: how much of each failing verification command's output the owner sees. The sandbox already
 * keeps the tail of each command; 600 characters cut pytest failures before their cause, so owners guessed.
 */
export const DESK_CHANGE_LIMITS = { diffChars: 60_000, reviewRoundsBeforePerson: 4, failedOutputChars: 6_000 };

/**
 * An owner's desk work becomes a reviewed change: host code verifies the desk in the sandbox, hires a reviewer
 * from another model family to check the diff, and only if it is approved commits, pushes a branch and opens a
 * PR. An owner holding a merge grant from the person merges its own approved PR, and a site built from the
 * repository is then published through its host's grant.
 */
export interface DeskChangeResult { outcome: 'merged' | 'opened' | 'needs-work' | 'needs-person' | 'publication-failed' | 'in-progress' | 'nothing-to-do'; summary: string; url?: string; publishRequest?: string }

function hasMergeGrant(owner: RepositoryOwner) {
  return owner.grants.some(grant => grant.to === owner.id && grant.action === 'merge' && (grant.target === owner.domain.name || grant.target === '*'));
}

function reviewBrief(owner: RepositoryOwner, title: string, summary: string, base: string, patch: string, previousReview?: string) {
  return [
    `You have been hired to review a change ${owner.persona?.name ?? owner.id} made in ${owner.domain.name}. Do not edit anything.`,
    REPOSITORY_REVIEW,
    `<title>${title}</title>`,
    `<what-the-owner-says-it-does>\n${summary}\n</what-the-owner-says-it-does>`,
    `<diff against="${base}">\n${patch}\n</diff>`,
    previousReview,
    `Approve only if the diff does what the owner says and nothing else, is correct, and keeps to the repository's
conventions. Revise, with specific findings, otherwise. Replan is not available here; use revise. Only blocker
findings send the change back to the owner; the others are listed in the PR for the person who merges it.`,
  ].filter(Boolean).join('\n\n');
}

/** The latest round's findings and what changed since, so this round checks them instead of starting over. */
async function previousReviewSection(deskPath: string, rounds: readonly DeskReviewRound[], currentTree: string) {
  const previous = rounds.at(-1);
  if (!previous) return undefined;
  const changes = (await changesSince(deskPath, previous.tree, currentTree))?.slice(0, DESK_CHANGE_LIMITS.diffChars);
  return previousReviewText({ round: rounds.length, reviewer: previous.reviewer, verdict: previous, changesSince: changes });
}

/** Where a proposal's review rounds are kept (the desk's, or an approved plan's worktree's), and how the person clears them. */
interface ReviewScope { subject: string; resetCommand: string }

function reviewScope(owner: RepositoryOwner, target: DeskTarget): ReviewScope {
  const planItem = target.kind === 'plan' && target.item.planWorktree ? target.item.id : undefined;
  const itemOption = planItem ? ` --item ${planItem}` : '';
  return {
    subject: reviewSubject(owner.domain.name, planItem),
    resetCommand: `npm run owners -- desk-review-reset ${owner.id} ${owner.domain.name}${itemOption}`,
  };
}

/** After too many rounds the person reads the diff; no reviewer is hired until they clear the history. */
function waitingForPerson(scope: ReviewScope, rounds: readonly DeskReviewRound[]): DeskChangeResult | undefined {
  if (rounds.length < DESK_CHANGE_LIMITS.reviewRoundsBeforePerson) return undefined;
  return {
    outcome: 'needs-person',
    summary: `${rounds.length} review rounds asked for changes; nothing was committed and no reviewer was hired. Bring the person in: they read the diff and tell you what to change, or clear the review history with \`${scope.resetCommand}\`.`,
  };
}

async function recordNeedsWork(runtime: Runtime, owner: RepositoryOwner, scope: ReviewScope, title: string, round: DeskReviewRound) {
  const notebook = runtime.notebook(owner.id);
  await notebook.journal({ kind: 'desk-change-reviewed', outcome: round.decision, note: `${title}: ${round.summary}` });
  const rounds = await recordDeskReview(runtime, owner.id, scope.subject, round);
  if (rounds.length !== DESK_CHANGE_LIMITS.reviewRoundsBeforePerson) return;
  await notebook.journal({ kind: 'attention', note: `desk change "${title}" in ${owner.domain.name}: ${rounds.length} review rounds asked for changes; the person reads the diff and decides` });
}

async function needsWork(runtime: Runtime, owner: RepositoryOwner, scope: ReviewScope, title: string, review: DeskReview): Promise<DeskChangeResult> {
  await recordNeedsWork(runtime, owner, scope, title, { at: new Date().toISOString(), reviewer: review.reviewer, ...review.verdict, tree: review.tree });
  return { outcome: 'needs-work', summary: `${review.reviewer} asked for changes; nothing was committed.\n${review.verdict.summary}\n${findingsText(review.verdict.findings)}` };
}

/** What an owner proposes from its desk; `item` names the approved plan the changes carry out, or the open PR they repair. */
export interface DeskProposal {
  title: string;
  summary: string;
  repository?: string;
  origin?: WorkItem['origin'];
  item?: string;
}

/**
 * Where reviewed desk changes go: a new PR, the approved plan item they carry out, or an open PR they repair. A repair
 * is reviewed against the PR's head (the desk was put there with checkoutPullRequest) and pushed onto that PR. `path`
 * is the worktree the changes are in: the plan's own worktree for a plan that has one, else the owner's desk.
 */
type DeskTarget = { kind: 'new'; path: string } | { kind: 'plan'; item: WorkItem; path: string } | { kind: 'repair'; item: WorkItem; head: string; path: string };

function isRepair(item: WorkItem) {
  return item.publication?.state === 'open';
}

/** Where a proposal's changes are: an approved plan's own worktree, else the desk (direct changes, repairs, older plans). */
async function proposalDirectory(runtime: Runtime, owner: RepositoryOwner, item: WorkItem | undefined) {
  const planWorktree = item && !isRepair(item) ? item.planWorktree : undefined;
  if (!planWorktree) return (await ensureDesk(owner, runtime.desksRoot)).path;
  if (!existsSync(planWorktree)) throw new Error(`plan_worktree_missing: ${planWorktree} is gone; ask the person to cancel ${item!.id} or restore it`);
  return planWorktree;
}

function requireWorking(item: WorkItem) {
  if (item.workflow !== OWNER_CHANGE_WORKFLOW) throw new Error(`not_an_owner_plan: ${item.id} is ${item.workflow} work`);
  if (item.status !== 'working') throw new Error(`plan_item_not_working: ${item.id} is ${item.status}`);
}

/** A repair starts from the PR's current head: the desk must still be exactly there, apart from its uncommitted changes. */
async function repairHead(deskPath: string, item: WorkItem) {
  await git(deskPath, ['fetch', '-q', 'origin']);
  const head = (await git(deskPath, ['rev-parse', 'HEAD'])).trim();
  const prHead = (await git(deskPath, ['rev-parse', `origin/${item.publication!.branch}`])).trim();
  if (head !== prHead) throw new Error(`desk_not_on_pr: put your desk on ${item.publication!.url} with onionsoup_checkout_pr first`);
  return head;
}

async function ownItem(runtime: Runtime, ownerId: string, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.owner !== ownerId) throw new Error(`item_not_yours: ${item.id} belongs to ${item.owner}`);
  return item;
}

async function deskTarget(path: string, item: WorkItem | undefined): Promise<DeskTarget> {
  if (!item) return { kind: 'new', path };
  if (isRepair(item)) return { kind: 'repair', item, path, head: await repairHead(path, item) };
  requireWorking(item);
  return { kind: 'plan', item, path };
}

/**
 * What the reviewer diffs against. A repair is reviewed against its PR head. Other changes are reviewed against where
 * the worktree meets the base branch, so a desk that fell behind shows only the owner's change, not the base's newer
 * commits as reversions.
 */
async function reviewBase(owner: RepositoryOwner, target: DeskTarget) {
  if (target.kind === 'repair') return target.head;
  return (await git(target.path, ['merge-base', 'HEAD', `origin/${owner.domain.baseBranch}`])).trim();
}

/** What the owner reads when host verification fails: each failing command with the end of its output. */
export function failedVerificationSummary(verification: readonly Verification[]) {
  const failed = verification.filter(result => result.exitCode !== 0)
    .map(result => `$ ${result.command} (exit ${result.exitCode})\n${result.output.slice(-DESK_CHANGE_LIMITS.failedOutputChars)}`);
  return `Verification failed in the sandbox; nothing was committed. The sandbox has a read-only home and private /tmp, so a test that writes outside the desk can pass on the desk and fail here.\n${failed.join('\n\n')}`;
}

async function verifyDesk(owner: RepositoryOwner, deskPath: string, toolsDirectory: string) {
  const verification = await verify(owner, deskPath, toolsDirectory);
  if (verificationPassed(verification)) return { verification };
  return { verification, failure: { outcome: 'needs-work' as const, summary: failedVerificationSummary(verification) } };
}

interface DeskReview { verdict: Verdict; reviewer: string; patch: string; tree: string }
interface ReviewedDesk extends DeskReview { owner: RepositoryOwner; path: string; verification: Verification[] }

/** Hire the required reviewer from another family, with the previous round when there was one. */
async function reviewDesk(runtime: Runtime, owner: RepositoryOwner, scope: ReviewScope, deskPath: string, proposal: DeskProposal, base: string): Promise<DeskReview> {
  const rounds = await deskReviewRounds(runtime, owner.id, scope.subject);
  await git(deskPath, ['add', '-A', '--intent-to-add']);
  const patch = (await git(deskPath, ['diff', base])).slice(0, DESK_CHANGE_LIMITS.diffChars);
  const tree = await snapshotTree(deskPath);
  const brief = reviewBrief(owner, proposal.title, proposal.summary, base, patch, await previousReviewSection(deskPath, rounds, tree));
  const reviewer = pickModel(runtime.declarations.families, requireFreelancer(runtime.declarations, 'review').models, [runtime.family(owner.model)]);
  const hired = await runtime.hire(owner.id, { role: 'reviewer', model: reviewer.model, directory: deskPath, title: `${owner.id}: review desk change`, brief, schema: Verdict });
  return { verdict: hired.value, reviewer: reviewer.model, patch, tree };
}

function publicationFields(desk: ReviewedDesk, proposal: DeskProposal, reviewedHead: string, reviewedTree: string): Partial<WorkItem> {
  const report = { summary: proposal.summary, filesChanged: [], deviationsFromPlan: [] };
  return {
    status: 'landing', worktree: desk.path,
    implementations: [{ report, diffStat: desk.patch, verification: desk.verification }],
    verdicts: [desk.verdict],
    deskPublication: { stage: 'commit', reviewer: desk.reviewer, reviewedHead, reviewedTree },
  };
}

function newPublication(runtime: Runtime, desk: ReviewedDesk, proposal: DeskProposal, fields: Partial<WorkItem>) {
  return runtime.ledger.create(desk.owner.id, DESK_WORKFLOW, {
    title: proposal.title, goal: proposal.summary, rationale: 'Reviewed changes from the owner desk',
    acceptance: ['Host verification and cross-family review pass'], size: 'small', repository: proposal.repository,
  }, { ...fields, origin: proposal.origin });
}

type PublicationItem = (runtime: Runtime, desk: ReviewedDesk, proposal: DeskProposal, fields: Partial<WorkItem>, target: DeskTarget) => Promise<WorkItem>;

/** The ledger item that publishes reviewed desk changes, by where they go. */
const PUBLICATION_ITEMS: Record<DeskTarget['kind'], PublicationItem> = {
  new: newPublication,
  plan: (runtime, _desk, proposal, fields) => runtime.ledger.update(proposal.item!, current => ({
    ...current, ...fields, proposal: { ...current.proposal, title: proposal.title, goal: proposal.summary },
  })),
  repair: (runtime, desk, proposal, fields, target) => {
    const { item, head } = target as Extract<DeskTarget, { kind: 'repair' }>;
    const repairOf = { itemId: item.id, branch: item.publication!.branch, prUrl: item.publication!.url, previousHead: head };
    return newPublication(runtime, desk, proposal, { ...fields, repairOf, origin: item.session ?? item.origin ?? proposal.origin });
  },
};

async function publicationItem(runtime: Runtime, desk: ReviewedDesk, proposal: DeskProposal, target: DeskTarget) {
  const reviewedHead = (await git(desk.path, ['rev-parse', 'HEAD'])).trim();
  const reviewedTree = (await git(desk.path, ['write-tree'])).trim();
  const fields = publicationFields(desk, proposal, reviewedHead, reviewedTree);
  return PUBLICATION_ITEMS[target.kind](runtime, desk, proposal, fields, target);
}

async function prepareDeskChanges(runtime: Runtime, owner: RepositoryOwner, proposal: DeskProposal, target: DeskTarget): Promise<DeskChangeResult> {
  if (!(await git(target.path, ['status', '--porcelain'])).trim()) return { outcome: 'nothing-to-do', summary: `${target.path} has no changes.` };
  await git(target.path, ['fetch', '-q', 'origin']);
  const { verification, failure } = await verifyDesk(owner, target.path, runtime.toolsDirectory);
  if (failure) return failure;
  const scope = reviewScope(owner, target);
  const waiting = waitingForPerson(scope, await deskReviewRounds(runtime, owner.id, scope.subject));
  if (waiting) return waiting;
  const review = await reviewDesk(runtime, owner, scope, target.path, proposal, await reviewBase(owner, target));
  if (effectiveDecision(review.verdict) !== 'approve') return needsWork(runtime, owner, scope, proposal.title, review);
  await clearDeskReviews(runtime, owner.id, scope.subject);
  await git(target.path, ['add', '-A']);
  const published = await publicationItem(runtime, { owner, path: target.path, verification, ...review }, proposal, target);
  return continueDeskPublication(runtime, published.id);
}

/** Put the owner's desk on the head of one of its open PRs, so it can repair it and propose the fix with that item. */
export async function checkoutPullRequest(runtime: Runtime, ownerId: string, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.owner !== ownerId) throw new Error(`item_not_yours: ${item.id} belongs to ${item.owner}`);
  if (item.publication?.state !== 'open') throw new Error(`no_open_pr: ${item.id} has no open PR`);
  const owner = runtime.repositoryFor(item);
  const desk = await ensureDesk(owner, runtime.desksRoot, `origin/${item.publication.branch}`);
  return { path: desk.path, head: (await git(desk.path, ['rev-parse', 'HEAD'])).trim(), pullRequest: item.publication.url };
}

/** The person has read the diff: the next proposal is reviewed afresh, with no earlier rounds and a new budget. */
export async function resetDeskReviews(runtime: Runtime, ownerId: string, repository: string | undefined, by: string, planItem?: string) {
  const owner = runtime.repositoryOwner(ownerId, repository);
  const subject = reviewSubject(owner.domain.name, planItem);
  const rounds = await deskReviewRounds(runtime, owner.id, subject);
  await clearDeskReviews(runtime, owner.id, subject);
  const notebook = runtime.notebook(owner.id);
  await notebook.journal({ kind: 'desk-review-reset', workItem: planItem, note: `${subject}: ${rounds.length} review rounds cleared by ${by}` });
  await notebook.commit('journal desk-review-reset').catch(() => undefined);
  return rounds.length;
}

export const DESK_WORKFLOW = 'desk-publication';

/** The repository a proposal is in: the one named, or the plan item's. */
async function withRepository(runtime: Runtime, proposal: DeskProposal): Promise<DeskProposal> {
  if (proposal.repository || !proposal.item) return proposal;
  return { ...proposal, repository: (await runtime.ledger.get(proposal.item)).proposal.repository };
}

function isUnfinishedPublication(item: WorkItem) {
  return Boolean(item.deskPublication && item.deskPublication.stage !== 'complete' && item.status !== 'cancelled');
}

/**
 * The publication a proposal continues instead of starting another: the named item's own, or one of the same
 * worktree's. Each plan's worktree publishes on its own, so one plan's stuck publication never holds up another's.
 */
async function pendingPublication(runtime: Runtime, ownerId: string, item: WorkItem | undefined, directory: string) {
  return (await runtime.ledger.list()).find(candidate => candidate.owner === ownerId && isUnfinishedPublication(candidate)
    && (candidate.id === item?.id || candidate.worktree === directory));
}

export async function proposeDeskChanges(runtime: Runtime, ownerId: string, proposed: DeskProposal) {
  const proposal = await withRepository(runtime, proposed);
  const item = proposal.item ? await ownItem(runtime, ownerId, proposal.item) : undefined;
  const owner = runtime.repositoryOwner(ownerId, proposal.repository);
  const directory = await proposalDirectory(runtime, owner, item);
  const pending = await pendingPublication(runtime, ownerId, item, directory);
  if (pending) return continueDeskPublication(runtime, pending.id);
  return prepareDeskChanges(runtime, owner, proposal, await deskTarget(directory, item));
}

async function continueDeskPublication(runtime: Runtime, itemId: string) {
  try {
    return deskResult(await advanceDeskPublication(runtime, itemId));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'work_item_active') throw error;
    return deskResult(await runtime.ledger.get(itemId));
  }
}

const PERMANENT_FAILURES = new Set(['desk_changed_since_review', 'desk_head_changed', 'desk_pr_closed']);

function deskResult(item: WorkItem): DeskChangeResult {
  if (item.activeRunner) return { outcome: 'in-progress', summary: `Publication ${item.id} is running at ${item.deskPublication!.stage}.` };
  if (item.status === 'failed') return deskFailure(item);
  const outcome = item.publication?.state === 'merged' ? 'merged' : 'opened';
  const warning = item.reason ? `; ${item.reason}` : '';
  return {
    outcome, summary: `${outcome} ${item.publication?.url}${warning}`, url: item.publication?.url,
    publishRequest: item.deskPublication?.publishRequest,
  };
}

function deskFailure(item: WorkItem): DeskChangeResult {
  const permanent = PERMANENT_FAILURES.has(item.reason ?? '');
  const next = permanent
    ? `Cancel ${item.id} before proposing the revised desk changes.`
    : `Retry propose changes to continue ${item.id}, or cancel it.`;
  const commit = item.landedCommit ? `Commit ${item.landedCommit} is retained.` : 'No publication commit was recorded.';
  return {
    outcome: 'publication-failed',
    summary: `Publication stopped at ${item.deskPublication!.stage}: ${item.reason}. ${commit} ${next}`,
    url: item.publication?.url,
  };
}

type DeskStage = NonNullable<WorkItem['deskPublication']>['stage'];
type DeskStep = (runtime: Runtime, item: WorkItem) => Promise<Partial<WorkItem>>;

function checkpoint(item: WorkItem, stage: DeskStage) {
  return { ...item.deskPublication!, stage };
}

const commitDesk: DeskStep = async (_runtime, item) => {
  const desk = item.worktree!;
  const head = (await git(desk, ['rev-parse', 'HEAD'])).trim();
  if (head === item.deskPublication!.reviewedHead) {
    await git(desk, ['add', '-A']);
    const tree = (await git(desk, ['write-tree'])).trim();
    if (tree !== item.deskPublication!.reviewedTree) throw new Error('desk_changed_since_review');
    await git(desk, ['commit', '-q', '-m', `${item.proposal.title}\n\n${item.proposal.goal}\n\nWork-item: ${item.id}\nReviewed-by: ${item.deskPublication!.reviewer}`]);
  } else {
    const message = await git(desk, ['log', '-1', '--format=%B']);
    if (!message.split('\n').includes(`Work-item: ${item.id}`)) throw new Error('desk_head_changed');
  }
  const branch = item.repairOf?.branch ?? `owners/${item.id}`;
  return { landedCommit: (await git(desk, ['rev-parse', 'HEAD'])).trim(), branch, deskPublication: checkpoint(item, 'push') };
};

const pushNewBranch: DeskStep = async (runtime, item) => {
  await git(runtime.repositoryFor(item).workspace, ['push', '-q', 'origin', `${item.landedCommit}:refs/heads/${item.branch}`]);
  return { deskPublication: checkpoint(item, 'open') };
};

const RemoteHead = z.object({ state: z.string(), headRefOid: z.string() });

/** A repair goes onto the PR it repairs, and only over the head it was reviewed against; a moved head is refused. */
const pushRepair: DeskStep = async (runtime, item) => {
  const target = item.repairOf!;
  const workspace = runtime.repositoryFor(item).workspace;
  const { stdout } = await run('gh', ['pr', 'view', target.prUrl, '--json', 'state,headRefOid']);
  const remote = RemoteHead.parse(JSON.parse(stdout));
  if (remote.state !== 'OPEN') throw new Error('repair_pr_not_open');
  const wasPushed = remote.headRefOid === item.landedCommit;
  if (!wasPushed && remote.headRefOid !== target.previousHead) throw new Error('repair_head_changed');
  if (!wasPushed) {
    await git(workspace, ['merge-base', '--is-ancestor', target.previousHead, item.landedCommit!]);
    await git(workspace, ['push', '-q', `--force-with-lease=${target.branch}:${target.previousHead}`, 'origin', `${item.landedCommit}:refs/heads/${target.branch}`]);
  }
  await runtime.ledger.update(target.itemId, source => ({ ...source, landedCommit: item.landedCommit }));
  const publication = { url: target.prUrl, branch: target.branch, by: item.owner, at: new Date().toISOString(), state: 'open' as const };
  return { publication, deskPublication: checkpoint(item, 'complete') };
};

const pushDesk: DeskStep = (runtime, item) => (item.repairOf ? pushRepair : pushNewBranch)(runtime, item);

const PullRequest = z.object({ url: z.string(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']) });

async function openDeskPr(runtime: Runtime, item: WorkItem) {
  const owner = runtime.repositoryFor(item);
  const listed = await run('gh', ['pr', 'list', '--repo', owner.domain.name, '--head', item.branch!, '--state', 'all', '--json', 'url,state']);
  const existing = z.array(PullRequest).parse(JSON.parse(listed.stdout))[0];
  if (existing) return existing;
  const created = await run('gh', ['pr', 'create', '--repo', owner.domain.name, '--base', owner.domain.baseBranch,
    '--head', item.branch!, '--title', item.proposal.title,
    '--body', deskPrBody(item)]);
  return PullRequest.parse({ url: created.stdout.trim().split('\n').at(-1), state: 'OPEN' });
}

/** The approved plan behind a desk change, folded so the PR leads with what changed. */
function planSection(item: WorkItem) {
  if (!item.planDocument) return undefined;
  const approval = item.planApproval ? `Plan approved by ${item.planApproval.by}.` : '';
  return `<details><summary>Approved plan</summary>\n\n${item.planDocument.markdown}\n\n</details>\n\n${approval}`.trim();
}

function deskPrBody(item: WorkItem) {
  const review = `Reviewed by ${item.deskPublication!.reviewer}.`;
  return [item.proposal.goal, review, findingsSection(item.verdicts), planSection(item), `Work item: ${item.id}`].filter(Boolean).join('\n\n');
}

const openDesk: DeskStep = async (runtime, item) => {
  const opened = await openDeskPr(runtime, item);
  const states = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;
  const shouldMerge = hasMergeGrant(runtime.repositoryFor(item));
  return {
    publication: { url: opened.url, branch: item.branch!, by: item.owner, at: new Date().toISOString(), state: states[opened.state] },
    deskPublication: checkpoint(item, shouldMerge ? 'merge' : 'complete'),
  };
};

const mergeDesk: DeskStep = async (runtime, item) => {
  const owner = runtime.repositoryFor(item);
  if (!hasMergeGrant(owner)) return { deskPublication: checkpoint(item, 'complete') };
  const viewed = await run('gh', ['pr', 'view', item.publication!.url, '--json', 'url,state']);
  const current = PullRequest.parse(JSON.parse(viewed.stdout));
  if (current.state === 'CLOSED') throw new Error('desk_pr_closed');
  if (current.state === 'OPEN') {
    await runtime.notebook(item.owner).journal({ kind: 'grant-used', workItem: item.id, note: 'merge approved by standing grant' });
    await run('gh', ['pr', 'merge', current.url, '--squash', '--delete-branch']);
  }
  return { publication: { ...item.publication!, state: 'merged' }, deskPublication: checkpoint(item, 'finish') };
};

/** A merged desk change leaves the desk at the base again, unless new work started on it since. */
async function resetMergedDesk(runtime: Runtime, item: WorkItem) {
  const owner = runtime.repositoryFor(item);
  await git(item.worktree!, ['fetch', '-q', 'origin']);
  const head = (await git(item.worktree!, ['rev-parse', 'HEAD'])).trim();
  const isClean = !(await git(item.worktree!, ['status', '--porcelain'])).trim();
  if (head === item.landedCommit && isClean) await git(item.worktree!, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
}

const finishDesk: DeskStep = async (runtime, item) => {
  await (item.planWorktree ? removePlanWorktree : resetMergedDesk)(runtime, item);
  const site = [...runtime.declarations.owners.values()]
    .flatMap(candidate => candidate.domain.kind === 'truenas' ? candidate.domain.sites : [])
    .find(candidate => candidate.source === item.owner);
  const purpose = `Publish merged desk work ${item.id}: ${item.proposal.title}`;
  const existing = (await runtime.requests.list()).find(request => request.from === item.owner && request.ask.purpose === purpose);
  const publish = site ? existing ?? await requestPublish(runtime, item.owner, site.id, purpose) : undefined;
  return { deskPublication: { ...checkpoint(item, 'complete'), publishRequest: publish?.id } };
};

const DESK_STEPS: Partial<Record<DeskStage, DeskStep>> = {
  commit: commitDesk, push: pushDesk, open: openDesk, merge: mergeDesk, finish: finishDesk,
};

export async function advanceDeskPublication(runtime: Runtime, itemId: string) {
  let item = await runtime.ledger.update(itemId, current => {
    if (current.activeRunner) throw new Error('work_item_active');
    if (current.status === 'cancelled') throw new Error('work_item_cancelled');
    return { ...current, status: 'landing', resumeStatus: 'landing', activeRunner: process.pid, reason: undefined };
  });
  try {
    let step = DESK_STEPS[item.deskPublication!.stage];
    while (step) {
      const changes = await step(runtime, item);
      item = await runtime.ledger.update(item.id, current => ({ ...current, ...changes }));
      step = DESK_STEPS[item.deskPublication!.stage];
    }
    item = await runtime.ledger.update(item.id, current => ({ ...current, status: 'landed', activeRunner: undefined }));
  } catch (error) {
    item = await runtime.ledger.update(item.id, current => ({
      ...current, status: 'failed', activeRunner: undefined, reason: error instanceof Error ? error.message : String(error),
    }));
  }
  if (item.status === 'landed') item = await recordDeskPublication(runtime, item);
  return item;
}

async function recordDeskPublication(runtime: Runtime, item: WorkItem) {
  const notebook = runtime.notebook(item.owner);
  try {
    await notebook.journal({ kind: 'desk-change-published', workItem: item.id, outcome: item.publication?.url });
    await notebook.commit('journal desk change');
    return item;
  } catch (error) {
    const reason = `desk_publication_journal_failed: ${error instanceof Error ? error.message : String(error)}`;
    return runtime.ledger.update(item.id, current => ({ ...current, reason }));
  }
}
