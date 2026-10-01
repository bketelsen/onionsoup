import { isDeepStrictEqual } from 'node:util';
import { OPERATOR_CHECK_LIMITS } from './operator-check-types.ts';
import { OperatorJobInput, OperatorTaskInput, OperatorWriteRevisionRequest, OPERATOR_JOB_LIMITS,
  type OperatorChild, type OperatorJob, type OperatorJobOrigin, type OperatorSessionSnapshot,
  type OperatorWriteHost } from './operator-jobs-types.ts';
import { operatorJobEvent } from './operator-jobs.ts';
import { operatorChildVersion, settleOperatorJob } from './operator-scheduler.ts';
import { operatorWriteScopeDigest, assertOperatorWriteTerminal } from './operator-write-state.ts';
import { writeChild, type OperatorWriteContext } from './operator-write-context.ts';
import type { OperatorWrites } from './operator-write-host.ts';

function fail(reason: string): never { throw new Error(`operator_write_revision_${reason}`); }

function assertOriginalScope(job: OperatorJob) {
  const input = OperatorJobInput.parse({ key: job.key, goal: job.goal, constraints: job.constraints,
    tasks: job.children.map(child => OperatorTaskInput.parse(child)) });
  const baselines = Object.fromEntries(job.children.filter(child => child.write)
    .map(child => [child.id, child.write!.baseline]));
  const digest = operatorWriteScopeDigest(job.origin, job.intake, input, baselines);
  if (job.children.some(child => child.write && child.write.approval.scopeDigest !== digest)) fail('scope_changed');
}

function assertWaitingDependents(job: OperatorJob, childID: string) {
  const dependencies = new Set([childID]);
  for (let pass = 0; pass < job.children.length; pass++) {
    for (const child of job.children) {
      if (child.dependsOn.some(id => dependencies.has(id))) dependencies.add(child.id);
    }
  }
  for (const child of job.children.filter(child => child.id !== childID && dependencies.has(child.id))) {
    if (child.status !== 'queued' || child.sessionID || child.attempts.length || child.evidence || child.operation
      || child.uncertainty || child.abandonment || child.blocker) fail('dependent_started');
  }
}

function assertEligible(job: OperatorJob, child: OperatorChild) {
  if (!['running', 'blocked', 'needs-review', 'paused'].includes(job.status) || job.synthesis
    || job.applicationClaims?.length) fail('job_not_eligible');
  if (child.status !== 'needs-review' || !child.sessionID || !child.write?.artifact || !child.evidence
    || child.write.acceptance || child.operation || child.uncertainty || child.blocker || child.abandonment
    || !child.attempts.length || child.attempts.some(attempt => !attempt.endedAt)) fail('child_not_eligible');
  if (child.write.operations.some(operation => operation.status === 'prepared')
    || child.write.checks?.some(check => check.status === 'prepared')) fail('effect_uncertain');
  if ((child.write.revisions?.length ?? 0) >= OPERATOR_JOB_LIMITS.writeRevisions) fail('limit');
  for (const check of child.checks ?? []) {
    if ((child.write.checks ?? []).filter(record => record.checkID === check.id).length >= OPERATOR_CHECK_LIMITS.attemptsPerCheck) {
      fail('check_limit');
    }
  }
  assertOriginalScope(job);
  assertWaitingDependents(job, child.id);
}

function alreadyRequested(child: OperatorChild, request: { digest: string; text: string }) {
  const prior = child.write?.revisions?.find(revision => revision.digest === request.digest);
  if (prior && prior.text !== request.text) fail('idempotency_conflict');
  return Boolean(prior);
}

/** Only the already approved paths/checks can run again; feedback cannot change the original task or authority. */
export async function reviseOperatorWrite(writes: OperatorWrites, origin: OperatorJobOrigin, id: string,
  childID: string, digest: string, text: string, context: OperatorWriteContext) {
  const request = OperatorWriteRevisionRequest.parse({ digest, text });
  const existing = await writes.jobs.get(origin, id);
  const child = writeChild(existing, childID);
  assertOriginalScope(existing);
  if (alreadyRequested(child, request)) return existing;
  assertEligible(existing, child);
  let preview: Awaited<ReturnType<OperatorWrites['review']>>;
  try {
    preview = await writes.review(origin, id, childID);
  } catch (error) {
    const current = await writes.jobs.get(origin, id);
    assertOriginalScope(current);
    if (alreadyRequested(writeChild(current, childID), request)) return current;
    throw error;
  }
  if (preview.digest !== request.digest) fail('stale');
  assertEligible(preview.job, preview.child);
  return writes.jobs.transaction(async (ledger, save) => {
    context.abort.throwIfAborted();
    const job = writes.jobs.bound(ledger, preview.job.origin, id);
    const current = writeChild(job, childID);
    if (alreadyRequested(current, request)) return job;
    assertEligible(job, current);
    if (operatorChildVersion(job, current) !== operatorChildVersion(preview.job, preview.child)) fail('stale');
    (current.write.revisions ??= []).push({ ...request, at: new Date().toISOString(),
      attemptID: current.attempts.at(-1)!.id, evidence: structuredClone(current.evidence!),
      artifact: structuredClone(current.write.artifact!), checkIDs: (current.write.checks ?? []).map(check => check.id) });
    delete current.evidence;
    delete current.write.artifact;
    current.status = 'queued';
    operatorJobEvent(job, 'progress', 'Same-child revision queued within the original approval; prior evidence is archived and fresh checks and diff acceptance are required.', childID);
    settleOperatorJob(job);
    await save();
    return job;
  });
}

export function pendingOperatorWriteRevision(child: OperatorChild) {
  const revision = child.write?.revisions?.at(-1);
  return revision && revision.attemptID === child.attempts.at(-1)?.id ? revision : undefined;
}

/** Reprove the archived final turn and filesystem before dispatch, including after restart or slow observation. */
export async function inspectPendingOperatorWriteRevision(host: OperatorWriteHost | undefined,
  job: OperatorJob, child: OperatorChild, snapshot: OperatorSessionSnapshot) {
  const revision = pendingOperatorWriteRevision(child);
  if (!revision) return;
  assertOriginalScope(job);
  if (!host) fail('host_unavailable');
  const previous = { ...child, evidence: revision.evidence };
  assertOperatorWriteTerminal(previous, snapshot);
  if (!isDeepStrictEqual(await host.inspect(job, previous, snapshot), revision.artifact)) fail('artifact_changed');
}
