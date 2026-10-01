import { randomUUID } from 'node:crypto';
import { OPERATOR_INVESTIGATOR, type OperatorChild, type OperatorJobOrigin,
  type OperatorSessionSnapshot, type OperatorSupervisorClient } from './operator-jobs-types.ts';
import { OperatorJobs, operatorJobEvent } from './operator-jobs.ts';
import { operatorChild } from './operator-child-scope.ts';
import { withRecordLock } from './record-lock.ts';
import { OPERATOR_CHECK_TOOL, type OperatorCheckInput } from './operator-write-call.ts';
import { OPERATOR_CHECK_LIMITS, operatorCheckRecordDigest, type OperatorCheckRecord } from './operator-check-types.ts';
import { operatorWriteArtifact, readOperatorWriteSourceFiles } from './operator-write-workspace.ts';
import { runOperatorCheck, validateOperatorCheckInput, preflightOperatorCheck } from './operator-check-runner.ts';
import { writeChild, writeReceipts, operatorWriteLock, assertOperatorWriteCall, assertOperatorWriteUnchanged,
  type OperatorWriteContext } from './operator-write-context.ts';

/** Check commands come from the native-approved task, never from the child's invocation. */
export class OperatorChecks {
  constructor(readonly jobs: OperatorJobs, readonly client: OperatorSupervisorClient) {}

  async run(context: OperatorWriteContext, callID: string, input: OperatorCheckInput) {
    if (context.agent !== OPERATOR_INVESTIGATOR) throw new Error('operator_check_child_only');
    const bound = await operatorChild(this.jobs, context.sessionID);
    if (!bound?.child.write) throw new Error('operator_check_child_unbound');
    return withRecordLock(operatorWriteLock(this.jobs, bound.job.id, bound.child.id),
      () => this.execute(context, callID, input, bound.job.origin, bound.job.id, bound.child.id));
  }

  private async execute(context: OperatorWriteContext, callID: string, input: OperatorCheckInput,
    origin: OperatorJobOrigin, id: string, childID: string) {
    context.abort.throwIfAborted();
    const child = writeChild(await this.jobs.get(origin, id), childID);
    await assertOperatorWriteCall(this.client, child, context, callID, OPERATOR_CHECK_TOOL);
    const check = child.checks?.find(candidate => candidate.id === input.checkID);
    if (!check) throw new Error('operator_check_not_approved');
    const records = child.write.checks ?? [];
    if (records.some(record => record.status === 'prepared')) throw new Error('operator_check_effect_uncertain');
    const receipts = writeReceipts(child);
    const artifact = await operatorWriteArtifact(child.write.baseline, receipts);
    const matching = records.filter(record => record.checkID === check.id);
    const previous = matching.at(-1);
    if (previous?.status === 'completed' && previous.exitCode === 0 && previous.artifactDigest === artifact.digest) {
      if (operatorCheckRecordDigest(previous) !== previous.digest) throw new Error('operator_check_receipt_invalid');
      return previous;
    }
    if (records.some(record => record.callID === callID && record.messageID === context.messageID)) {
      throw new Error('operator_check_call_already_recorded');
    }
    if (matching.length >= OPERATOR_CHECK_LIMITS.attemptsPerCheck) throw new Error('operator_check_attempt_limit');
    const source = await readOperatorWriteSourceFiles(child.write.baseline, receipts);
    if ((await operatorWriteArtifact(child.write.baseline, receipts)).digest !== artifact.digest) {
      throw new Error('operator_check_source_changed');
    }
    validateOperatorCheckInput(check.command, source);
    await preflightOperatorCheck(check.command);
    const prepared: OperatorCheckRecord = { id: `check_${randomUUID()}`, checkID: check.id, command: check.command,
      callID, messageID: context.messageID, artifactDigest: artifact.digest, status: 'prepared', startedAt: new Date().toISOString() };
    await this.prepare(origin, id, child, prepared, context);
    const outcome = await runOperatorCheck(check.command, source);
    const completed: OperatorCheckRecord = { ...prepared, ...outcome, status: 'completed', completedAt: new Date().toISOString() };
    completed.digest = operatorCheckRecordDigest(completed);
    return this.complete(origin, id, childID, prepared, completed);
  }

  private async prepare(origin: OperatorJobOrigin, id: string, previous: OperatorChild,
    record: OperatorCheckRecord, context: OperatorWriteContext) {
    await this.jobs.transaction(async (ledger, save) => {
      const child = writeChild(this.jobs.bound(ledger, origin, id), previous.id);
      assertOperatorWriteUnchanged(child, previous, context);
      child.write.checks ??= [];
      child.write.checks.push(record);
      await save();
    });
  }

  private async complete(origin: OperatorJobOrigin, id: string, childID: string,
    prepared: OperatorCheckRecord, completed: OperatorCheckRecord) {
    return this.jobs.transaction(async (ledger, save) => {
      const job = this.jobs.bound(ledger, origin, id);
      const child = writeChild(job, childID);
      const records = child.write.checks ?? [];
      const index = records.findIndex(record => record.id === prepared.id);
      if (index < 0 || JSON.stringify(records[index]) !== JSON.stringify(prepared)) throw new Error('operator_check_receipt_unbound');
      records[index] = completed;
      operatorJobEvent(job, 'progress', `Host check ${completed.checkID} exited ${completed.exitCode} for source ${completed.artifactDigest}.`, childID);
      await save();
      return completed;
    });
  }

  static assertEvidence(child: OperatorChild, snapshot: OperatorSessionSnapshot) {
    for (const record of child.write?.checks ?? []) {
      if (record.status === 'prepared') throw new Error('operator_check_effect_uncertain');
      if (record.digest !== operatorCheckRecordDigest(record)) throw new Error('operator_check_receipt_invalid');
      const message = snapshot.messages.find(candidate => candidate.id === record.messageID && candidate.role === 'assistant');
      const call = message?.tools.find(candidate => candidate.callID === record.callID && candidate.tool === OPERATOR_CHECK_TOOL);
      if (!call || !['completed', 'error'].includes(call.status)
        || !child.attempts.some(attempt => attempt.messageID === message?.parentID)) throw new Error('operator_check_call_evidence_missing');
    }
  }
}
