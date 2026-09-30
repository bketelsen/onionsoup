import { createHash } from 'node:crypto';
import { loadDeclarations, planGrantFor, repositoryNames } from './declarations.ts';
import { DirectRequestPlanReviewInput, type DirectRequestPlanReview } from './direct-request-plan-review-types.ts';
import type { WorkItem } from './ledger.ts';
import { queuePlanRevision } from './plan-revision.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { SUPERVISION_LIMITS } from './plan-review-limits.ts';
import type { ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
export { DirectRequestPlanReviewInput, DirectRequestPlanReview } from './direct-request-plan-review-types.ts';

function requireDirectBinding(request: ResourceRequest, item: WorkItem) {
  if (request.ask.kind !== 'work' || request.ask.assignment || item.assignment
    || request.workItem !== item.id || item.request !== request.id || request.to !== item.owner
    || item.workflow !== OWNER_CHANGE_WORKFLOW || !item.planDocument) {
    throw new Error('direct_plan_review_binding_mismatch');
  }
  return request.ask;
}

/** Includes both original scope and submitted plan without assuming their goals are literal copies. */
function bindingDigest(request: ResourceRequest, item: WorkItem, repository: string) {
  const binding = [request.id, request.from, request.to, request.ask, request.workItem, request.origin,
    item.id, item.owner, repository, item.proposal, item.planDocument,
    item.humanNotes.filter(note => note.kind === 'plan-feedback')];
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

async function context(runtime: Runtime, request: ResourceRequest, item: WorkItem) {
  const ask = requireDirectBinding(request, item);
  const revisions = item.directRequestPlanReviews.filter(review => review.decision === 'revise').length;
  if (revisions >= SUPERVISION_LIMITS.revisionsPerItem) throw new Error('direct_plan_review_revision_limit');
  const declarations = await loadDeclarations(runtime.declarations.root);
  const owner = declarations.owners.get(item.owner);
  if (!owner || owner.reportsTo !== request.from || !declarations.owners.has(request.from)) {
    throw new Error('direct_plan_review_not_requester');
  }
  const repositories = repositoryNames(owner);
  const repository = item.proposal.repository ?? (repositories.length === 1 ? repositories[0] : undefined);
  if (!repository || !repositories.includes(repository) || (ask.proposal.repository ?? repository) !== repository) {
    throw new Error('direct_plan_review_binding_mismatch');
  }
  const grant = planGrantFor(owner, request.from, repository);
  if (!grant) throw new Error('direct_plan_review_no_grant');
  return { request, item, reviewer: request.from, repository, grant, digest: bindingDigest(request, item, repository) };
}

function requireWaiting(request: ResourceRequest, item: WorkItem) {
  if (request.status !== 'work-running' || item.status !== 'awaiting-plan-approval' || item.activeRunner) {
    throw new Error(`not_awaiting_plan_approval: ${item.status}`);
  }
}

/** The exact reviewable request and plan. Informational delivery is not an approval or review wake. */
export async function getDirectRequestReview(runtime: Runtime, requestId: string) {
  requestId = DirectRequestPlanReviewInput.shape.request.parse(requestId);
  return runtime.requests.inspectLocked(requestId, async request => {
    if (!request.workItem) throw new Error('direct_plan_review_binding_mismatch');
    const item = await runtime.ledger.get(request.workItem);
    const review = await context(runtime, request, item);
    requireWaiting(request, item);
    return { ...review, reviewed: item.directRequestPlanReviews.some(receipt => receipt.digest === review.digest) };
  });
}

function requireScope(input: DirectRequestPlanReviewInput) {
  if (input.decision === 'approve' && input.scope !== 'matched') throw new Error('direct_plan_review_scope_unresolved');
  if (input.decision === 'needs-human' && input.scope !== 'needs-human') throw new Error('direct_plan_review_scope_unresolved');
}

function previousReview(item: WorkItem, reviewer: string, input: DirectRequestPlanReviewInput) {
  const receipt = item.directRequestPlanReviews.find(review => review.digest === input.digest);
  if (!receipt) return undefined;
  const matches = receipt.request === input.request && receipt.item === input.item && receipt.reviewer === reviewer
    && receipt.decision === input.decision && receipt.scope === input.scope && receipt.note === input.note;
  if (!matches) throw new Error('direct_plan_review_already_decided');
  return receipt;
}

/** Recheck disk authority and immutable request binding inside the final request/item critical section. */
export async function validateDirectRequestPlanReview(
  runtime: Runtime, request: ResourceRequest, item: WorkItem, review: DirectRequestPlanReview,
) {
  if (item.directRequestPlanReviews.some(receipt => receipt.digest === review.digest)) {
    throw new Error('direct_plan_review_already_decided');
  }
  const current = await context(runtime, request, item);
  if (review.reviewer !== request.from) throw new Error('direct_plan_review_not_requester');
  if (review.item !== item.id || review.request !== request.id || review.repository !== current.repository) {
    throw new Error('direct_plan_review_binding_mismatch');
  }
  if (review.digest !== current.digest) throw new Error('direct_plan_review_stale');
  requireScope(review);
  requireWaiting(request, item);
  return current;
}

function recordDecision(item: WorkItem, review: DirectRequestPlanReview): WorkItem {
  const recorded = { ...item, directRequestPlanReviews: [...item.directRequestPlanReviews, review] };
  if (review.decision !== 'approve') return { ...recorded, reason: `direct_plan_review_scope_unresolved: ${review.note}` };
  const by = `owner:${review.reviewer} (standing grant approve-plans in ${item.owner})`;
  return { ...recorded, status: 'working', reason: undefined,
    planApproval: { by, at: review.at, note: review.note },
    humanNotes: [...item.humanNotes, { kind: 'approval', by, at: review.at, note: review.note }] };
}

async function recordReview(runtime: Runtime, review: DirectRequestPlanReview) {
  const item = await runtime.requests.inspectLocked(review.request, request => runtime.ledger.updateIfChanged(review.item, async current => {
    if (previousReview(current, review.reviewer, review)) return undefined;
    const binding = await validateDirectRequestPlanReview(runtime, request, current, review);
    return recordDecision(current, { ...review, grantTarget: binding.grant.target });
  }));
  await journalReview(runtime, item, item.directRequestPlanReviews.find(receipt => receipt.digest === review.digest)!);
  return item;
}

async function journalReview(runtime: Runtime, item: WorkItem, review: DirectRequestPlanReview) {
  const kind = review.decision === 'approve' ? 'grant-used' : 'plan-review';
  const note = `${item.id}: ${review.decision} by ${review.reviewer}; request ${review.request}; plan binding ${review.digest}; scope ${review.scope}: ${review.note}`;
  for (const owner of [review.reviewer, item.owner]) {
    await runtime.notebook(owner).journalOnce({ kind, workItem: item.id, note,
      source: `direct-request-plan-review:${review.digest}` }, review.at);
  }
}

async function prepareReview(runtime: Runtime, reviewer: string, input: DirectRequestPlanReviewInput) {
  return runtime.requests.inspectLocked(input.request, async request => {
    const item = await runtime.ledger.get(input.item);
    const previous = previousReview(item, reviewer, input);
    if (previous) return { item, previous };
    if (request.from !== reviewer) throw new Error('direct_plan_review_not_requester');
    const binding = await context(runtime, request, item);
    if (binding.digest !== input.digest) throw new Error('direct_plan_review_stale');
    requireWaiting(request, item);
    const review: DirectRequestPlanReview = { ...input, reviewer, repository: binding.repository,
      grantTarget: binding.grant.target, at: new Date().toISOString() };
    return { item, review };
  });
}

/** A granted requester explicitly reviews the exact plan; uncertain scope stays at the human gate. */
export async function reviewDirectRequestPlan(runtime: Runtime, reviewer: string, supplied: DirectRequestPlanReviewInput) {
  const input = DirectRequestPlanReviewInput.parse(supplied);
  requireScope(input);
  const prepared = await prepareReview(runtime, reviewer, input);
  if (!prepared.review) {
    await journalReview(runtime, prepared.item, prepared.previous!);
    return prepared.item;
  }
  if (prepared.review.decision === 'revise') {
    const item = await queuePlanRevision(runtime, input.item, `owner:${reviewer}`, input.note, prepared.review);
    await journalReview(runtime, item, item.directRequestPlanReviews.find(receipt => receipt.digest === input.digest)!);
    return item;
  }
  return recordReview(runtime, prepared.review);
}
