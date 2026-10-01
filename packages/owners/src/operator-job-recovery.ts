import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ToolContext } from '@opencode-ai/plugin';
import { type OperatorChild, type OperatorJob, type OperatorJobOrigin,
  type OperatorSupervisorClient, type OperatorRecoveryPermissionProof } from './operator-jobs-types.ts';
import { OperatorJobs, operatorJobEvent } from './operator-jobs.ts';
import type { OperatorRecoveryPermissions } from './operator-recovery-permission.ts';
import { operatorChildBlock, settleOperatorJob } from './operator-scheduler.ts';
import { operatorWriteHasNoEffects } from './operator-write-state.ts';

export const OPERATOR_RECOVERY_LIMITS = { observationMs: 10_000, noteChars: 2_000 };
const WARNING = 'The outcome is unknown. Abandoning releases only this scheduling reservation; it does not prove '
  + 'that an earlier model turn stopped. That turn may still finish, so physical concurrency may temporarily exceed '
  + 'the two managed slots. The child will never be relaunched or accepted as completed. History remains preserved. '
  + 'Any replacement requires a separate explicit user request; this action creates no replacement or persistent grant.';

function recoveryWarning(job: OperatorJob, child: OperatorChild) {
  if (child.access !== 'write') return WARNING;
  return `Release only zero-write child ${job.id}/${child.id}, original goal ${JSON.stringify(job.goal)}, `
    + `child goal ${JSON.stringify(child.goal)}, `
    + `in ${child.directory}, approved files ${JSON.stringify(child.files)}. Fresh runtime evidence must prove absence `
    + 'or idle owned history with all tools terminal. Human approval releases this workspace reservation and revokes '
    + 'future managed writes for this child. It creates no replacement and does not accept the task as completed. '
    + 'Original approval, attempts and history remain preserved; no persistent grant is added.';
}

function writeCanRelease(child: OperatorChild) {
  return operatorWriteHasNoEffects(child) && !child.write?.acceptance
    && ['queued', 'blocked', 'needs-review'].includes(child.status) && !child.operation;
}

function boundChild(job: OperatorJob, childID: string) {
  const child = job.children.find(candidate => candidate.id === childID);
  if (!child) throw new Error('operator_recovery_child_missing');
  return child;
}

/** Poll counts/timestamps are observations, not a new scope of human approval. */
export function operatorRecoveryDigest(job: OperatorJob, child: OperatorChild) {
  return createHash('sha256').update(JSON.stringify({
    job: job.id, origin: job.origin, intake: job.intake, goal: job.goal, constraints: job.constraints, status: job.status,
    child: { id: child.id, goal: child.goal, directory: child.directory, access: child.access, dependsOn: child.dependsOn,
      title: child.title, sessionID: child.sessionID, status: child.status, attempts: child.attempts,
      files: child.files, write: child.write, evidence: child.evidence, abandonment: child.abandonment, blocker: child.blocker,
      operation: child.operation ? { token: child.operation.token, kind: child.operation.kind } : undefined,
      uncertainty: child.uncertainty ? { kind: child.uncertainty.kind, reason: child.uncertainty.reason,
        needsDecision: child.uncertainty.needsDecision } : undefined },
  })).digest('hex');
}

type Observation = 'absent' | 'unavailable' | 'receipt-present' | 'foreign-work' | 'busy' | 'idle-owned';
async function observe(child: OperatorChild, client: OperatorSupervisorClient): Promise<Observation> {
  const options = { signal: AbortSignal.timeout(OPERATOR_RECOVERY_LIMITS.observationMs) };
  try {
    if (!child.sessionID) {
      const candidates = (await client.listSessions(child.directory, options)).filter(session => session.title === child.title);
      return candidates.length ? 'receipt-present' : 'absent';
    }
    const snapshot = await client.readSession(child.directory, child.sessionID, options);
    const attempt = child.attempts.at(-1);
    const users = snapshot.messages.filter(message => message.role === 'user');
    if (users.some(message => !child.attempts.some(previous => previous.messageID === message.id))) return 'foreign-work';
    if (child.access === 'write') {
      const known = new Set(child.attempts.map(previous => previous.messageID));
      if (snapshot.messages.some(message => message.role === 'assistant'
        && (!message.parentID || !known.has(message.parentID)))) return 'foreign-work';
      if (snapshot.status !== 'idle' || snapshot.messages.some(message =>
        message.tools.some(tool => ['pending', 'running'].includes(tool.status)))) return 'busy';
      return 'idle-owned';
    }
    if (attempt && users.some(message => message.id === attempt.messageID)) return 'receipt-present';
    return snapshot.status === 'idle' ? 'absent' : 'busy';
  } catch {
    return 'unavailable';
  }
}

