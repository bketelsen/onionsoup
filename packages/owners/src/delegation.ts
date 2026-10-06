import { createHash } from 'node:crypto';
import type { ChatOrigin } from './chat-origin.ts';
import type { AttentionProvenance } from './journal-record.ts';
import { ProposedWork } from './artifacts.ts';
import { canChange, isDirectReport } from './declarations.ts';
import { completeAcceptedRequest } from './request-closure-completion.ts';
import { queueOperationalReverification, reconcileOperationalWork } from './operational-work.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { PublishDecision, requireStatus, type ResourceRequest, type WorkAsk, type OperatorAssignmentSource } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { isPaused } from './ledger.ts';

export async function journalRequest(
  runtime: Runtime, request: ResourceRequest, kind: string, note: string, provenance?: AttentionProvenance,
) {
  if (kind === 'attention' && !provenance) throw new Error('request_attention_provenance_required');
  for (const ownerId of new Set([request.from, request.to])) {
    const notebook = runtime.notebook(ownerId);
    await notebook.journal({
      kind, note: `${request.id} (${request.from} → ${request.to}): ${note}`,
      provenance,
    });
    await notebook.commit(`journal ${request.id}`);
  }
}

/** Delegation chooses an existing receiver that changes its own repository; it never grants new authority. */
export async function requestWork(runtime: Runtime, from: string, to: string, proposal: ProposedWork, origin?: ChatOrigin) {
  runtime.owner(from);
  const receiver = runtime.owner(to);
  if (!canChange(receiver)) throw new Error(`owner_cannot_change: ${to} does not change its repository itself`);
  runtime.repositoryOwner(to, proposal.repository);
  const request = await runtime.requests.open(from, to, { kind: 'work', purpose: proposal.goal, proposal }, 'none', origin);
  await journalRequest(runtime, request, 'request-opened', proposal.title);
  return request;
}

export function operatorWorkRequestId(source: OperatorAssignmentSource) {
  return `r-handoff-${createHash('sha256').update(JSON.stringify(['operator-assignment-v1', source.kind, source.id])).digest('hex')}`;
}

/** Caller persists explicit human intent first. Self-request avoids impersonating a manager or another owner. */
export function openOperatorWorkRequest(runtime: Runtime, source: OperatorAssignmentSource, by: string,
  to: string, proposal: ProposedWork) {
  return runtime.requests.openIdentified(operatorWorkRequestId(source), to, to,
    { kind: 'work', purpose: proposal.goal, proposal, operatorAssignment: { by, source } }, 'none', undefined, () => {
      const receiver = runtime.owner(to);
      if (!canChange(receiver)) throw new Error(`owner_cannot_change: ${to}`);
      runtime.repositoryOwner(to, proposal.repository);
    });
}

/** Host-selected self-work retains the ordinary plan gate and creates no human/manager approval. */
export function openFrictionWorkRequest(runtime: Runtime, id: string, digest: string, to: string, proposal: ProposedWork) {
  return runtime.requests.openIdentified(operatorWorkRequestId({ kind: 'friction', id }), to, to,
    { kind: 'work', purpose: proposal.goal, proposal, ownerFollowUp: { kind: 'friction', id, digest } }, 'none', undefined, () => {
      const receiver = runtime.owner(to);
      if (!canChange(receiver)) throw new Error(`owner_cannot_change: ${to}`);
      runtime.repositoryOwner(to, proposal.repository);
    });
}

type Acceptance = (runtime: Runtime, request: ResourceRequest, ask: WorkAsk) => Promise<PublishDecision>;

/** Who decides: work from the receiver's declared manager is accepted as assigned; a peer's is weighed by the receiver. */
const ACCEPTANCE: Record<'manager' | 'peer', Acceptance> = {
  manager: async (_runtime, request) => ({
    decision: 'accept', reply: `assigned by ${request.from}, ${request.to}'s manager; accepted automatically (push back with onionsoup_send)`,
  }),
  peer: async (runtime, request, ask) => {
    const owner = runtime.owner(request.to);
    const notebook = runtime.notebook(owner.id);
    const requester = ask.operatorAssignment
      ? `The person ${ask.operatorAssignment.by} explicitly assigned this work from ${ask.operatorAssignment.source.kind} ${ask.operatorAssignment.source.id}.`
      : `Owner ${request.from} requests this work in your declared domain.`;
    return (await runtime.hire(owner.id, {
      role: 'owner', model: owner.model, directory: owner.workspace, title: `${request.id}: decide work`,
      brief: `${requester} Accept if appropriate, or decline with a reason. If you accept, you plan it yourself and the plan waits for approval like any other.\n${JSON.stringify(ask.proposal)}\n${await notebook.orientation()}`,
      schema: PublishDecision,
    })).value;
  },
};

