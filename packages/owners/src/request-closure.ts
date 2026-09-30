import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { effectiveDecision } from './artifacts.ts';
import { canChange, requireFreelancer } from './declarations.ts';
import { DESK_CHANGE_LIMITS, requestScopedVerification } from './desk-changes.ts';
import { deskReviewRounds, recordDeskReview, reviewSubject, type DeskReviewRound } from './desk-reviews.ts';
import { pullNumber, readPullRequest, validateRemote } from './external-publication.ts';
import { pickModel } from './families.ts';
import type { WorkItem } from './ledger.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { REPOSITORY_REVIEW } from './repository-writing.ts';
import { ClosureMerge, ClosureReview, RequestClosureCandidate } from './request-closure-types.ts';
import { readRequestWorkEvidence, type RequestWorkEvidence, REQUEST_EVIDENCE_LIMITS } from './request-work-evidence.ts';
import { clipped } from './chat-context.ts';
import { safeProse } from './friction.ts';
import type { ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { git, snapshotTree } from './workspace.ts';

export const REQUEST_CLOSURE_LIMITS = { evidenceMaxAgeMs: 24 * 60 * 60 * 1_000 };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Daemon polling timestamps are not new intent. All immutable request identity and authority are bound. */
export function requestClosureRequestDigest(request: ResourceRequest) {
  const { status: _status, reason: _reason, operation: _operation, updatedAt: _updatedAt,
    reconcileAfter: _reconcileAfter, retry: _retry, followUpResult: _followUpResult, ...subject } = request;
  return digest(subject);
}

function subjectDigest(item: WorkItem) {
  const { updatedAt: _updatedAt, requestClosureCandidates: _candidates, requestAcceptance: _acceptance, ...subject } = item;
  return digest(subject);
}

function requireAuthority(runtime: Runtime, item: WorkItem, ownerId: string, by: string) {
  if (!by.trim()) throw new Error('request_closure_human_required');
  if (item.owner !== ownerId) throw new Error('item_not_yours');
  if (!canChange(runtime.repositoryFor(item))) throw new Error('owner_cannot_change');
}

function requireWorking(item: WorkItem) {
  if (item.workflow !== OWNER_CHANGE_WORKFLOW || !item.planApproval || !item.planDocument || !item.request) {
    throw new Error('request_closure_requires_approved_request');
  }
  if (item.activeRunner) throw new Error('work_item_active');
  if (item.status !== 'working' || item.publication || item.deskPublication || item.requestAcceptance) {
    throw new Error('request_closure_item_not_working');
  }
  if (!item.externalPrObservations?.length) throw new Error('request_closure_historical_merge_missing');
}

function requireRequest(runtime: Runtime, item: WorkItem, request: ResourceRequest) {
  if (request.id !== item.request || request.to !== item.owner || request.workItem !== item.id
    || request.status !== 'work-running' || request.ask.kind !== 'work') throw new Error('request_closure_request_mismatch');
  const owner = runtime.repositoryFor(item);
  if (runtime.repositoryOwner(item.owner, request.ask.proposal.repository).domain.name !== owner.domain.name) {
    throw new Error('request_closure_repository_mismatch');
  }
  if (request.ask.proposal.goal !== item.proposal.goal
    || JSON.stringify(request.ask.proposal.acceptance) !== JSON.stringify(item.proposal.acceptance)) {
    throw new Error('request_closure_goal_mismatch');
  }
}

function configurationDigest(runtime: Runtime, item: WorkItem) {
  return digest({ owner: runtime.repositoryFor(item), reviewer: requireFreelancer(runtime.declarations, 'review'),
    families: runtime.declarations.families });
}

function matchingFullReview(rounds: DeskReviewRound[], evidence: RequestWorkEvidence) {
  const review = evidence.review;
  if (!review) return true;
  return rounds.some(round => round.tree === evidence.verification?.tree && round.reviewer === review.reviewer
    && round.decision === review.verdict.decision
    && clipped(safeProse(round.summary), REQUEST_EVIDENCE_LIMITS.fieldChars) === review.verdict.summary
    && review.verdict.findings.every(finding => round.findings.some(full => full.severity === finding.severity
      && (['file', 'issue', 'suggestion'] as const).every(key => clipped(safeProse(full[key]), REQUEST_EVIDENCE_LIMITS.fieldChars) === finding[key]))));
}

async function historicalEvidence(runtime: Runtime, item: WorkItem) {
  const rounds = await deskReviewRounds(runtime, item.owner, reviewSubject(runtime.repositoryFor(item).domain.name, item.id), true);
  const evidence = await readRequestWorkEvidence(runtime, item).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  for (const observation of item.externalPrObservations ?? []) {
    if (observation.request !== item.request || observation.planDigest !== item.planDocument!.digest) {
      throw new Error('request_closure_historical_scope_mismatch');
    }
    if (observation.followUpEvidence?.abbreviated && !matchingFullReview(rounds, observation.followUpEvidence)) {
      throw new Error('request_closure_full_review_missing');
    }
  }
  if (evidence?.abbreviated && !matchingFullReview(rounds, evidence)) {
    throw new Error('request_closure_full_review_missing');
  }
  const findings = [...rounds.flatMap(round => round.findings), ...item.verdicts.flatMap(verdict => verdict.findings),
    ...(!evidence?.abbreviated ? evidence?.review?.verdict.findings ?? [] : []),
    ...(item.externalPrObservations ?? []).flatMap(observation => !observation.followUpEvidence?.abbreviated ? observation.followUpEvidence?.review?.verdict.findings ?? [] : [])];
  const unique = new Map(findings.map(finding => [digest(finding), { id: digest(finding), finding }]));
  return { historyDigest: digest({ rounds, evidence }), findings: [...unique.values()], rounds, evidence };
}

async function mergedPullRequest(runtime: Runtime, item: WorkItem, url: string): Promise<ClosureMerge> {
  const owner = runtime.repositoryFor(item);
  const remote = await readPullRequest(owner.domain.name, pullNumber(url, owner.domain.name));
  validateRemote(remote, owner.domain.name, owner.domain.baseBranch, url);
  if (!remote.merged || !remote.merged_at || !remote.merge_commit_sha) throw new Error('request_closure_follow_up_unmerged');
  return ClosureMerge.parse({ url, repository: owner.domain.name, baseBranch: owner.domain.baseBranch,
    head: remote.head.sha, mergeCommit: remote.merge_commit_sha, mergedAt: remote.merged_at });
}

async function requireAncestor(directory: string, ancestor: string, descendant: string) {
  try { await git(directory, ['merge-base', '--is-ancestor', ancestor, descendant]); }
  catch (cause) { throw new Error('request_closure_commit_not_in_base', { cause }); }
}

async function sourceSnapshot(runtime: Runtime, item: WorkItem, directory: string) {
  const source = await realpath(directory);
  if (source !== await realpath((await git(source, ['rev-parse', '--show-toplevel'])).trim())) {
    throw new Error('request_closure_requires_worktree_root');
  }
  if (item.planWorktree && source === await realpath(item.planWorktree)) throw new Error('request_closure_requires_separate_worktree');
  const owner = runtime.repositoryFor(item);
  if ((await git(source, ['remote', 'get-url', 'origin'])).trim() !== owner.domain.remote) {
    throw new Error('request_closure_remote_mismatch');
  }
  if ((await git(source, ['status', '--porcelain'])).trim()) throw new Error('request_closure_worktree_dirty');
  await git(source, ['fetch', '--no-tags', 'origin', owner.domain.baseBranch]);
  const head = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const currentBase = (await git(source, ['rev-parse', `origin/${owner.domain.baseBranch}`])).trim();
  if (head !== currentBase) throw new Error('request_closure_source_not_current_base');
  return { directory: source, head, tree: await snapshotTree(source) };
}

async function closureSubject(runtime: Runtime, item: WorkItem, directory: string, followUpUrls: string[]) {
  requireWorking(item);
  const request = await runtime.requests.get(item.request!);
  requireRequest(runtime, item, request);
  if (!followUpUrls.length || new Set(followUpUrls).size !== followUpUrls.length) throw new Error('request_closure_follow_ups_invalid');
  const source = await sourceSnapshot(runtime, item, directory);
  const historicalMerges = await Promise.all(item.externalPrObservations!.map(async observation => {
    const remote = await mergedPullRequest(runtime, item, observation.url);
    if (remote.head !== observation.head || remote.mergeCommit !== observation.mergeCommit || remote.mergedAt !== observation.mergedAt
      || remote.repository !== observation.repository || remote.baseBranch !== observation.baseBranch) {
      throw new Error('request_closure_historical_merge_changed');
    }
    return remote;
  }));
  if (followUpUrls.some(url => historicalMerges.some(merge => merge.url === url))) throw new Error('request_closure_follow_ups_invalid');
  const followUps = await Promise.all([...followUpUrls].sort().map(url => mergedPullRequest(runtime, item, url)));
  for (const merge of [...historicalMerges, ...followUps]) await requireAncestor(source.directory, merge.mergeCommit, source.head);
  for (const followUp of followUps) {
    for (const original of historicalMerges) await requireAncestor(source.directory, original.mergeCommit, followUp.mergeCommit);
  }
  const history = await historicalEvidence(runtime, item);
  const owner = runtime.repositoryFor(item);
  const base = (await git(source.directory, ['rev-parse', `${historicalMerges[0]!.mergeCommit}^1`])).trim();
  return { ...source, base, repository: owner.domain.name, baseBranch: owner.domain.baseBranch,
    historicalMerges, followUps, originalFindings: history.findings, historyDigest: history.historyDigest,
    requestDigest: requestClosureRequestDigest(request), subjectDigest: subjectDigest(item),
    configurationDigest: configurationDigest(runtime, item) };
}

type ClosureSubject = Awaited<ReturnType<typeof closureSubject>>;
function closureBrief(item: WorkItem, subject: ClosureSubject, evidence: unknown, patch: string) {
  return [REPOSITORY_REVIEW, 'Review closure of an original approved request against integrated follow-up fixes. Do not edit anything.',
    'This is a new review of the integrated tree. Never rewrite or claim approval of a historical head. Merge alone is not acceptance.',
    `Original goal and acceptance criteria:\n${JSON.stringify(item.proposal)}`,
    `Original approved plan:\n${JSON.stringify({ plan: item.planDocument, approval: item.planApproval })}`,
    `Verified historical merges and follow-ups:\n${JSON.stringify({ historical: subject.historicalMerges, followUps: subject.followUps })}`,
    `All recorded historical findings:\n${JSON.stringify(subject.originalFindings)}`,
    `Host sandbox verification of exact tree:\n${JSON.stringify(evidence)}`,
    `Integrated diff from ${subject.base}:\n${patch}`,
    'For EVERY listed finding return exactly one resolution naming its id. A fixed resolution must cite current code and relevant evidence.',
    'Use outside-original-scope only with a concrete citation to the original approved goal/plan that excludes the demand. Never silently drop a finding.',
    'Check every original acceptance criterion with available evidence. Missing access or evidence means revise, not fabricated success.',
    'Approve only when the original scoped goal is satisfied and all scoped outstanding findings are resolved. Do not infer deployment or live behavior from fixture tests.',
  ].join('\n\n');
}

function requireCompleteReview(review: ClosureReview, subject: ClosureSubject) {
  if (review.verdict.decision !== 'approve' || effectiveDecision(review.verdict) !== 'approve') throw new Error('request_closure_review_needs_work');
  const identifiers = review.resolutions.map(resolution => resolution.finding);
  if (new Set(identifiers).size !== identifiers.length || identifiers.length !== subject.originalFindings.length
    || subject.originalFindings.some(finding => !identifiers.includes(finding.id))) throw new Error('request_closure_findings_unresolved');
}

async function reviewClosure(runtime: Runtime, item: WorkItem, subject: ClosureSubject) {
  const owner = runtime.repositoryFor(item);
  const verified = await requestScopedVerification(runtime, owner, undefined, subject.directory);
  if (verified.failure) throw new Error(`request_closure_verification_failed: ${verified.failure.summary}`);
  if (verified.changed || verified.evidence.tree !== subject.tree) throw new Error('review_evidence_stale');
  const patch = (await git(subject.directory, ['diff', subject.base, subject.head])).slice(0, DESK_CHANGE_LIMITS.diffChars);
  const reviewer = pickModel(runtime.declarations.families, requireFreelancer(runtime.declarations, 'review').models, [runtime.family(owner.model)]);
  const hired = await runtime.hire(owner.id, { role: 'reviewer', model: reviewer.model, directory: subject.directory,
    title: `${owner.id}: review request closure ${item.id}`, brief: closureBrief(item, subject, verified.evidence, patch), schema: ClosureReview });
  const review = ClosureReview.parse(hired.value);
  await recordDeskReview(runtime, owner.id, `${reviewSubject(owner.domain.name, item.id)}/closure/${digest(subject)}-${randomUUID()}`, {
    at: new Date().toISOString(), reviewer: reviewer.model, ...review.verdict, tree: subject.tree, evidence: verified.evidence,
  });
  requireCompleteReview(review, subject);
  return { verification: verified.evidence, review: { ...review, reviewer: reviewer.model } };
}

function sameCandidateSubject(candidate: RequestClosureCandidate, subject: ClosureSubject) {
  const keys: (keyof ClosureSubject)[] = ['directory', 'head', 'tree', 'base', 'repository', 'baseBranch',
    'historicalMerges', 'followUps', 'originalFindings', 'historyDigest', 'requestDigest', 'subjectDigest', 'configurationDigest'];
  return keys.every(key => digest(candidate[key]) === digest(subject[key]));
}

function reusableCandidate(item: WorkItem, subject: ClosureSubject, maxAgeMs?: number) {
  return [...item.requestClosureCandidates ?? []].reverse().find(candidate => {
    if (!sameCandidateSubject(candidate, subject)) return false;
    try { requireFreshCandidate(candidate, maxAgeMs); return true; }
    catch { return false; }
  });
}

function candidateDigest(candidate: Omit<RequestClosureCandidate, 'digest'>) { return digest(candidate); }
function requireCandidateDigest(candidate: RequestClosureCandidate) {
  const { digest: recorded, ...subject } = candidate;
  if (candidateDigest(subject) !== recorded) throw new Error('request_closure_evidence_corrupt');
}

async function requireFinalSnapshot(runtime: Runtime, item: WorkItem, candidate: RequestClosureCandidate) {
  requireFreshCandidate(candidate, runtime.repositoryFor(item).domain.requestClosureEvidenceMaxAgeMs);
  if (configurationDigest(runtime, item) !== candidate.configurationDigest
    || (await historicalEvidence(runtime, item)).historyDigest !== candidate.historyDigest) {
    throw new Error('request_closure_evidence_stale');
  }
  if ((await git(candidate.directory, ['status', '--porcelain'])).trim()
    || (await git(candidate.directory, ['rev-parse', 'HEAD'])).trim() !== candidate.head
    || (await git(candidate.directory, ['rev-parse', `origin/${candidate.baseBranch}`])).trim() !== candidate.head
    || await snapshotTree(candidate.directory) !== candidate.tree) throw new Error('request_closure_evidence_stale');
}

async function commitPrepared(runtime: Runtime, initial: WorkItem, candidate: RequestClosureCandidate) {
  return runtime.requests.inspectLocked(candidate.request, async request => {
    requireRequest(runtime, initial, request);
    if (requestClosureRequestDigest(request) !== candidate.requestDigest) throw new Error('request_closure_request_changed');
    const saved = await runtime.ledger.updateIfChanged(initial.id, async current => {
      requireWorking(current);
      if (subjectDigest(current) !== candidate.subjectDigest) throw new Error('request_closure_item_changed');
      await requireFinalSnapshot(runtime, current, candidate);
      if (reusableCandidate(current, candidate, runtime.repositoryFor(current).domain.requestClosureEvidenceMaxAgeMs)) return undefined;
      return { ...current, requestClosureCandidates: [...current.requestClosureCandidates ?? [], candidate] };
    });
    return reusableCandidate(saved, candidate, runtime.repositoryFor(saved).domain.requestClosureEvidenceMaxAgeMs)!;
  });
}

/** Human CLI preparation: fresh configured verification and an independent review; no lifecycle transition. */
export async function prepareRequestClosure(runtime: Runtime, ownerId: string, itemId: string,
  sourceDirectory: string, followUpUrls: string[], by: string) {
  const item = await runtime.ledger.get(itemId);
  requireAuthority(runtime, item, ownerId, by);
  const subject = await closureSubject(runtime, item, sourceDirectory, followUpUrls);
  const reusable = reusableCandidate(item, subject, runtime.repositoryFor(item).domain.requestClosureEvidenceMaxAgeMs);
  if (reusable) return commitPrepared(runtime, item, reusable);
  const review = await reviewClosure(runtime, item, subject);
  const refreshed = await closureSubject(runtime, await runtime.ledger.get(itemId), sourceDirectory, followUpUrls);
  if (digest(refreshed) !== digest(subject)) throw new Error('request_closure_evidence_stale');
  const fields = { ...subject, item: itemId, request: item.request!, owner: ownerId,
    proposal: item.proposal, planDigest: item.planDocument!.digest, planDocumentDigest: digest(item.planDocument),
    approvalDigest: digest(item.planApproval), ...review,
    preparedBy: by, preparedAt: new Date().toISOString() };
  const { digest: _placeholder, ...parsed } = RequestClosureCandidate.parse({ ...fields, digest: '0'.repeat(64) });
  const candidate = { ...parsed, digest: candidateDigest(parsed) };
  return commitPrepared(runtime, item, candidate);
}

/** Validate the immutable receipt before projecting completion, including unchanged original approval and goal. */
export function requireRequestAcceptance(item: WorkItem) {
  const accepted = item.requestAcceptance;
  if (!accepted || item.status !== 'landed' || item.activeRunner) throw new Error('request_closure_acceptance_binding_mismatch');
  const candidate = accepted.candidate;
  if (candidate.item !== item.id || candidate.request !== item.request || candidate.owner !== item.owner
    || digest(candidate.proposal) !== digest(item.proposal) || candidate.planDigest !== item.planDocument?.digest
    || candidate.planDocumentDigest !== digest(item.planDocument) || candidate.approvalDigest !== digest(item.planApproval)) {
    throw new Error('request_closure_acceptance_binding_mismatch');
  }
  requireCandidateDigest(candidate);
  return accepted;
}

function acceptedReplay(item: WorkItem, candidateDigest: string, by: string, note: string) {
  if (!item.requestAcceptance) return undefined;
  const accepted = requireRequestAcceptance(item);
  if (accepted.candidate.digest !== candidateDigest || accepted.by !== by || accepted.note !== note) {
    throw new Error('request_closure_acceptance_conflict');
  }
  return item;
}

function requireFreshCandidate(candidate: RequestClosureCandidate, maxAgeMs = REQUEST_CLOSURE_LIMITS.evidenceMaxAgeMs) {
  requireCandidateDigest(candidate);
  const age = Date.now() - Date.parse(candidate.verification.observedAt);
  if (age < 0 || age > maxAgeMs) throw new Error('request_closure_evidence_expired');
}

async function commitAcceptance(runtime: Runtime, initial: WorkItem, candidate: RequestClosureCandidate, by: string, note: string) {
  return runtime.requests.inspectLocked(candidate.request, async request => {
    if (requestClosureRequestDigest(request) !== candidate.requestDigest) throw new Error('request_closure_request_changed');
    return runtime.ledger.updateIfChanged(initial.id, async current => {
      const existing = acceptedReplay(current, candidate.digest, by, note);
      if (existing) return undefined;
      requireRequest(runtime, current, request);
      requireWorking(current);
      if (subjectDigest(current) !== candidate.subjectDigest) throw new Error('request_closure_item_changed');
      if (!current.requestClosureCandidates?.some(entry => entry.digest === candidate.digest)) throw new Error('request_closure_candidate_missing');
      await requireFinalSnapshot(runtime, current, candidate);
      return { ...current, status: 'landed', requestAcceptance: { candidate, by, note, acceptedAt: new Date().toISOString() } };
    });
  });
}

/** Explicit human acceptance consumes one fresh exact candidate; no model inference or publication effects. */
export async function acceptRequestClosure(runtime: Runtime, ownerId: string, itemId: string,
  candidateDigest: string, by: string, note: string) {
  const item = await runtime.ledger.get(itemId);
  requireAuthority(runtime, item, ownerId, by);
  if (!note.trim()) throw new Error('request_closure_acceptance_note_required');
  const existing = acceptedReplay(item, candidateDigest, by, note);
  if (existing) {
    const request = await runtime.requests.get(existing.requestAcceptance!.candidate.request);
    if (requestClosureRequestDigest(request) !== existing.requestAcceptance!.candidate.requestDigest) {
      throw new Error('request_closure_request_changed');
    }
    return existing;
  }
  const candidate = item.requestClosureCandidates?.find(entry => entry.digest === candidateDigest);
  if (!candidate) throw new Error('request_closure_candidate_missing');
  requireFreshCandidate(candidate, runtime.repositoryFor(item).domain.requestClosureEvidenceMaxAgeMs);
  const current = await closureSubject(runtime, item, candidate.directory, candidate.followUps.map(merge => merge.url));
  for (const key of Object.keys(current) as (keyof ClosureSubject)[]) {
    if (digest(current[key]) !== digest(candidate[key])) throw new Error('request_closure_evidence_stale');
  }
  return commitAcceptance(runtime, item, candidate, by, note);
}
