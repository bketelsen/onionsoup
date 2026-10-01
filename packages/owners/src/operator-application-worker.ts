import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OperatorHandoffs } from './operator-handoff-host.ts';
import { OperatorApplicationStore } from './operator-application-store.ts';
import type { OperatorApplication } from './operator-application-types.ts';
import { OperatorApplicationFiles, applicationAttemptInspection, applicationReceipts, mutateApplication,
  operatorApplicationEffects } from './operator-application-files.ts';
import { applicationSource } from './operator-application-preview.ts';
import { operatorJobDigest, operatorJobEvent } from './operator-jobs.ts';
import { operatorHandoffSourceDigest } from './operator-handoff-artifact.ts';
import { operatorWriteArtifact, operatorWriteSha256, readOperatorWriteSourceFiles } from './operator-write-workspace.ts';
import { AdmissionRecord, beginAdmission, releaseMatchedAdmission } from './deployment-admission.ts';
import { readOperatorCheckOwner, inspectOperatorCheckOwner } from './operator-check-execution.ts';
import { withRecordLock } from './record-lock.ts';

export function applicationClaim(record: OperatorApplication) {
  return { id: record.id, token: record.token, artifactDigest: record.scope.artifact.digest,
    target: { directory: record.scope.target.directory, identityDigest: record.scope.target.digest },
    approvalDigest: record.scope.digest };
}
export function applicationReason(error: unknown) {
  if (error instanceof Error && error.message.startsWith('operator_workspace_conflict:')) return 'operator_workspace_conflict';
  return error instanceof Error && /^(operator_|deployment_)[a-z0-9_]+$/.test(error.message)
    ? error.message : 'operator_application_unavailable';
}

export class OperatorApplicationWorker {
  readonly store: OperatorApplicationStore;
  readonly files: OperatorApplicationFiles;
  private readonly queued = new Set<string>();
  constructor(readonly handoffs: OperatorHandoffs, effects = operatorApplicationEffects) {
    this.store = new OperatorApplicationStore(handoffs.jobs.home);
    this.files = new OperatorApplicationFiles(this.store, effects);
  }
  enqueue(id: string) {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    // This dedicated execution lock is never the jobs or application mutation lock. Status remains responsive.
    void withRecordLock(join(this.handoffs.jobs.home, 'operator-applications', 'worker.lock'), () => this.work(id))
      .catch(error => console.warn('operator_application_worker_failed', id, applicationReason(error)))
      .finally(() => this.queued.delete(id));
  }
  private async record(id: string) {
    const record = await this.store.read(id);
    if (!record) throw new Error('operator_application_missing');
    return record;
  }
  private async source(record: OperatorApplication) {
    const current = await applicationSource(this.handoffs, record.scope.artifact.origin, record.scope.artifact.jobID);
    if (current.artifact.digest !== record.scope.artifact.digest || operatorJobDigest(current.job) !== record.scope.jobDigest
      || JSON.stringify(current.checks) !== JSON.stringify(record.scope.checks)) throw new Error('operator_application_source_stale');
    return current.job;
  }
  private async reserve(record: OperatorApplication) {
    const job = await this.source(record);
    await this.handoffs.jobs.reserveApplication(job.origin, job.id, job.revision, applicationClaim(record));
  }
  private async event(record: OperatorApplication, kind: 'progress' | 'blocked', text: string) {
    await this.handoffs.jobs.transaction(async (ledger, save) => {
      const job = this.handoffs.jobs.bound(ledger, record.scope.artifact.origin, record.scope.artifact.jobID);
      operatorJobEvent(job, kind, text);
      await save();
    });
  }
  private async finish(id: string) {
    const record = await this.record(id);
    await this.source(record);
    const receipts = applicationReceipts(record);
    const artifact = await operatorWriteArtifact(record.scope.target, receipts);
    const source = await readOperatorWriteSourceFiles(record.scope.target, receipts);
    const sourceDigest = operatorHandoffSourceDigest(source);
    if (sourceDigest !== record.scope.artifact.sourceDigest) throw new Error('operator_application_final_source_mismatch');
    await mutateApplication(this.store, id, current => {
      current.result = { sourceDigest, diff: artifact.diff, diffSha256: artifact.diffSha256, at: new Date().toISOString() };
      current.status = 'applied';
      delete current.reason;
    });
    await this.event(record, 'progress', `Applied the exact combined result to ${record.scope.target.directory}; HEAD/index and child artifacts unchanged. No commit or publication.`);
  }
  private async releaseClaim(record: OperatorApplication) {
    if (record.status !== 'applied' || !record.result) return;
    await this.handoffs.jobs.releaseApplication(record.scope.artifact.origin, record.scope.artifact.jobID,
      record.id, record.token, { kind: 'applied-verified', evidenceDigest: operatorWriteSha256(JSON.stringify(record.result)) });
    await mutateApplication(this.store, record.scope.artifact.jobID, current => {
      current.claimReleasedAt ??= new Date().toISOString();
    });
  }
  private async releaseWorkers(id: string) {
    const record = await this.record(id);
    for (const operation of record.operations) {
      for (const attempt of operation.attempts) {
        const inspection = await applicationAttemptInspection(attempt);
        if (inspection.state !== 'stopped') return;
        if (!attempt.inspection) await mutateApplication(this.store, id, current => {
          const saved = current.operations.find(candidate => candidate.mutationID === operation.mutationID)!
            .attempts.find(candidate => candidate.id === attempt.id)!;
          saved.inspection = inspection;
          saved.endedAt ??= new Date().toISOString();
        });
      }
    }
    const currentOwner = await readOperatorCheckOwner();
    for (const worker of record.workers.filter(candidate => !candidate.endedAt)) {
      const sameOwner = JSON.stringify(worker.owner) === JSON.stringify(currentOwner);
      if (!sameOwner && (await inspectOperatorCheckOwner(worker.owner)).state !== 'stopped') continue;
      await releaseMatchedAdmission(this.handoffs.jobs.home, worker.admission);
      await mutateApplication(this.store, id, current => {
        current.workers.find(candidate => candidate.id === worker.id)!.endedAt = new Date().toISOString();
      });
    }
  }
  private async execute(id: string) {
    let record = await this.record(id);
    if (record.status === 'applied') {
      await this.releaseClaim(record);
      return;
    }
    await this.reserve(record);
    const owner = await readOperatorCheckOwner();
    const admission = await beginAdmission(this.handoffs.jobs.home, 'plugin:operator-application');
    try {
      record = await mutateApplication(this.store, id, current => {
        current.workers.push({ id: `worker_${randomUUID()}`, owner, admission: AdmissionRecord.parse(admission), startedAt: new Date().toISOString() });
        current.status = 'applying';
        delete current.reason;
      });
    } catch (error) { await admission.release(); throw error; }
    for (const mutation of record.scope.mutations) {
      await this.source(await this.record(id));
      await this.files.apply(id, mutation);
    }
    await this.finish(id);
    await this.releaseClaim(await this.record(id));
  }
  private async work(id: string) {
    try { await this.execute(id); }
    catch (error) {
      const existing = await this.record(id);
      if (existing.status !== 'applied') {
        const reason = applicationReason(error);
        const record = await mutateApplication(this.store, id, current => { current.status = 'blocked'; current.reason = reason; });
        await this.event(record, 'blocked', `Combined-result application blocked: ${reason}. Keep its target reservation; inspect show-application before exact retry.`);
      }
    } finally { await this.releaseWorkers(id); }
  }
}