/** Auto-accepted work hires nobody on the manager's side, so only the receiving owner is reserved while it runs. */
export function requestParticipants(runtime: Runtime, request: ResourceRequest) {
  const isAssigned = request.ask.kind === 'work' && isDirectReport(runtime.declarations, request.from, request.to);
  return new Set(isAssigned ? [request.to] : [request.from, request.to]);
}

/** Receiver decisions precede the ordinary work-item plan approval gate. */
export async function decideWork(runtime: Runtime, request: ResourceRequest) {
  requireStatus(request, 'pending-owner');
  if (request.ask.kind !== 'work') throw new Error('not_a_work_request');
  const workItem = `w-request-${request.id}`;
  const existing = (await runtime.ledger.list()).find(item => item.id === workItem);
  if (existing) return runtime.requests.save({ ...request, status: isPaused(existing) ? 'work-paused' : 'work-running', workItem });
  const owner = runtime.owner(request.to);
  await runtime.notebook(owner.id).ensure(await runtime.text(`charters/${owner.id}.md`));
  const relation = isDirectReport(runtime.declarations, request.from, request.to) ? 'manager' : 'peer';
  const decision = await ACCEPTANCE[relation](runtime, request, request.ask);
  if (decision.decision === 'decline') {
    const declined = await runtime.requests.save({ ...request, status: 'declined', publishDecision: decision, reason: decision.reply });
    await journalRequest(runtime, declined, 'attention',
      `delegation declined: ${decision.reply}; the person can resolve or redirect it`,
      { kind: 'delegation', request: declined.id, workItem: declined.workItem });
    return declined;
  }
  if (!canChange(owner)) throw new Error(`owner_cannot_change: ${owner.id} does not change its repository itself`);
  runtime.repositoryOwner(owner.id, request.ask.proposal.repository);
  // Deterministic identity closes the crash window between ledger creation and saving the request link. The owner
  // plans it in a session the plugin opens for it; its plan is approved in the inbox or under a manager's grant.
  await runtime.ledger.create(owner.id, OWNER_CHANGE_WORKFLOW, request.ask.proposal, {
    id: workItem, status: 'planning', request: request.id,
  });
  const accepted = await runtime.requests.save({ ...request, status: 'work-running', workItem, publishDecision: decision });
  await journalRequest(runtime, accepted, 'request-accepted', `${decision.reply}; linked work ${workItem}`);
  return accepted;
}

export async function trackDelegatedWork(runtime: Runtime, request: ResourceRequest) {
  if (!request.workItem) throw new Error('delegation_work_item_missing');
  const item = await runtime.ledger.get(request.workItem);
  if (isPaused(item)) {
    return request.status === 'work-paused' ? request
      : runtime.requests.update(request.id, current =>
        current.workItem !== item.id || !['work-running', 'work-paused'].includes(current.status) ? current
          : { ...current, status: 'work-paused', reason: item.reason });
  }
  if (request.status === 'work-paused') {
    request = await runtime.requests.update(request.id, current => current.status !== 'work-paused' ? current
      : { ...current, status: 'work-running', reason: undefined });
  }
  const operational = await reconcileOperationalWork(runtime, request, item);
  if (operational) return operational;
  if (item.status === 'landed' && !item.publication && !item.rebaseOf
    && !item.requestAcceptance && !item.externalPrObservations?.length && !item.deskPublication) {
    await queueOperationalReverification(runtime, request, item, 'legacy_operational_host_evidence_missing');
    return request;
  }
  if (item.requestAcceptance) return completeAcceptedRequest(runtime, item.id);
  const failed = new Set(['failed', 'rejected', 'cancelled']).has(item.status) || item.publication?.state === 'closed';
  const completed = item.publication?.state === 'merged' || (item.status === 'landed' && Boolean(item.rebaseOf));
  if (!failed && !completed) return request;
  const status = failed ? 'failed' : 'completed';
  const reason = `${request.workItem}: ${item.publication?.state ?? item.status}${item.reason ? `: ${item.reason}` : ''}`;
  const updated = await runtime.requests.save({ ...request, status, reason });
  await journalRequest(runtime, updated, failed ? 'attention' : 'request-completed', reason,
    failed ? { kind: 'delegation', request: updated.id, workItem: updated.workItem } : undefined);
  return updated;
}