export async function prepareOperatorRecovery(jobs: OperatorJobs, client: OperatorSupervisorClient,
  origin: OperatorJobOrigin, id: string, childID: string) {
  const job = await jobs.get(origin, id);
  const child = boundChild(job, childID);
  const warning = recoveryWarning(job, child);
  if (child.abandonment) return { jobID: id, childID, eligible: false, reason: 'already-abandoned',
    digest: child.abandonment.digest, warning, abandonment: child.abandonment };
  const digest = operatorRecoveryDigest(job, child);
  if (child.blocker === 'operator_child_foreign_work') {
    return { jobID: id, childID, digest, eligible: false, reason: 'foreign-work', warning };
  }
  if (child.access === 'write' && !writeCanRelease(child)) {
    return { jobID: id, childID, digest, eligible: false, reason: 'write-reservation-requires-verified-review', warning };
  }
  if (child.access !== 'write' && (child.status !== 'blocked' || !child.uncertainty?.needsDecision)) {
    return { jobID: id, childID, digest, eligible: false, reason: 'bounded-observation-not-exhausted', warning };
  }
  const observation = await observe(child, client);
  const current = await jobs.get(origin, id);
  if (operatorRecoveryDigest(current, boundChild(current, childID)) !== digest) throw new Error('operator_recovery_stale');
  if (observation === 'foreign-work') {
    const protectedDigest = await retainForeignObservation(jobs, origin, id, childID, digest);
    return { jobID: id, childID, digest: protectedDigest, eligible: false, reason: observation, warning };
  }
  const eligible = observation === 'absent' || (child.access === 'write' ? observation === 'idle-owned' : observation === 'unavailable');
  return { jobID: id, childID, digest, eligible, reason: observation, warning,
    sessionID: child.sessionID, title: child.title, attemptID: child.attempts.at(-1)?.id,
    promptID: child.attempts.at(-1)?.messageID, originalGoal: job.goal, constraints: job.constraints };
}

async function retainForeignObservation(jobs: OperatorJobs, origin: OperatorJobOrigin, id: string,
  childID: string, digest: string) {
  return jobs.transaction(async (ledger, save) => {
    const job = jobs.bound(ledger, origin, id);
    const child = boundChild(job, childID);
    if (operatorRecoveryDigest(job, child) !== digest) throw new Error('operator_recovery_stale');
    operatorChildBlock(job, child, 'operator_child_foreign_work');
    settleOperatorJob(job);
    await save();
    return operatorRecoveryDigest(job, child);
  });
}

type RecoveryContext = Pick<ToolContext, 'ask' | 'abort' | 'metadata' | 'sessionID' | 'messageID'>;
function checkContext(origin: OperatorJobOrigin, context: RecoveryContext) {
  if (context.sessionID !== origin.sessionID) throw new Error('operator_recovery_origin_mismatch');
  if (context.abort.aborted) throw new Error('operator_recovery_aborted');
}

async function recordDenial(jobs: OperatorJobs, origin: OperatorJobOrigin, id: string, childID: string, digest: string) {
  await jobs.transaction(async (ledger, save) => {
    const job = jobs.bound(ledger, origin, id);
    const child = boundChild(job, childID);
    if (child.abandonment || operatorRecoveryDigest(job, child) !== digest) return;
    operatorJobEvent(job, 'recovery-denied', 'The human permission did not authorize releasing this uncertain reservation.', childID);
    await save();
  });
}

