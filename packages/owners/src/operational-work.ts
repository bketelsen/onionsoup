import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { effectiveDecision, Verdict } from './artifacts.ts';
import type { ChatOrigin } from './chat-origin.ts';
import { requireFreelancer } from './declarations.ts';
import { requestScopedVerification } from './desk-changes.ts';
import { pickModel } from './families.ts';
import { decidedInstance, reconcileDeletion } from './incus.ts';
import type { WorkItem } from './ledger.ts';
import { ownerMessageId } from './owner-messages.ts';
import { queueNotice } from './notices.ts';
import { OperationalCompletion, OperationalEvidence, type OperationalEffect } from './operational-work-types.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { operationalEvidenceView, readRequestWorkEvidence, recordRequestWorkEvidence } from './request-work-evidence.ts';
import type { ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { rememberedSession } from './session-history.ts';
import { SessionOpeningStore } from './session-opening-store.ts';
import { git, snapshotTree } from './workspace.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameOrigin = (left: ChatOrigin | undefined, right: ChatOrigin) =>
  left?.sessionID === right.sessionID && left.directory === right.directory;

function requestDigest(request: ResourceRequest) {
  return digest({ id: request.id, from: request.from, to: request.to, ask: request.ask,
    origin: request.origin, workItem: request.workItem, followUp: request.followUp });
}

function configurationDigest(runtime: Runtime, item: WorkItem) {
  return digest({ owner: runtime.repositoryFor(item), review: requireFreelancer(runtime.declarations, 'review'),
    families: runtime.declarations.families });
}

function requireBinding(item: WorkItem, request: ResourceRequest) {
  if (item.workflow !== OWNER_CHANGE_WORKFLOW || !item.planApproval || !item.planDocument
    || request.ask.kind !== 'work' || request.id !== item.request || request.to !== item.owner
    || request.workItem !== item.id) throw new Error('operational_request_binding_mismatch');
  if (item.proposal.goal !== request.ask.proposal.goal
    || digest(item.proposal.acceptance) !== digest(request.ask.proposal.acceptance)) {
    throw new Error('operational_original_goal_changed');
  }
  if (item.publication || item.deskPublication || item.externalPrObservations?.length || item.requestAcceptance) {
    throw new Error('operational_repository_publication_required');
  }
}

async function requireCaller(runtime: Runtime, item: WorkItem, owner: string, origin: ChatOrigin) {
  if (item.owner !== owner || !runtime.owner(owner).persona) throw new Error('operational_item_not_yours');
  const observed = await rememberedSession(runtime, origin.sessionID);
  if (!observed || observed.owner !== owner || observed.directory !== origin.directory || observed.parentID) {
    throw new Error('operational_session_unproven');
  }
  if (!(await executionOrigins(runtime, item)).some(candidate => sameOrigin(candidate, origin))) {
    throw new Error('operational_not_execution_session');
  }
}

async function executionOrigins(runtime: Runtime, item: WorkItem) {
  if (!item.session) throw new Error('operational_execution_session_missing');
  const origins = [item.session];
  const store = new SessionOpeningStore(runtime.stateDirectory);
  for (let index = 0; index < runtime.owner(item.owner).chatContext.noticeSessions; index += 1) {
    const predecessor = origins.at(-1)!;
    const opening = await store.read({ entity: 'owner-continuation', kind: 'continuation', owner: item.owner,
      id: ownerMessageId([item.owner, predecessor.sessionID]) });
    if (!opening?.origin || opening.phase !== 'opened') break;
    origins.push(opening.origin);
  }
  return origins;
}

async function sourceSnapshot(runtime: Runtime, item: WorkItem, origin: ChatOrigin) {
  const directory = await realpath(origin.directory);
  const owner = runtime.repositoryFor(item);
  const permitted = [item.planWorktree, owner.workspace, ...runtime.repositoryViews(item.owner).map(view => view.desk)]
    .filter((path): path is string => Boolean(path));
  const roots = await Promise.all(permitted.map(path => realpath(path).catch(() => undefined)));
  if (!roots.includes(directory) || directory !== await realpath((await git(directory, ['rev-parse', '--show-toplevel'])).trim())) {
    throw new Error('operational_source_mismatch');
  }
  if ((await git(directory, ['remote', 'get-url', 'origin'])).trim() !== owner.domain.remote) {
    throw new Error('operational_repository_mismatch');
  }
  if ((await git(directory, ['status', '--porcelain'])).trim()
    || (await git(directory, ['rev-list', 'HEAD', '--not', '--remotes'])).trim()) {
    throw new Error('operational_repository_publication_required');
  }
  return { directory, head: (await git(directory, ['rev-parse', 'HEAD'])).trim(), tree: await snapshotTree(directory) };
}

async function instanceEffect(runtime: Runtime, resource: ResourceRequest): Promise<OperationalEffect> {
  const expected = resource.operation?.checkpoint?.instance;
  const decision = resource.decision;
  const owner = runtime.incusOwner(resource.to);
  const createApproval = resource.approvals.find(approval => approval.step === 'create');
  const deleteApproval = resource.approvals.find(approval => approval.step === 'delete')
    ?? (resource.leaseIncludesDelete ? createApproval : undefined);
  if (resource.ask.kind !== 'instance' || !expected || !resource.instance || !decision || !createApproval || !deleteApproval
    || expected.remote !== decision.remote || expected.image !== decision.image
    || expected.name !== decidedInstance(owner, decision).name
    || resource.instance.remote !== expected.remote || resource.instance.name !== expected.name
    || decision.decision !== 'accept') {
    throw new Error('operational_instance_provenance_missing');
  }
  const remote = owner.domain.remotes.find(candidate => candidate.name === expected.remote);
  if (!remote?.allow.includes('observe')) throw new Error('operational_instance_observation_not_allowed');
  if (resource.followUp !== 'none' && !resource.followUpResult?.ok) throw new Error('operational_follow_up_not_verified');
  if (resource.status !== 'deleted') throw new Error('operational_resource_cleanup_pending');
  if (!(await reconcileDeletion(runtime.incus, owner, runtime.managed, expected, resource))) {
    throw new Error('operational_resource_still_present');
  }
  return { request: resource.id, kind: 'instance', owner: resource.to, ...expected,
    createApproval: createApproval.by, deleteApproval: deleteApproval.by, followUp: resource.followUp,
    followedUpAt: resource.followUpResult?.at, postcondition: 'absent', observedAt: new Date().toISOString() };
}

async function effects(runtime: Runtime, item: WorkItem) {
  const origins = await executionOrigins(runtime, item);
  const related = (await runtime.requests.list()).filter(resource => resource.id !== item.request
    && resource.from === item.owner && origins.some(candidate => sameOrigin(resource.origin, candidate)));
  if (related.some(resource => resource.ask.kind !== 'instance')) throw new Error('operational_effect_verifier_unavailable');
  return Promise.all(related.map(resource => instanceEffect(runtime, resource)));
}

function reviewBrief(item: WorkItem, request: ResourceRequest, completion: unknown) {
  return [
    'Independently review completion of non-PR operational work. Do not edit or perform effects.',
    `Exact original request:\n${JSON.stringify({ id: request.id, from: request.from, ask: request.ask })}`,
    `Original approved work:\n${JSON.stringify({ id: item.id, proposal: item.proposal,
      plan: item.planDocument, approval: item.planApproval, session: item.session })}`,
    `Host evidence:\n${JSON.stringify(completion)}`,
    'Configured sandbox checks only prove what those commands check. Resource facts are host-observed for exact gated requests.',
    'Check EVERY original goal and acceptance criterion, including verification results and cleanup postconditions.',
    'Owner reports, same-named foreign resources, unavailable evidence and fixtures never prove live results.',
    'Approve only if all original scoped criteria have concrete evidence. Otherwise revise with precise missing evidence.',
    'No PR, publication acceptance or extra human closure ceremony is needed; create/delete gates remain mandatory.',
  ].join('\n\n');
}

async function verifyCompletion(runtime: Runtime, item: WorkItem, request: ResourceRequest, origin: ChatOrigin) {
  const source = await sourceSnapshot(runtime, item, origin);
  const verified = await requestScopedVerification(runtime, runtime.repositoryFor(item), item, source.directory);
  if (verified.failure) throw new Error('operational_configured_checks_failed');
  if (verified.changed || verified.evidence.tree !== source.tree) throw new Error('operational_source_changed');
  if (!verified.evidence.checks.length) throw new Error('operational_configured_checks_missing');
  const observedEffects = await effects(runtime, item);
  const reviewer = pickModel(runtime.declarations.families, requireFreelancer(runtime.declarations, 'review').models,
    [runtime.family(runtime.owner(item.owner).model)]);
  const hired = await runtime.hire(item.owner, { role: 'reviewer', model: reviewer.model, directory: source.directory,
    title: `${item.id}: operational goal review`,
    brief: reviewBrief(item, request, { source, verification: verified.evidence, effects: observedEffects }), schema: Verdict });
  const verdict = Verdict.parse(hired.value);
  await recordRequestWorkEvidence(runtime, item, { stage: 'reviewed', verification: verified.evidence,
    review: { reviewer: reviewer.model, verdict }, blocker: effectiveDecision(verdict) === 'approve'
      && verdict.decision === 'approve' ? undefined : 'operational_goal_review_needs_work' });
  if (verdict.decision !== 'approve' || effectiveDecision(verdict) !== 'approve') {
    throw new Error('operational_goal_review_needs_work');
  }
  if (digest(await sourceSnapshot(runtime, item, origin)) !== digest(source)) throw new Error('operational_source_changed');
  const finalEffects = await effects(runtime, item);
  if (digest(finalEffects.map(({ observedAt: _at, ...fact }) => fact))
    !== digest(observedEffects.map(({ observedAt: _at, ...fact }) => fact))) throw new Error('operational_effects_changed');
  return OperationalCompletion.parse({ item: item.id, request: request.id, owner: item.owner,
    requestDigest: requestDigest(request), goalDigest: digest(item.proposal), planDigest: item.planDocument!.digest,
    planDocumentDigest: digest(item.planDocument),
    approvalDigest: digest(item.planApproval), configurationDigest: configurationDigest(runtime, item),
    session: item.session, execution: origin, source, verification: verified.evidence, effects: finalEffects,
    review: { reviewer: reviewer.model, verdict }, completedAt: new Date().toISOString() });
}

function requireReceipt(item: WorkItem, request: ResourceRequest, receipt: OperationalCompletion) {
  requireBinding(item, request);
  if (receipt.item !== item.id || receipt.request !== request.id || receipt.owner !== item.owner
    || receipt.requestDigest !== requestDigest(request) || receipt.goalDigest !== digest(item.proposal)
    || receipt.planDigest !== item.planDocument!.digest || receipt.planDocumentDigest !== digest(item.planDocument)
    || receipt.approvalDigest !== digest(item.planApproval)
    || !sameOrigin(item.session, receipt.session) || receipt.verification.tree !== receipt.source.tree
    || !receipt.verification.checks.length || receipt.verification.checks.some(check => check.exitCode !== 0)
    || receipt.review.verdict.decision !== 'approve' || effectiveDecision(receipt.review.verdict) !== 'approve') {
    throw new Error('operational_completion_binding_mismatch');
  }
}

async function recordCompletedEvidence(runtime: Runtime, item: WorkItem, receipt: OperationalCompletion) {
  const operational = operationalEvidenceView(OperationalEvidence.parse(receipt));
  const previous = await readRequestWorkEvidence(runtime, item).catch(() => undefined);
  if (previous?.stage === 'reviewed' && !previous.blocker && previous.operational
    && digest(previous.operational) === digest(operational)) return;
  await recordRequestWorkEvidence(runtime, item, { stage: 'reviewed', verification: receipt.verification,
    review: receipt.review, operational });
}

async function projectLedger(runtime: Runtime, request: ResourceRequest, item: WorkItem, receipt: OperationalCompletion) {
  await runtime.ledger.updateIfChanged(item.id, current => {
    requireReceipt(current, request, receipt);
    if (current.status === 'landed' && !current.activeRunner) return undefined;
    if (!['working', 'landed'].includes(current.status) || current.activeRunner) throw new Error('operational_work_not_running');
    return { ...current, status: 'landed', reason: 'operational_goal_verified' };
  });
}

async function projectRequest(runtime: Runtime, request: ResourceRequest, item: WorkItem, receipt: OperationalCompletion) {
  const latest = await runtime.ledger.get(item.id);
  requireReceipt(latest, request, receipt);
  if (latest.status !== 'landed' || latest.activeRunner) throw new Error('operational_work_changed');
  return runtime.requests.updateIfChanged(request.id, current => {
    requireReceipt(latest, current, receipt);
    const saved = current.operation?.checkpoint?.operational;
    if (!saved || digest(saved) !== digest(receipt)) throw new Error('operational_receipt_changed');
    if (current.status === 'completed') return undefined;
    if (current.status !== 'work-running') throw new Error('operational_request_not_running');
    return { ...current, status: 'completed', reason: `${item.id}: operational_goal_verified` };
  });
}

async function completionNotice(runtime: Runtime, request: ResourceRequest, item: WorkItem, receipt: OperationalCompletion) {
  await recordCompletedEvidence(runtime, item, receipt);
  const noticeId = ownerMessageId(['operational-completed', request.id, digest(receipt)]);
  for (const owner of new Set([request.from, item.owner])) {
    await runtime.notebook(owner).journalOnce({ source: noticeId, kind: 'request-completed', workItem: item.id,
      note: `${request.id}: original operational goal verified by configured host checks and ${receipt.review.reviewer}; no PR.` }, receipt.completedAt);
  }
  await queueNotice(runtime, { id: noticeId,
    owner: request.from, workItem: item.id, change: 'operational-completed', origin: request.origin,
    text: `Request ${request.id}, work ${item.id}: the exact original operational goal passed configured host checks and independent review by ${receipt.review.reviewer}. `
      + `No PR was created. ${receipt.effects.length} gated resource cleanup postconditions were observed. Evidence: onionsoup_status request=${request.id}.`,
    at: receipt.completedAt });
  await runtime.requests.updateIfChanged(request.id, current => current.operation?.checkpoint?.operationalNoticeQueued
    ? undefined : { ...current, operation: { ...current.operation!,
      checkpoint: { ...current.operation?.checkpoint, operationalNoticeQueued: true } } });
}

/** Durable receipt first, then repairable ledger/request projections and one addressed requester continuation. */
export async function reconcileOperationalWork(runtime: Runtime, request: ResourceRequest, item: WorkItem) {
  const receipt = request.operation?.checkpoint?.operational;
  if (!receipt) return undefined;
  requireReceipt(item, request, receipt);
  await requireCaller(runtime, item, item.owner, receipt.execution);
  if (runtime.family(receipt.review.reviewer) === runtime.family(runtime.owner(item.owner).model)) {
    throw new Error('operational_goal_review_not_independent');
  }
  await projectLedger(runtime, request, item, receipt);
  const completed = await projectRequest(runtime, request, item, receipt);
  await completionNotice(runtime, request, item, receipt);
  return completed;
}

/** Missing legacy evidence is owner work, not a fabricated completion or a new human decision. */
export async function queueOperationalReverification(runtime: Runtime, request: ResourceRequest, item: WorkItem, reason: string) {
  await queueNotice(runtime, { id: ownerMessageId(['operational-reverify', request.id, item.id, item.planDocument?.digest, reason]),
    owner: item.owner, workItem: item.id, change: 'operational-reverify', origin: item.session,
    text: `Reverify original request ${request.id}, work ${item.id}. Missing prerequisite: ${reason}. `
      + `Use onionsoup_complete_work from this work's execution session after the ORIGINAL goal's configured checks pass. `
      + 'Recover exact host resource request origins, create/delete approvals, managed request identity and successful follow-up records; positively observe deletion. '
      + 'Model reports or arbitrary resource IDs are not evidence. Do not create resources just to manufacture proof. '
      + 'If checks are not configured or real legacy records are unavailable, report precisely what the owner must obtain; no human completion approval is required.',
    at: new Date().toISOString() });
}

/** Existing owner intent addresses the original work; no fabricated evidence or replacement request. */
export async function reverifyOperationalWork(runtime: Runtime, owner: string, itemId: string) {
  const item = await runtime.ledger.get(itemId);
  if (item.owner !== owner || !runtime.owner(owner).persona || !item.request) throw new Error('operational_item_not_yours');
  const request = await runtime.requests.get(item.request);
  requireBinding(item, request);
  if (!['working', 'landed'].includes(item.status) || request.status !== 'work-running' || item.activeRunner) {
    throw new Error('operational_work_not_running');
  }
  await queueOperationalReverification(runtime, request, item, 'fresh_original_goal_evidence_required');
  return { item: item.id, request: request.id, outcome: 'owner-reverification-queued' };
}

async function checkpointCompletion(runtime: Runtime, item: WorkItem, active: ResourceRequest, origin: ChatOrigin) {
  const receipt = await verifyCompletion(runtime, item, active, origin);
  const latest = await runtime.ledger.get(item.id);
  requireReceipt(latest, active, receipt);
  if (!['working', 'landed'].includes(latest.status) || latest.activeRunner
    || configurationDigest(runtime, latest) !== receipt.configurationDigest) throw new Error('operational_work_changed');
  const snapshot = await sourceSnapshot(runtime, latest, origin);
  if (snapshot.directory !== receipt.source.directory || snapshot.head !== receipt.source.head || snapshot.tree !== receipt.source.tree) {
    throw new Error('operational_source_changed');
  }
  const checkpointed = await runtime.requests.update(active.id, current => {
    requireReceipt(latest, current, receipt);
    if (current.operation?.id !== active.operation!.id || current.status !== 'work-running') {
      throw new Error('operational_request_changed');
    }
    return { ...current, operation: { ...current.operation, runner: undefined,
      checkpoint: { operationalOrigin: origin, operational: receipt } } };
  });
  return reconcileOperationalWork(runtime, checkpointed, latest);
}

async function completionAttempt(runtime: Runtime, item: WorkItem, active: ResourceRequest, origin: ChatOrigin) {
  try {
    return await checkpointCompletion(runtime, item, active, origin);
  } catch (error) {
    const reason = error instanceof Error && /^operational_[a-z_]+$/.test(error.message)
      ? error.message : 'operational_verification_unavailable';
    const previous = await readRequestWorkEvidence(runtime, item).catch(() => undefined);
    const attempt = previous?.planDigest === item.planDocument?.digest ? previous : undefined;
    await recordRequestWorkEvidence(runtime, item, { stage: 'blocked', blocker: reason,
      verification: attempt?.verification, review: attempt?.review });
    await queueOperationalReverification(runtime, active, item, reason);
    throw error;
  } finally {
    await runtime.requests.updateIfChanged(active.id, current => current.operation?.id === active.operation!.id && current.operation.runner
      ? { ...current, operation: { ...current.operation, runner: undefined } } : undefined);
  }
}

/** Tool arguments select only work; caller identity/session and resource scope are host-observed. */
export async function completeOperationalWork(runtime: Runtime, owner: string, itemId: string, origin: ChatOrigin) {
  const item = await runtime.ledger.get(itemId);
  await requireCaller(runtime, item, owner, origin);
  if (!item.request) throw new Error('operational_requires_original_request');
  const request = await runtime.requests.get(item.request);
  requireBinding(item, request);
  if (request.operation?.checkpoint?.operational) return reconcileOperationalWork(runtime, request, item);
  if (!['working', 'landed'].includes(item.status) || item.activeRunner || request.status !== 'work-running') {
    throw new Error('operational_work_not_running');
  }
  const operation = { id: randomUUID(), stage: 'work-running' as const, startedAt: new Date().toISOString(),
    runner: process.pid, checkpoint: { operationalOrigin: origin } };
  const active = await runtime.requests.update(request.id, current => {
    if (current.operation?.runner || current.status !== 'work-running') throw new Error('operational_request_busy');
    return { ...current, operation };
  });
  return completionAttempt(runtime, item, active, origin);
}

/** Release selects an existing request in the caller's exact execution context; gates are unchanged. */
export async function releaseOperationalInstance(runtime: Runtime, owner: string, requestId: string, origin: ChatOrigin) {
  return runtime.requests.update(requestId, request => {
    if (request.from !== owner || !sameOrigin(request.origin, origin) || request.ask.kind !== 'instance'
      || request.status !== 'provisioned') throw new Error('operational_release_scope_mismatch');
    return { ...request, status: request.leaseIncludesDelete ? 'delete-approved' : 'awaiting-delete-approval' };
  });
}
