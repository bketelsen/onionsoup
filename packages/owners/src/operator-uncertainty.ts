import type { OperatorChild, OperatorJob } from './operator-jobs-types.ts';
import { operatorJobEvent } from './operator-jobs.ts';

export const OPERATOR_UNCERTAINTY_LIMITS = { observations: 3, intervalMs: 15_000, durationMs: 120_000 };
type Limits = typeof OPERATOR_UNCERTAINTY_LIMITS;

/** A budget ends automatic observation, never the reservation or the possibly running attempt. */
export function recordOperatorUncertainty(job: OperatorJob, child: OperatorChild,
  kind: NonNullable<OperatorChild['uncertainty']>['kind'], reason: string, now = new Date(), limits: Limits = OPERATOR_UNCERTAINTY_LIMITS) {
  const prior = child.uncertainty;
  if (prior?.needsDecision) return;
  const observations = (prior?.observations ?? 0) + 1;
  const since = prior?.since ?? now.toISOString();
  const needsDecision = observations >= limits.observations || now.getTime() - Date.parse(since) >= limits.durationMs;
  child.uncertainty = { kind, since, observations, lastObservedAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + limits.intervalMs).toISOString(), needsDecision, reason };
  if (needsDecision) operatorJobEvent(job, 'blocked',
    'Runtime outcome remains unknown after bounded observation. Reservation retained; inspect recovery-preview for an explicit human decision. No replacement will be launched.', child.id);
}

export function canObserveOperatorChild(child: OperatorChild, now = new Date()) {
  if (child.status === 'abandoned') return false;
  return !child.uncertainty || (!child.uncertainty.needsDecision && Date.parse(child.uncertainty.nextCheckAt) <= now.getTime());
}

export function clearOperatorUncertainty(child: OperatorChild) {
  delete child.uncertainty;
}
