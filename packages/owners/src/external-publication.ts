import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { canChange } from './declarations.ts';
import { reviewExternalPublication } from './desk-changes.ts';
import { ExternalPrObservation, type WorkItem } from './ledger.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import type { Runtime } from './runtime.ts';
import { readRequestWorkEvidence } from './request-work-evidence.ts';
import { git, snapshotTree } from './workspace.ts';

const run = promisify(execFile);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const PullRequestRef = z.object({ ref: z.string(), sha: Commit, repo: z.object({ full_name: z.string() }) });
const ExternalPullRequest = z.object({
  html_url: z.string().url(), state: z.enum(['open', 'closed']), merged: z.boolean(),
  draft: z.boolean(), auto_merge: z.unknown().nullable(), head: PullRequestRef, base: PullRequestRef,
  merge_commit_sha: Commit.nullable(), merged_at: z.string().datetime().nullable().optional(),
});
type ExternalPullRequest = z.infer<typeof ExternalPullRequest>;

function pullNumber(url: string, repository: string) {
  const parsed = new URL(url);
  const prefix = `/${repository}/pull/`;
  const number = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : '';
  if (parsed.origin !== 'https://github.com' || parsed.search || parsed.hash || !/^[1-9][0-9]*$/.test(number)) {
    throw new Error('external_pr_repository_mismatch');
  }
  return number;
}

async function readPullRequest(repository: string, number: string) {
  const { stdout } = await run('gh', ['api', `repos/${repository}/pulls/${number}`]);
  return ExternalPullRequest.parse(JSON.parse(stdout));
}

function validateRemote(remote: ExternalPullRequest, repository: string, baseBranch: string, url: string) {
  if (remote.html_url !== url || remote.base.repo.full_name !== repository || remote.head.repo.full_name !== repository
    || remote.base.ref !== baseBranch) throw new Error('external_pr_repository_mismatch');
  if (!remote.merged && remote.state !== 'open') throw new Error('external_pr_closed');
  if (!remote.merged && (!remote.draft || remote.auto_merge !== null)) throw new Error('external_pr_requires_draft_without_auto_merge');
  if (remote.merged && remote.state !== 'closed') throw new Error('external_pr_inconsistent_state');
  if (remote.merged && !remote.merge_commit_sha) throw new Error('external_pr_merge_commit_missing');
}

function requireApprovedWork(item: WorkItem, ownerId: string) {
  if (item.owner !== ownerId) throw new Error('item_not_yours');
  if (item.workflow !== OWNER_CHANGE_WORKFLOW || !item.planApproval || !item.planDocument || !item.request) {
    throw new Error('external_pr_requires_approved_request');
  }
  if (item.activeRunner) throw new Error('work_item_active');
  if (item.status !== 'working' || item.publication || item.deskPublication) throw new Error('external_pr_item_not_working');
  if (!item.planWorktree) throw new Error('external_pr_plan_worktree_missing');
}

async function requireRequest(runtime: Runtime, item: WorkItem) {
  const request = await runtime.requests.get(item.request!);
  if (request.to !== item.owner || request.workItem !== item.id || request.ask.kind !== 'work'
    || request.status !== 'work-running') throw new Error('external_pr_request_mismatch');
  const requestedOwner = runtime.repositoryOwner(item.owner, request.ask.proposal.repository);
  if (requestedOwner.domain.name !== runtime.repositoryFor(item).domain.name) throw new Error('external_pr_request_repository_mismatch');
  return request;
}

async function requireSource(directory: string, head: string, tree?: string) {
  if ((await git(directory, ['status', '--porcelain'])).trim()) throw new Error('external_pr_worktree_dirty');
  if ((await git(directory, ['rev-parse', 'HEAD'])).trim() !== head) throw new Error('external_pr_head_mismatch');
  if (tree && await snapshotTree(directory) !== tree) throw new Error('review_evidence_stale');
}

async function reviewBase(directory: string, remote: ExternalPullRequest) {
  const anchor = remote.merged ? `${remote.merge_commit_sha}^1` : remote.base.sha;
  return (await git(directory, ['merge-base', remote.head.sha, anchor])).trim();
}

async function requireConfiguredBase(runtime: Runtime, item: WorkItem, directory: string, remote: ExternalPullRequest) {
  const owner = runtime.repositoryFor(item);
  if ((await git(directory, ['remote', 'get-url', 'origin'])).trim() !== owner.domain.remote) {
    throw new Error('external_pr_remote_mismatch');
  }
  await git(directory, ['fetch', '--no-tags', 'origin', owner.domain.baseBranch]);
  if (!remote.merged) return;
  try {
    await git(directory, ['merge-base', '--is-ancestor', remote.merge_commit_sha!, `origin/${owner.domain.baseBranch}`]);
  } catch (cause) {
    throw new Error('external_pr_merge_not_in_base', { cause });
  }
}

