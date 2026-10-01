import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { OperatorJobs, operatorJobDigest } from './operator-jobs.ts';
import type { OperatorJob, OperatorJobOrigin, OperatorSupervisorClient, OperatorWriteHost } from './operator-jobs-types.ts';
import { assertOperatorWriteTerminal } from './operator-write-state.ts';
import { buildOperatorHandoff } from './operator-handoff-artifact.ts';
import { OperatorHandoffStore, writeHandoffFile, type OperatorHandoffRecord } from './operator-handoff-store.ts';
import { operatorCheckRecordDigest, type OperatorCheckRecord } from './operator-check-types.ts';
import { preflightOperatorCheck, runOperatorCheck, validateOperatorCheckInput,
  type OperatorCheckRun, type OperatorCheckSourceFile } from './operator-check-runner.ts';
import { beginAdmission, releaseMatchedAdmission, AdmissionRecord, type AdmissionLease } from './deployment-admission.ts';
import { readOperatorCheckOwner, type OperatorCheckOwner } from './operator-check-execution.ts';
import { OperatorHandoffExecutionJournal, operatorHandoffPreparedDigest, type OperatorHandoffExecutionBinding } from './operator-handoff-execution.ts';
import { OPERATOR_SUPERVISOR_TRANSPORT_LIMITS } from './operator-supervisor-client.ts';
import { OperatorApplicationStore } from './operator-application-store.ts';

export const OPERATOR_HANDOFF_HOST_LIMITS = { concurrentChecks: 2 };
export interface OperatorHandoffReport {
  kind: 'operator-handoff'; application: 'not-applied' | 'approved' | 'applying' | 'blocked' | 'applied'; observedAt: string;
  applicationEvidence?: { digest: string; target: string; reason?: string; recordPath: string; sourceDigest?: string };
  status: 'needs-checks' | 'checking' | 'uncertain' | 'failed' | 'ready' | 'unchecked' | 'stale' | 'unverified';
  current: boolean; reason?: string; artifact: OperatorHandoffRecord['artifact']; checks: OperatorCheckRecord[];
  originalChecks: OperatorCheckRecord[]; resolutions: NonNullable<OperatorHandoffRecord['resolutions']>;
  paths: { patch: string; report: string };
}
type Context = Pick<ToolContext, 'abort' | 'messageID' | 'sessionID' | 'agent' | 'directory'>;
type Effects = { run: typeof runOperatorCheck; preflight: typeof preflightOperatorCheck };

function logHandoffFailure(reason: string, jobID: string, receiptID: string, error: unknown) {
  const cause = error instanceof Error && /^operator_[a-z0-9_]+$/.test(error.message)
    ? error.message : 'cause_unclassified';
  console.error(reason, { jobID, receiptID, cause });
}

/** A handoff verifies an isolated union; it never applies changes or rewrites child acceptance. */
export class OperatorHandoffs {
  readonly store: OperatorHandoffStore;
  private readonly running = new Set<string>();
  constructor(readonly jobs: OperatorJobs, readonly client: OperatorSupervisorClient,
    readonly writes: OperatorWriteHost, readonly effects: Effects = { run: runOperatorCheck, preflight: preflightOperatorCheck }) {
    this.store = new OperatorHandoffStore(jobs.home);
  }

  private context(origin: OperatorJobOrigin, context: Context) {
    context.abort.throwIfAborted();
    if (context.agent !== this.jobs.operator || context.sessionID !== origin.sessionID || context.directory !== origin.directory) {
      throw new Error('operator_handoff_origin_mismatch');
    }
  }

  private async live(job: OperatorJob) {
    const signal = AbortSignal.timeout(OPERATOR_SUPERVISOR_TRANSPORT_LIMITS.timeoutMs);
    for (const child of job.children) {
      if (!child.sessionID) throw new Error('operator_handoff_session_missing');
      const snapshot = await this.client.readSession(child.directory, child.sessionID, { signal });
      assertOperatorWriteTerminal(child, snapshot);
      if (child.write) {
        const artifact = await this.writes.inspect(job, child, snapshot);
        if (JSON.stringify(artifact) !== JSON.stringify(child.write.artifact)) throw new Error('operator_handoff_workspace_stale');
      }
    }
  }

  private async candidate(origin: OperatorJobOrigin, id: string) {
    const job = await this.jobs.get(origin, id);
    if (!['needs-synthesis', 'completed'].includes(job.status)) throw new Error('operator_handoff_job_not_ready');
    await this.live(job);
    const built = await buildOperatorHandoff(job);
    await this.live(job);
    return { job, ...built };
  }

  private assertSameJob(current: OperatorJob, observed: OperatorJob) {
    if (current.status !== observed.status || operatorJobDigest(current) !== operatorJobDigest(observed)) {
      throw new Error('operator_handoff_job_stale');
    }
  }

