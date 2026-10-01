import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AdmissionRecord } from './deployment-admission.ts';
import { OperatorCheckOwner, OperatorCheckWitness, OperatorCheckInspection } from './operator-check-execution.ts';
import { OperatorCheckRecord, OperatorCheckRuntimeEvidence, OPERATOR_CHECK_LIMITS } from './operator-check-types.ts';
import type { OperatorCheckRun } from './operator-check-runner.ts';
import { OperatorPermissionProof } from './operator-jobs-types.ts';
import { withRecordLock } from './record-lock.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';

export const OPERATOR_HANDOFF_RECOVERY_LIMITS = { noteChars: 2_000 };

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
export const OperatorHandoffExecutionBinding = z.object({ receiptID: Identifier, token: z.uuid(),
  receiptDigest: Hash, artifactDigest: Hash, owner: OperatorCheckOwner, admission: AdmissionRecord }).superRefine((binding, context) => {
  if (binding.owner.pid !== binding.admission.pid || binding.owner.started !== binding.admission.startTime
    || binding.token !== binding.admission.id) {
    context.addIssue({ code: 'custom', message: 'operator_handoff_execution_admission_mismatch' });
  }
});
export type OperatorHandoffExecutionBinding = z.infer<typeof OperatorHandoffExecutionBinding>;
export const OperatorHandoffOutcome = z.object({ exitCode: z.number().int(),
  output: z.string().max(OPERATOR_CHECK_LIMITS.outputChars), outputTruncated: z.boolean(),
  runtime: OperatorCheckRuntimeEvidence.optional() });
export const OperatorHandoffExecution = z.object({ version: z.literal(1), protocol: z.literal('explicit-permit-v1'),
  binding: OperatorHandoffExecutionBinding, witness: OperatorCheckWitness.optional(),
  outcome: OperatorHandoffOutcome.optional(), completedAt: z.string().optional(), digest: Hash }).superRefine((record, context) => {
  if (record.witness && JSON.stringify(record.witness.owner) !== JSON.stringify(record.binding.owner)) {
    context.addIssue({ code: 'custom', message: 'operator_handoff_execution_owner_mismatch' });
  }
  if (Boolean(record.outcome) !== Boolean(record.completedAt)) {
    context.addIssue({ code: 'custom', message: 'operator_handoff_execution_completion_invalid' });
  }
});
export type OperatorHandoffExecution = z.infer<typeof OperatorHandoffExecution>;
export const OperatorHandoffResolution = z.object({ receiptID: Identifier, digest: Hash,
  kind: z.enum(['completed', 'stopped-unverified']), prepared: OperatorCheckRecord,
  completed: OperatorCheckRecord.optional(), proof: OperatorPermissionProof.optional(),
  note: z.string().min(1).max(OPERATOR_HANDOFF_RECOVERY_LIMITS.noteChars), executionDigest: Hash,
  inspection: OperatorCheckInspection.optional(), at: z.string().min(1) });
export type OperatorHandoffResolution = z.infer<typeof OperatorHandoffResolution>;

export function operatorHandoffExecutionDigest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function originalHandoffPrepared(receipt: OperatorCheckRecord): OperatorCheckRecord {
  return OperatorCheckRecord.parse({ ...receipt, status: 'prepared', completedAt: undefined, exitCode: undefined,
    output: undefined, outputTruncated: undefined, runtime: undefined, digest: undefined });
}
export function operatorHandoffPreparedDigest(receipt: OperatorCheckRecord) {
  return operatorHandoffExecutionDigest({ id: receipt.id, checkID: receipt.checkID, command: receipt.command,
    callID: receipt.callID, messageID: receipt.messageID, artifactDigest: receipt.artifactDigest,
    startedAt: receipt.startedAt });
}

/** Separate durable runner facts survive a failed update to the primary handoff ledger. */
export class OperatorHandoffExecutionJournal {
  readonly path: string;
  constructor(home: string, readonly binding: OperatorHandoffExecutionBinding) {
    OperatorHandoffExecutionBinding.parse(binding);
    this.path = join(home, 'operator-handoffs', 'executions', `${binding.receiptID}.json`);
  }

  async read(): Promise<OperatorHandoffExecution | undefined> {
    let contents: string;
    try { contents = await readFile(this.path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const record = OperatorHandoffExecution.parse(JSON.parse(contents));
    if (JSON.stringify(record.binding) !== JSON.stringify(this.binding)) throw new Error('operator_handoff_execution_binding_mismatch');
    const { digest, ...payload } = record;
    if (digest !== operatorHandoffExecutionDigest(payload)) throw new Error('operator_handoff_execution_integrity_invalid');
    return record;
  }

  async withSnapshot<T>(action: (record: OperatorHandoffExecution | undefined) => Promise<T>) {
    return withRecordLock(`${this.path}.lock`, async () => action(await this.read()));
  }

  private async update(change: (record: OperatorHandoffExecution) => void) {
    return withRecordLock(`${this.path}.lock`, async () => {
      const record = await this.read() ?? { version: 1 as const, protocol: 'explicit-permit-v1' as const, binding: this.binding, digest: '0'.repeat(64) };
      change(record);
      const parsed = OperatorHandoffExecution.parse(record);
      const { digest: _digest, ...payload } = parsed;
      parsed.digest = operatorHandoffExecutionDigest(payload);
      await writeHandoffFile(this.path, JSON.stringify(parsed, null, 2));
    });
  }

  async start() { await this.update(() => {}); }

  async witness(value: OperatorCheckWitness) {
    const witness = OperatorCheckWitness.parse(value);
    await this.update(record => {
      if (record.outcome || record.witness) throw new Error('operator_handoff_execution_already_started');
      record.witness = witness;
    });
  }

  async finish(value: OperatorCheckRun) {
    const outcome = OperatorHandoffOutcome.parse(value);
    await this.update(record => {
      if (record.outcome && JSON.stringify(record.outcome) !== JSON.stringify(outcome)) throw new Error('operator_handoff_execution_outcome_conflict');
      record.outcome ??= outcome;
      record.completedAt ??= new Date().toISOString();
    });
  }
}