function reviewedImplementation(review: Awaited<ReturnType<typeof reviewExternalPublication>>) {
  return {
    report: {
      summary: 'Externally published PR verified and reconciled; deployment not assessed',
      filesChanged: [], deviationsFromPlan: [],
    },
    diffStat: review.patch, verification: review.verification, tree: review.tree,
  };
}

async function recordPublication(runtime: Runtime, item: WorkItem, remote: ExternalPullRequest, by: string) {
  const directory = item.planWorktree!;
  await requireSource(directory, remote.head.sha);
  const base = await reviewBase(directory, remote);
  if (base === remote.head.sha) throw new Error('external_pr_empty_review_diff');
  const review = await reviewExternalPublication(runtime, item, directory, base);
  await requireSource(directory, remote.head.sha, review.tree);
  const owner = runtime.repositoryFor(item);
  const latest = await readPullRequest(owner.domain.name, pullNumber(remote.html_url, owner.domain.name));
  validateRemote(latest, owner.domain.name, owner.domain.baseBranch, remote.html_url);
  if (JSON.stringify(latest) !== JSON.stringify(remote)) throw new Error('external_pr_changed_during_review');
  await requireRequest(runtime, item);
  const observedAt = new Date().toISOString();
  return runtime.ledger.update(item.id, current => {
    if (current.activeRunner !== process.pid || current.status !== 'working'
      || JSON.stringify(current.planApproval) !== JSON.stringify(item.planApproval)
      || JSON.stringify(current.proposal) !== JSON.stringify(item.proposal)
      || JSON.stringify(current.planDocument) !== JSON.stringify(item.planDocument)) throw new Error('external_pr_item_changed');
    return { ...current, status: 'landed', activeRunner: undefined, reason: undefined,
      branch: remote.head.ref, landedCommit: remote.head.sha,
      publication: { url: remote.html_url, branch: remote.head.ref, by, at: observedAt, state: remote.merged ? 'merged' : 'open' },
      externalPublication: {
        by, observedAt, head: remote.head.sha, base, mergeCommit: remote.merge_commit_sha ?? undefined,
        reviewer: review.reviewer, evidence: review.evidence,
      },
      implementations: [...current.implementations, reviewedImplementation(review)],
      verdicts: [...current.verdicts, review.verdict],
    };
  });
}

/** Human CLI recovery only: observes a PR, freshly verifies/reviews its exact source, and records its actual lifecycle. */
export async function reconcileExternalPublication(runtime: Runtime, ownerId: string, itemId: string, url: string, by: string) {
  const initial = await runtime.ledger.get(itemId);
  if (initial.owner !== ownerId) throw new Error('item_not_yours');
  const owner = runtime.repositoryFor(initial);
  if (!canChange(owner)) throw new Error('owner_cannot_change');
  const remote = await readPullRequest(owner.domain.name, pullNumber(url, owner.domain.name));
  validateRemote(remote, owner.domain.name, owner.domain.baseBranch, url);
  if (initial.externalPublication && initial.publication?.url === url) {
    if (initial.externalPublication.head !== remote.head.sha) throw new Error('external_pr_head_changed');
    if (!remote.merged || initial.publication.state === 'merged') return initial;
    await requireConfiguredBase(runtime, initial, owner.workspace, remote);
    return runtime.ledger.update(itemId, current => {
      if (current.activeRunner || current.status !== 'landed' || current.publication?.url !== url
        || current.externalPublication?.head !== remote.head.sha) throw new Error('external_pr_item_changed');
      return { ...current,
        publication: { ...current.publication, state: 'merged' },
        externalPublication: { ...current.externalPublication, mergeCommit: remote.merge_commit_sha! },
      };
    });
  }
  requireApprovedWork(initial, ownerId);
  await requireRequest(runtime, initial);
  await requireConfiguredBase(runtime, initial, initial.planWorktree!, remote);
  const claimed = await runtime.ledger.update(itemId, current => {
    requireApprovedWork(current, ownerId);
    return { ...current, activeRunner: process.pid };
  });
  try {
    return await recordPublication(runtime, claimed, remote, by);
  } finally {
    await runtime.ledger.update(itemId, current => current.activeRunner === process.pid ? { ...current, activeRunner: undefined } : current);
  }
}