  async prepare(origin: OperatorJobOrigin, id: string, context: Context) {
    this.context(origin, context);
    const candidate = await this.candidate(origin, id);
    this.context(origin, context);
    await this.jobs.transaction(async ledger => {
      this.assertSameJob(this.jobs.bound(ledger, origin, id), candidate.job);
      await this.store.transaction(async (handoffs, save) => {
        const existing = handoffs.records.find(record => record.artifact.jobID === id);
        if (existing) {
          if (existing.artifact.digest !== candidate.artifact.digest) throw new Error('operator_handoff_artifact_stale');
          return;
        }
        handoffs.records.push({ artifact: candidate.artifact, jobDigest: operatorJobDigest(candidate.job),
          createdAt: new Date().toISOString(), checks: [] });
        await save();
      });
    });
    return this.show(origin, id);
  }

  private async record(origin: OperatorJobOrigin, id: string) {
    await this.jobs.get(origin, id);
    const record = (await this.store.read()).records.find(candidate => candidate.artifact.jobID === id);
    if (!record) throw new Error('operator_handoff_not_prepared');
    return record;
  }

  async show(origin: OperatorJobOrigin, id: string): Promise<OperatorHandoffReport> {
    const record = await this.record(origin, id);
    let reason: string | undefined;
    let observed: OperatorJob | undefined;
    try {
      const current = await this.candidate(origin, id);
      observed = current.job;
      if (current.artifact.digest !== record.artifact.digest || operatorJobDigest(current.job) !== record.jobDigest) {
        reason = 'operator_handoff_artifact_stale';
      }
    } catch (error) {
      reason = error instanceof Error && /^operator_\w+$/.test(error.message) ? error.message : 'operator_handoff_evidence_unavailable';
    }
    return this.jobs.transaction(async jobs => {
      const latestJob = this.jobs.bound(jobs, origin, id);
      if (observed && (latestJob.status !== observed.status || operatorJobDigest(latestJob) !== operatorJobDigest(observed))) {
        reason = 'operator_handoff_job_stale';
      }
      return this.store.transaction(async ledger => {
        const latest = ledger.records.find(candidate => candidate.artifact.jobID === id);
        if (!latest || latest.artifact.digest !== record.artifact.digest) throw new Error('operator_handoff_artifact_stale');
        return this.report(latest, reason);
      });
    });
  }

  private async report(record: OperatorHandoffRecord, reason?: string): Promise<OperatorHandoffReport> {
    const directory = join(this.jobs.home, 'operator-handoffs', record.artifact.digest);
    const paths = { patch: join(directory, 'combined.patch'), report: join(directory, 'report.json') };
    const applications = new OperatorApplicationStore(this.jobs.home);
    const application = await applications.read(record.artifact.jobID);
    if (application && application.scope.artifact.digest !== record.artifact.digest) throw new Error('operator_application_source_stale');
    const report: OperatorHandoffReport = { kind: 'operator-handoff', application: application?.status ?? 'not-applied',
      ...(application ? { applicationEvidence: { digest: application.scope.digest, target: application.scope.target.directory,
        reason: application.reason, recordPath: applications.path(record.artifact.jobID), sourceDigest: application.result?.sourceDigest } } : {}),
      observedAt: new Date().toISOString(), current: !reason,
      status: reason ? 'stale' : this.status(record), ...(reason ? { reason } : {}), artifact: record.artifact,
      checks: effectiveHandoffChecks(record), originalChecks: record.checks, resolutions: record.resolutions ?? [], paths };
    await writeHandoffFile(paths.patch, record.artifact.diff);
    await writeHandoffFile(paths.report, JSON.stringify(report, null, 2));
    return report;
  }

  private status(record: OperatorHandoffRecord): OperatorHandoffReport['status'] {
    const pending = unresolvedHandoffChecks(record);
    if (pending.some(check => !this.running.has(check.id))) return 'uncertain';
    if (pending.length) return 'checking';
    if (record.resolutions?.some(resolution => resolution.kind === 'stopped-unverified')) return 'unverified';
    if (effectiveHandoffChecks(record).some(check => check.exitCode !== 0)) return 'failed';
    if (!record.artifact.checks.length) return 'unchecked';
    return record.artifact.checks.every(check => record.checks.some(receipt => receipt.checkID === check.id)) ? 'ready' : 'needs-checks';
  }

  async check(origin: OperatorJobOrigin, id: string, digest: string, checkID: string, context: Context) {
    this.context(origin, context);
    const record = await this.record(origin, id);
    if (record.artifact.digest !== digest) throw new Error('operator_handoff_digest_mismatch');
    const check = record.artifact.checks.find(candidate => candidate.id === checkID);
    if (!check) throw new Error('operator_handoff_check_missing');
    if (record.checks.some(receipt => receipt.checkID === checkID)) return this.show(origin, id);
    await this.effects.preflight(check.command);
    const candidate = await this.candidate(origin, id);
    if (candidate.artifact.digest !== digest) throw new Error('operator_handoff_artifact_stale');
    validateOperatorCheckInput(check.command, candidate.source);
    this.context(origin, context);
    const owner = await readOperatorCheckOwner();
    const admission = await beginAdmission(this.jobs.home, 'plugin:operator-handoff');
    const attempted = makeHandoffAttempt(checkID, check.command, digest, context, owner, admission);
    let receipt: OperatorCheckRecord | undefined;
    try {
      await new OperatorHandoffExecutionJournal(this.jobs.home, attempted.binding).start();
      receipt = await this.claim(candidate.job, digest, checkID, context, attempted);
    } catch (error) {
      await admission.release();
      throw error;
    }
    if (!receipt) await admission.release();
    else {
      this.running.add(receipt.id);
      void this.execute(id, receipt, candidate.source, admission, attempted.binding);
    }
    return this.show(origin, id);
  }

