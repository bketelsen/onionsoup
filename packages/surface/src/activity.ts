import { z } from 'zod';

/**
 * What an owner's chats are doing right now, for the rail: a prompt or question stopped on the person, a session
 * busy in opencode, or nothing. Waiting comes first: a waiting session is stopped until the person answers.
 */
export const OwnerActivity = z.enum(['waiting', 'working', 'idle']);
export type OwnerActivity = z.infer<typeof OwnerActivity>;

/** Signals the surface already reads for its inbox, per owner. */
export interface ActivitySignals { isWaiting: boolean; isWorking: boolean }

const ACTIVITY_PRECEDENCE: readonly [OwnerActivity, (signals: ActivitySignals) => boolean][] = [
  ['waiting', signals => signals.isWaiting],
  ['working', signals => signals.isWorking],
];

export function ownerActivity(signals: ActivitySignals): OwnerActivity {
  return ACTIVITY_PRECEDENCE.find(([, applies]) => applies(signals))?.[0] ?? 'idle';
}

/** opencode's session status per session id, parsed at the edge; only the kind matters here. */
const SessionStatuses = z.record(z.string(), z.looseObject({ type: z.string() })).catch({});

/** Kinds of opencode session status that mean the session is running a turn. */
const BUSY_STATUS_TYPES = new Set(['busy', 'retry']);

export function hasBusySession(status: unknown) {
  return Object.values(SessionStatuses.parse(status)).some(entry => BUSY_STATUS_TYPES.has(entry.type));
}
