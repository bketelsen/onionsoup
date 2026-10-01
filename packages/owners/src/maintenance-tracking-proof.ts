import { isAbsolute } from 'node:path';
import { delegatedWorkOutcome } from './delegation.ts';
import type { WorkItem } from './ledger.ts';
import { operatorJobWakeCandidate, type Wake } from './operator-job-wake.ts';
import type { OperatorJob } from './operator-jobs-types.ts';
import { neededSession } from './owner-sessions.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import type { ResourceRequest } from './requests.ts';
import { isRunnable } from './work-recovery.ts';

/** Pure cross-record proof, valid only inside the inventory's unchanged-byte fence.
 * This preserves an open request; it does not attest session idleness or accepted completion.
 * The approved plan's goal is deliberately not substituted for the original proposal's goal. */
export function trackingRequestPreserved(request: ResourceRequest, item: WorkItem | undefined): boolean {
  if (!item || request.status !== 'work-running' || request.ask.kind !== 'work' || request.followUp !== 'none') return false;
  if (request.operation?.runner !== undefined || item.activeRunner !== undefined) return false;
  if (request.operation && request.operation.stage !== 'work-running') return false;
  if (request.workItem !== item.id || item.request !== request.id || item.owner !== request.to) return false;
  if (item.workflow !== OWNER_CHANGE_WORKFLOW || !['working', 'landed'].includes(item.status)) return false;
  if (request.ask.proposal.repository !== item.proposal.repository || request.ask.proposal.goal !== item.proposal.goal) return false;
  if (!item.session?.sessionID || !isAbsolute(item.session.directory)) return false;
  if (item.planWorktree && item.planWorktree !== item.session.directory) return false;
  if (item.deskPublication && item.deskPublication.stage !== 'complete') return false;
  return !delegatedWorkOutcome(item) && !neededSession(item) && !isRunnable(item);
}

/** Delivery only selects the latest actionable event, never an old unsent row by itself.
 * The current job must have no candidate at all; a new actionable event is not exempted.
 * Submitted or uncertain deliveries retain their separate receipt-proof requirements. */
export function obsoleteUnsubmittedWake(wake: Wake, job: OperatorJob | undefined): boolean {
  if (!job || wake.messageID !== undefined || wake.status !== 'pending' || wake.reason !== undefined) return false;
  if (wake.jobID !== job.id || wake.origin.operator !== job.origin.operator
    || wake.origin.sessionID !== job.origin.sessionID || wake.origin.directory !== job.origin.directory) return false;
  if (wake.revision < 1 || wake.revision >= job.revision || !/^[a-f0-9]{64}$/.test(wake.digest)) return false;
  const position = job.events.findIndex(event => event.id === wake.eventID);
  if (position < 0 || position >= job.events.length - 1) return false;
  if (job.revision !== job.events.length || wake.revision !== position + 1) return false;
  if (new Set(job.events.map(event => event.id)).size !== job.events.length) return false;
  const previous = job.events[position]!;
  const oldCandidate = operatorJobWakeCandidate({ ...job, status: 'running', events: [previous] });
  return Boolean(oldCandidate) && operatorJobWakeCandidate(job) === undefined;
}