async function observationEvidence(runtime: Runtime, item: WorkItem, tree: string) {
  const evidence = await readRequestWorkEvidence(runtime, item).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (evidence && (evidence.planDigest !== item.planDocument!.digest || evidence.verification?.tree !== tree)) {
    throw new Error('external_pr_follow_up_evidence_mismatch');
  }
  return evidence;
}

function sameObservedMerge(observation: ExternalPrObservation, remote: ExternalPullRequest) {
  return observation.url === remote.html_url && observation.head === remote.head.sha
    && observation.mergeCommit === remote.merge_commit_sha && observation.mergedAt === remote.merged_at;
}

function observationSubject(item: WorkItem) {
  const { updatedAt: _updatedAt, externalPrObservations: _observations, ...subject } = item;
  return JSON.stringify(subject);
}

async function commitObservation(runtime: Runtime, initial: WorkItem, observation: ExternalPrObservation,
  request: Awaited<ReturnType<typeof requireRequest>>) {
  return runtime.requests.inspectLocked(request.id, async currentRequest => {
    if (JSON.stringify(currentRequest) !== JSON.stringify(request)) throw new Error('external_pr_request_changed');
    return runtime.ledger.update(initial.id, current => {
      requireApprovedWork(current, initial.owner);
      if (observationSubject(current) !== observationSubject(initial)) throw new Error('external_pr_item_changed');
      const observations = current.externalPrObservations ?? [];
      const existing = observations.find(entry => entry.url === observation.url);
      if (existing) {
        if (existing.head !== observation.head || existing.mergeCommit !== observation.mergeCommit
          || existing.mergedAt !== observation.mergedAt) throw new Error('external_pr_observation_conflict');
        return current;
      }
      return { ...current, externalPrObservations: [...observations, observation] };
    });
  });
}

async function replayObservation(runtime: Runtime, initial: WorkItem, request: Awaited<ReturnType<typeof requireRequest>>) {
  return runtime.requests.inspectLocked(request.id, async currentRequest => {
    if (JSON.stringify(currentRequest) !== JSON.stringify(request)) throw new Error('external_pr_request_changed');
    const current = await runtime.ledger.get(initial.id);
    requireApprovedWork(current, initial.owner);
    if (observationSubject(current) !== observationSubject(initial)) throw new Error('external_pr_item_changed');
    return current;
  });
}

/** Human CLI only: record a host-verified merged PR fact without review, acceptance, or completion. */
export async function observeExternalMerge(runtime: Runtime, ownerId: string, itemId: string, url: string, by: string) {
  const initial = await runtime.ledger.get(itemId);
  requireApprovedWork(initial, ownerId);
  const owner = runtime.repositoryFor(initial);
  if (!canChange(owner)) throw new Error('owner_cannot_change');
  const request = await requireRequest(runtime, initial);
  const number = pullNumber(url, owner.domain.name);
  const remote = await readPullRequest(owner.domain.name, number);
  validateRemote(remote, owner.domain.name, owner.domain.baseBranch, url);
  if (!remote.merged || !remote.merged_at) throw new Error('external_pr_requires_merged_observation');
  const directory = initial.planWorktree!;
  await requireSource(directory, remote.head.sha);
  await requireConfiguredBase(runtime, initial, directory, remote);
  const tree = await snapshotTree(directory);
  const existing = initial.externalPrObservations?.find(entry => entry.url === url);
  if (existing) {
    if (!sameObservedMerge(existing, remote)) throw new Error('external_pr_observation_conflict');
    return replayObservation(runtime, initial, request);
  }
  const followUpEvidence = await observationEvidence(runtime, initial, tree);
  const baseObserved = (await git(directory, ['rev-parse', `origin/${owner.domain.baseBranch}`])).trim();
  const observation = ExternalPrObservation.parse({
    url, repository: owner.domain.name, baseBranch: owner.domain.baseBranch, branch: remote.head.ref,
    head: remote.head.sha, tree, mergeCommit: remote.merge_commit_sha, mergedAt: remote.merged_at,
    baseObserved, by, observedAt: new Date().toISOString(), request: request.id,
    planDigest: initial.planDocument!.digest, acceptance: 'pending', followUpEvidence,
  });
  const latest = await readPullRequest(owner.domain.name, number);
  if (JSON.stringify(latest) !== JSON.stringify(remote)) throw new Error('external_pr_changed_during_observation');
  await requireSource(directory, remote.head.sha, tree);
  if (JSON.stringify(await observationEvidence(runtime, initial, tree)) !== JSON.stringify(followUpEvidence)) {
    throw new Error('external_pr_follow_up_evidence_changed');
  }
  return commitObservation(runtime, initial, observation, request);
}
