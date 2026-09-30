import { createHash, randomUUID } from 'node:crypto';
import { OperatorJobs, operatorJobEvent } from './operator-jobs.ts';
import type { OperatorChild, OperatorJob, OperatorJobLedger } from './operator-jobs-types.ts';
import { recordOperatorUncertainty } from './operator-uncertainty.ts';

export const OPERATOR_OPERATION_LIMITS = { leaseMs: 45_000, observationsPerTick: 16 };
export const OPERATOR_TERMINAL_JOBS = new Set<OperatorJob['status']>(['completed', 'cancelled']);
export const OPERATOR_TERMINAL_CHILDREN = new Set<OperatorChild['status']>(['completed', 'cancelled', 'abandoned']);
export const OPERATOR_CREATION_BLOCKERS = new Set(['operator_child_creation_uncertain', 'operator_child_creation_ambiguous',
  'operator_child_creation_runtime_unavailable']);
type OperationKind = NonNullable<OperatorChild['operation']>['kind'];
export interface OperatorClaim { job: OperatorJob; child: OperatorChild; token: string }
type Mutation = (job: OperatorJob, child: OperatorChild, ledger: OperatorJobLedger) => void;
type Preparation = (job: OperatorJob, child: OperatorChild, ledger: OperatorJobLedger) => boolean;

export function operatorChildVersion(job: OperatorJob, child: OperatorChild) {
  return createHash('sha256').update(JSON.stringify({ origin: job.origin, goal: job.goal, intake: job.intake,
    constraints: job.constraints, scope: job.scope, control: operatorParentControlVersion(job), child })).digest('hex');
}

export function operatorParentControlVersion(job: OperatorJob) {
  return job.events.filter(event => !event.childID && ['paused', 'resumed', 'cancelled'].includes(event.kind))
    .map(event => event.id).join(':');
}

export function operatorChildUnsettled(child: OperatorChild) {
  return child.attempts.some(attempt => !attempt.endedAt);
}

export function operatorChildOccupiesSlot(child: OperatorChild) {
  if (OPERATOR_TERMINAL_CHILDREN.has(child.status)) return false;
  return (child.status === 'queued' && child.operation?.kind === 'observe')
    || ['creating', 'dispatching', 'running'].includes(child.status) || operatorChildUnsettled(child)
    || OPERATOR_CREATION_BLOCKERS.has(child.blocker ?? '') || child.uncertainty?.kind === 'creation';
}

export function operatorChildBlock(job: OperatorJob, child: OperatorChild, reason: string) {
  if (child.status === 'blocked' && child.blocker === reason) return;
  child.status = 'blocked';
  child.blocker = reason;
  operatorJobEvent(job, 'blocked', reason, child.id);
}

export function settleOperatorJob(job: OperatorJob) {
  if (job.status === 'paused' || OPERATOR_TERMINAL_JOBS.has(job.status)) return;
  if (job.children.every(child => child.status === 'completed')) {
    if (job.status !== 'needs-synthesis') operatorJobEvent(job, 'ready', 'All child transcripts are complete; synthesize against their exact evidence IDs.');
    job.status = 'needs-synthesis';
    return;
  }
  job.status = job.children.some(child => ['blocked', 'abandoned'].includes(child.status)) ? 'blocked' : 'running';
}

/** Only short file transactions live here. Runtime calls belong to the caller, after a durable claim returns. */
export class OperatorScheduler {
  constructor(readonly jobs: OperatorJobs, readonly leaseMs = OPERATOR_OPERATION_LIMITS.leaseMs) {}

  async claim(job: OperatorJob, child: OperatorChild, kind: OperationKind, prepare: Preparation = () => true) {
    return this.jobs.transaction(async (ledger, save) => {
      const current = this.find(ledger, job, child);
      if (!current || current.child.operation || operatorChildVersion(current.job, current.child) !== operatorChildVersion(job, child)) return;
      if (!prepare(current.job, current.child, ledger)) return;
      const claim = this.assign(current.job, current.child, kind);
      await save();
      return claim;
    });
  }

  async apply(claim: OperatorClaim, mutate: Mutation) {
    return this.jobs.transaction(async (ledger, save) => {
      const current = this.match(ledger, claim);
      if (!current) return false;
      mutate(current.job, current.child, ledger);
      delete current.child.operation;
      settleOperatorJob(current.job);
      await save();
      return true;
    });
  }

  async advance(claim: OperatorClaim, kind: OperationKind, prepare: Preparation) {
    return this.jobs.transaction(async (ledger, save) => {
      const current = this.match(ledger, claim);
      if (!current) return;
      if (operatorParentControlVersion(current.job) !== operatorParentControlVersion(claim.job)
        || !prepare(current.job, current.child, ledger)) {
        delete current.child.operation;
        settleOperatorJob(current.job);
        await save();
        return;
      }
      const next = this.assign(current.job, current.child, kind);
      await save();
      return next;
    });
  }

  async expire() {
    return this.jobs.transaction(async (ledger, save) => {
      let changed = false;
      for (const job of ledger.jobs) {
        if (job.origin.operator !== this.jobs.operator || OPERATOR_TERMINAL_JOBS.has(job.status)) continue;
        for (const child of job.children) {
          const operation = child.operation;
          if (!operation || Date.parse(operation.expiresAt) > Date.now() || OPERATOR_TERMINAL_CHILDREN.has(child.status)) continue;
          if (child.blocker === 'operator_child_foreign_work') {
            delete child.operation;
            changed = true;
            continue;
          }
          const kinds: Record<OperationKind, 'creation' | 'dispatch' | 'observation'> = {
            create: 'creation', dispatch: 'dispatch', observe: 'observation', adopt: 'creation', abort: 'observation', retry: 'observation',
          };
          operatorChildBlock(job, child, 'operator_child_operation_expired');
          recordOperatorUncertainty(job, child, kinds[operation.kind], 'operator_child_operation_expired');
          delete child.operation;
          changed = true;
        }
        settleOperatorJob(job);
      }
      if (changed) await save();
    });
  }

  private find(ledger: OperatorJobLedger, job: OperatorJob, child: OperatorChild) {
    const currentJob = ledger.jobs.find(candidate => candidate.id === job.id && candidate.origin.operator === this.jobs.operator);
    const currentChild = currentJob?.children.find(candidate => candidate.id === child.id);
    if (!currentJob || !currentChild || OPERATOR_TERMINAL_JOBS.has(currentJob.status) || OPERATOR_TERMINAL_CHILDREN.has(currentChild.status)) return;
    return { job: currentJob, child: currentChild };
  }

  private match(ledger: OperatorJobLedger, claim: OperatorClaim) {
    const current = this.find(ledger, claim.job, claim.child);
    return current?.child.operation?.token === claim.token ? current : undefined;
  }

  private assign(job: OperatorJob, child: OperatorChild, kind: OperationKind): OperatorClaim {
    const token = randomUUID();
    child.operation = { token, kind, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.leaseMs).toISOString() };
    return structuredClone({ job, child, token });
  }
}