/** Only this host gate records approval; a model note or merge never supplies it. */
export async function abandonOperatorChild(jobs: OperatorJobs, client: OperatorSupervisorClient,
  originInput: OperatorJobOrigin, id: string, childID: string, digest: string, note: string, context: RecoveryContext,
  permissions: OperatorRecoveryPermissions) {
  const origin = await jobs.origin(originInput);
  checkContext(origin, context);
  if (!note.trim() || note.length > OPERATOR_RECOVERY_LIMITS.noteChars) throw new Error('operator_recovery_note_invalid');
  const initial = await jobs.get(origin, id);
  const previous = boundChild(initial, childID).abandonment;
  if (previous) {
    if (previous.digest !== digest || previous.note !== note) throw new Error('operator_recovery_idempotency_conflict');
    return initial;
  }
  const preview = await prepareOperatorRecovery(jobs, client, origin, id, childID);
  if (preview.digest !== digest) throw new Error('operator_recovery_stale');
  if (!preview.eligible) throw new Error(`operator_recovery_not_eligible: ${preview.reason}; use recheck to reconcile existing evidence`);
  context.metadata({ title: `Release uncertain reservation: ${id}/${childID}` });
  let proof: OperatorRecoveryPermissionProof;
  try {
    proof = await permissions.ask(context, { patterns: [`${id}/${childID}/${digest}`],
      metadata: { ...preview, note, action: boundChild(initial, childID).access === 'write'
        ? 'Release this exact zero-write child and revoke its future managed writes without replacement'
        : 'Abandon this exact read-only child without retrying it', approvalScope: 'once' } });
  } catch (error) {
    await recordDenial(jobs, origin, id, childID, digest);
    if (error instanceof Error && error.message.startsWith('operator_recovery_')) throw error;
    throw new Error('operator_recovery_not_approved');
  }
  checkContext(origin, context);
  const fresh = await prepareOperatorRecovery(jobs, client, origin, id, childID);
  if (fresh.reason === 'already-abandoned') {
    const current = await jobs.get(origin, id);
    const recorded = boundChild(current, childID).abandonment;
    if (recorded?.digest === digest && recorded.note === note) return current;
    throw new Error('operator_recovery_idempotency_conflict');
  }
  if (fresh.digest !== digest || !fresh.eligible) throw new Error('operator_recovery_stale');
  return commitAbandonment(jobs, origin, id, childID, digest, note, context, proof);
}

async function commitAbandonment(jobs: OperatorJobs, origin: OperatorJobOrigin, id: string,
  childID: string, digest: string, note: string, context: RecoveryContext, approval: OperatorRecoveryPermissionProof) {
  return jobs.transaction(async (ledger, save) => {
    checkContext(origin, context);
    const job = jobs.bound(ledger, origin, id);
    const child = boundChild(job, childID);
    if (child.abandonment?.digest === digest && child.abandonment.note === note) return job;
    if (operatorRecoveryDigest(job, child) !== digest
      || (child.access === 'write' ? !writeCanRelease(child) : !child.uncertainty?.needsDecision)) throw new Error('operator_recovery_stale');
    const attempt = child.attempts.at(-1);
    child.abandonment = { digest, at: new Date().toISOString(), actor: userInfo().username, note, unknownOutcome: true, approval,
      ...(child.operation ? { operationToken: child.operation.token } : {}),
      ...(attempt ? { attemptID: attempt.id, messageID: attempt.messageID } : {}) };
    child.status = 'abandoned';
    delete child.operation;
    child.blocker = 'operator_child_abandoned_unknown_outcome';
    if (job.status !== 'paused') job.status = 'blocked';
    operatorJobEvent(job, 'abandoned',
      `Human permission in ${context.sessionID}/${context.messageID} released this reservation once. Outcome remains unknown; no replacement launched. ${note}`, childID);
    await save();
    return job;
  });
}