  private async claim(job: OperatorJob, digest: string, checkID: string, context: Context,
    attempted: ReturnType<typeof makeHandoffAttempt>) {
    return this.jobs.transaction(async ledger => {
      this.context(job.origin, context);
      this.assertSameJob(this.jobs.bound(ledger, job.origin, job.id), job);
      return this.store.transaction(async (handoffs, save) => {
        const record = handoffs.records.find(candidate => candidate.artifact.jobID === job.id);
        if (!record || record.artifact.digest !== digest || record.jobDigest !== operatorJobDigest(job)) throw new Error('operator_handoff_artifact_stale');
        if (record.checks.some(receipt => receipt.checkID === checkID)) return undefined;
        if (unresolvedHandoffChecks(record).length || handoffs.records.flatMap(unresolvedHandoffChecks).length >= OPERATOR_HANDOFF_HOST_LIMITS.concurrentChecks) {
          throw new Error('operator_handoff_check_capacity');
        }
        const { receipt, binding } = attempted;
        record.checks.push(receipt);
        (record.executions ??= []).push(binding);
        await save();
        return receipt;
      });
    });
  }

  private async complete(id: string, receipt: OperatorCheckRecord, outcome: OperatorCheckRun) {
    await this.store.transaction(async (ledger, save) => {
      const record = ledger.records.find(candidate => candidate.artifact.jobID === id);
      const current = record?.checks.find(candidate => candidate.id === receipt.id);
      if (record?.resolutions?.some(resolution => resolution.receiptID === receipt.id)) return;
      if (!current || JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error('operator_handoff_receipt_stale');
      Object.assign(current, outcome, { status: 'completed', completedAt: new Date().toISOString() });
      current.digest = operatorCheckRecordDigest(current);
      await save();
    });
  }

  private async execute(id: string, receipt: OperatorCheckRecord, source: OperatorCheckSourceFile[], admission: AdmissionLease,
    binding: OperatorHandoffExecutionBinding) {
    const journal = new OperatorHandoffExecutionJournal(this.jobs.home, binding);
    let outcome: OperatorCheckRun;
    let started = false;
    try {
      await journal.start();
      started = true;
      outcome = await this.effects.run(receipt.command, source, { onWitness: witness => journal.witness(witness) });
    } catch (error) {
      if (!started) {
        outcome = { exitCode: 125, output: '[operator_handoff_execution_not_started]', outputTruncated: false };
        await this.settle(id, receipt, outcome, admission, journal);
        return;
      }
      this.running.delete(receipt.id);
      logHandoffFailure('operator_handoff_check_stop_unproven', id, receipt.id, error);
      return;
    }
    await this.settle(id, receipt, outcome, admission, journal);
  }

  private async settle(id: string, receipt: OperatorCheckRecord, outcome: OperatorCheckRun,
    admission: AdmissionLease, journal: OperatorHandoffExecutionJournal) {
    try { await journal.finish(outcome); } catch (error) {
      logHandoffFailure('operator_handoff_execution_completion_not_persisted', id, receipt.id, error);
    }
    try { await this.complete(id, receipt, outcome); } catch (error) {
      logHandoffFailure('operator_handoff_check_completion_not_persisted', id, receipt.id, error);
    } finally {
      this.running.delete(receipt.id);
      await releaseMatchedAdmission(this.jobs.home, AdmissionRecord.parse(admission)).catch(error => logHandoffFailure('operator_handoff_admission_release_failed', id, receipt.id, error));
    }
  }
}


export function unresolvedHandoffChecks(record: OperatorHandoffRecord) {
  return record.checks.filter(check => check.status === 'prepared'
    && !record.resolutions?.some(resolution => resolution.receiptID === check.id));
}

export function effectiveHandoffChecks(record: OperatorHandoffRecord) {
  return record.checks.map(check => record.resolutions?.find(resolution => resolution.receiptID === check.id)?.completed ?? check);
}


function makeHandoffAttempt(checkID: string, command: string[], digest: string, context: Context,
  owner: OperatorCheckOwner, admission: AdmissionLease) {
  const token = admission.id;
  const receipt: OperatorCheckRecord = { id: `check_${randomUUID()}`, checkID, command,
    callID: `handoff_${token}`, messageID: context.messageID, artifactDigest: digest,
    status: 'prepared', startedAt: new Date().toISOString() };
  const binding: OperatorHandoffExecutionBinding = { receiptID: receipt.id, token,
    receiptDigest: operatorHandoffPreparedDigest(receipt), artifactDigest: digest, owner, admission: AdmissionRecord.parse(admission) };
  return { receipt, binding };
}
