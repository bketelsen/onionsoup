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
import { beginAdmission, type AdmissionLease } from './deployment-admission.ts';
import { OPERATOR_SUPERVISOR_TRANSPORT_LIMITS } from './operator-supervisor-client.ts';

export const OPERATOR_HANDOFF_HOST_LIMITS = { concurrentChecks: 2 };
export interface OperatorHandoffReport {
  kind: 'operator-handoff'; application: 'not-applied'; observedAt: string;
  status: 'needs-checks' | 'checking' | 'uncertain' | 'failed' | 'ready' | 'unchecked' | 'stale';
  current: boolean; reason?: string; artifact: OperatorHandoffRecord['artifact']; checks: OperatorCheckRecord[];
  paths: { patch: string; report: string };
}
type Context = Pick<ToolContext, 'abort' | 'messageID' | 'sessionID' | 'agent' | 'directory'>;
type Effects = { run: typeof runOperatorCheck; preflight: typeof preflightOperatorCheck };

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
    const report: OperatorHandoffReport = { kind: 'operator-handoff', application: 'not-applied',
      observedAt: new Date().toISOString(), current: !reason,
      status: reason ? 'stale' : this.status(record), ...(reason ? { reason } : {}), artifact: record.artifact,
      checks: record.checks, paths };
    await writeHandoffFile(paths.patch, record.artifact.diff);
    await writeHandoffFile(paths.report, JSON.stringify(report, null, 2));
    return report;
  }

  private status(record: OperatorHandoffRecord): OperatorHandoffReport['status'] {
    const pending = record.checks.filter(check => check.status === 'prepared');
    if (pending.some(check => !this.running.has(check.id))) return 'uncertain';
    if (pending.length) return 'checking';
    if (record.checks.some(check => check.exitCode !== 0)) return 'failed';
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
    const admission = await beginAdmission(this.jobs.home, 'plugin:operator-handoff');
    let receipt: OperatorCheckRecord | undefined;
    try { receipt = await this.claim(candidate.job, digest, checkID, context); } catch (error) {
      await admission.release();
      throw error;
    }
    if (!receipt) await admission.release();
    else {
      this.running.add(receipt.id);
      void this.execute(id, receipt, candidate.source, admission);
    }
    return this.show(origin, id);
  }

  private async claim(job: OperatorJob, digest: string, checkID: string, context: Context) {
    return this.jobs.transaction(async ledger => {
      this.context(job.origin, context);
      this.assertSameJob(this.jobs.bound(ledger, job.origin, job.id), job);
      return this.store.transaction(async (handoffs, save) => {
        const record = handoffs.records.find(candidate => candidate.artifact.jobID === job.id);
        if (!record || record.artifact.digest !== digest || record.jobDigest !== operatorJobDigest(job)) throw new Error('operator_handoff_artifact_stale');
        if (record.checks.some(receipt => receipt.checkID === checkID)) return undefined;
        if (record.checks.some(receipt => receipt.status === 'prepared') || handoffs.records.flatMap(candidate => candidate.checks)
          .filter(receipt => receipt.status === 'prepared').length >= OPERATOR_HANDOFF_HOST_LIMITS.concurrentChecks) {
          throw new Error('operator_handoff_check_capacity');
        }
        const check = record.artifact.checks.find(candidate => candidate.id === checkID)!;
        const receipt: OperatorCheckRecord = { id: `check_${randomUUID()}`, checkID, command: check.command,
          callID: `handoff_${randomUUID()}`, messageID: context.messageID, artifactDigest: digest,
          status: 'prepared', startedAt: new Date().toISOString() };
        record.checks.push(receipt);
        await save();
        return receipt;
      });
    });
  }

  private async complete(id: string, receipt: OperatorCheckRecord, outcome: OperatorCheckRun) {
    await this.store.transaction(async (ledger, save) => {
      const record = ledger.records.find(candidate => candidate.artifact.jobID === id);
      const current = record?.checks.find(candidate => candidate.id === receipt.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error('operator_handoff_receipt_stale');
      Object.assign(current, outcome, { status: 'completed', completedAt: new Date().toISOString() });
      current.digest = operatorCheckRecordDigest(current);
      await save();
    });
  }

  private async execute(id: string, receipt: OperatorCheckRecord, source: OperatorCheckSourceFile[], admission: AdmissionLease) {
    let outcome: OperatorCheckRun;
    try { outcome = await this.effects.run(receipt.command, source); } catch {
      this.running.delete(receipt.id);
      console.error('operator_handoff_check_stop_unproven');
      return;
    }
    try { await this.complete(id, receipt, outcome); } catch {
      console.error('operator_handoff_check_completion_not_persisted');
    } finally {
      this.running.delete(receipt.id);
      await admission.release().catch(() => console.error('operator_handoff_admission_release_failed'));
    }
  }
}
