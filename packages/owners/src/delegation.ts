import { ProposedWork } from './artifacts.ts';
import { isDirectReport } from './declarations.ts';
import type { AssignmentRef } from './initiatives.ts';
import { PublishDecision, requireStatus, type ResourceRequest, type WorkAsk } from './requests.ts';
import type { Runtime } from './runtime.ts';

export async function journalRequest(runtime: Runtime, request: ResourceRequest, kind: string, note: string) {
  for (const ownerId of new Set([request.from, request.to])) {
    const notebook = runtime.notebook(ownerId);
    await notebook.journal({ kind, note: `${request.id} (${request.from} → ${request.to}): ${note}` });
    await notebook.commit(`journal ${request.id}`);
  }
}

/** Delegation chooses an existing receiver and its existing workflow; it never grants new authority. */
export async function requestWork(runtime: Runtime, from: string, to: string, proposal: ProposedWork, assignment?: AssignmentRef) {
  runtime.owner(from);
  const receiver = runtime.owner(to);
  if (!receiver.workflow) throw new Error(`owner_has_no_workflow: ${to}`);
  runtime.repositoryOwner(to, proposal.repository);
  const request = await runtime.requests.open(from, to, { kind: 'work', purpose: proposal.goal, proposal, assignment }, 'none');
  await journalRequest(runtime, request, 'request-opened', proposal.title);
  return request;
}

type Acceptance = (runtime: Runtime, request: ResourceRequest, ask: WorkAsk) => Promise<PublishDecision>;

/** Who decides: work from the receiver's declared manager is accepted as assigned; a peer's is weighed by the receiver. */
const ACCEPTANCE: Record<'manager' | 'peer', Acceptance> = {
  manager: async (_runtime, request) => ({
    decision: 'accept', reply: `assigned by ${request.from}, ${request.to}'s manager; accepted automatically (push back with onionsoup_raise)`,
  }),
  peer: async (runtime, request, ask) => {
    const owner = runtime.owner(request.to);
    const notebook = runtime.notebook(owner.id);
    return (await runtime.hire(owner.id, {
      role: 'owner', model: owner.model, directory: owner.workspace, title: `${request.id}: decide work`,
      brief: `Owner ${request.from} requests this work in your declared domain. Accept if appropriate, or decline with a reason. Acceptance opens work at the normal plan gate.\n${JSON.stringify(ask.proposal)}\n${await notebook.orientation()}`,
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
  if (existing) return runtime.requests.save({ ...request, status: 'work-running', workItem });
  const owner = runtime.owner(request.to);
  await runtime.notebook(owner.id).ensure(await runtime.text(`charters/${owner.id}.md`));
  const relation = isDirectReport(runtime.declarations, request.from, request.to) ? 'manager' : 'peer';
  const decision = await ACCEPTANCE[relation](runtime, request, request.ask);
  if (decision.decision === 'decline') {
    const declined = await runtime.requests.save({ ...request, status: 'declined', publishDecision: decision, reason: decision.reply });
    await journalRequest(runtime, declined, 'attention', `delegation declined: ${decision.reply}; the person can resolve or redirect it`);
    return declined;
  }
  if (!owner.workflow) throw new Error(`owner_has_no_workflow: ${owner.id}`);
  runtime.repositoryOwner(owner.id, request.ask.proposal.repository);
  // Deterministic identity closes the crash window between ledger creation and saving the request link.
  await runtime.ledger.create(owner.id, owner.workflow, request.ask.proposal, { id: workItem, assignment: request.ask.assignment });
  const accepted = await runtime.requests.save({ ...request, status: 'work-running', workItem, publishDecision: decision });
  await journalRequest(runtime, accepted, 'request-accepted', `${decision.reply}; linked work ${workItem}`);
  return accepted;
}

export async function trackDelegatedWork(runtime: Runtime, request: ResourceRequest) {
  if (!request.workItem) throw new Error('delegation_work_item_missing');
  const item = await runtime.ledger.get(request.workItem);
  const failed = new Set(['failed', 'rejected', 'cancelled']).has(item.status) || item.publication?.state === 'closed';
  const completed = item.publication?.state === 'merged' || (item.status === 'landed' && Boolean(item.rebaseOf));
  if (!failed && !completed) return request;
  const status = failed ? 'failed' : 'completed';
  const reason = `${request.workItem}: ${item.publication?.state ?? item.status}${item.reason ? `: ${item.reason}` : ''}`;
  const updated = await runtime.requests.save({ ...request, status, reason });
  await journalRequest(runtime, updated, failed ? 'attention' : 'request-completed', reason);
  return updated;
}
