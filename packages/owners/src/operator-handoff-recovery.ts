import type { ToolContext } from '@opencode-ai/plugin';
import { inspectMatchedAdmission, releaseMatchedAdmission } from './deployment-admission.ts';
import { inspectOperatorCheckOwner, inspectOperatorCheckWitness, type OperatorCheckInspection } from './operator-check-execution.ts';
import { operatorCheckRecordDigest, type OperatorCheckRecord } from './operator-check-types.ts';
import type { OperatorJobOrigin, OperatorPermissionProof } from './operator-jobs-types.ts';
import { operatorJobDigest } from './operator-jobs.ts';
import type { OperatorRecoveryPermissions } from './operator-recovery-permission.ts';
import type { OperatorHandoffs } from './operator-handoff-host.ts';
import { OperatorHandoffExecutionJournal, OperatorHandoffOutcome, OPERATOR_HANDOFF_RECOVERY_LIMITS,
  operatorHandoffExecutionDigest, originalHandoffPrepared,
  type OperatorHandoffExecution, type OperatorHandoffExecutionBinding, type OperatorHandoffResolution } from './operator-handoff-execution.ts';

export { OPERATOR_HANDOFF_RECOVERY_LIMITS } from './operator-handoff-execution.ts';
type Context = Pick<ToolContext, 'agent' | 'directory' | 'sessionID' | 'messageID' | 'abort' | 'ask' | 'metadata'>;
type Inspections = { owner: typeof inspectOperatorCheckOwner; witness: typeof inspectOperatorCheckWitness };
export interface OperatorHandoffRecoveryPreview {
  kind: 'operator-handoff-recovery'; jobID: string; receiptID: string; digest: string; eligible: boolean;
  action?: 'reconcile-completed' | 'release-stopped-unverified'; reason: string;
  execution?: OperatorHandoffExecution; inspection?: OperatorCheckInspection; resolution?: OperatorHandoffResolution;
  originalGoal: string; warning: string; completedReceipt?: OperatorCheckRecord;
}
const warning = 'This action never runs the command again. A stopped check without a saved outcome remains unverified, '
  + 'not passed. One-time approval releases only its exact proven-stopped reservation and linked admission. '
  + 'Original evidence and any later facts remain preserved; no replacement or persistent grant is created.';

/** Recover resource bookkeeping from host facts, never from a model assertion or elapsed timeout. */
export class OperatorHandoffRecovery {
  constructor(readonly handoffs: OperatorHandoffs, readonly permissions: OperatorRecoveryPermissions,
    readonly inspections: Inspections = { owner: inspectOperatorCheckOwner, witness: inspectOperatorCheckWitness }) {}

  private context(origin: OperatorJobOrigin, context: Context) {
    context.abort.throwIfAborted();
    if (context.agent !== this.handoffs.jobs.operator || context.sessionID !== origin.sessionID
      || context.directory !== origin.directory) throw new Error('operator_handoff_recovery_origin_mismatch');
  }

  private async state(origin: OperatorJobOrigin, id: string, receiptID: string) {
    const job = await this.handoffs.jobs.get(origin, id);
    const record = (await this.handoffs.store.read()).records.find(candidate => candidate.artifact.jobID === id);
    const receipt = record?.checks.find(candidate => candidate.id === receiptID);
    if (!record || !receipt) throw new Error('operator_handoff_recovery_receipt_missing');
    const binding = record.executions?.find(candidate => candidate.receiptID === receiptID);
    const resolution = record.resolutions?.find(candidate => candidate.receiptID === receiptID);
    return { job, record, receipt, binding, resolution };
  }

  private async inspect(binding: OperatorHandoffExecutionBinding | undefined, receipt: OperatorCheckRecord) {
    if (!binding) return { reason: 'operator_handoff_recovery_legacy_proof_missing' };
    const admitted = await inspectMatchedAdmission(this.handoffs.jobs.home, binding.admission);
    if (receipt.status === 'completed' && !admitted) return { reason: 'operator_handoff_recovery_already_completed' };
    const execution = await new OperatorHandoffExecutionJournal(this.handoffs.jobs.home, binding).read();
    if (receipt.status === 'completed') {
      if (execution?.outcome && JSON.stringify(execution.outcome) !== JSON.stringify(OperatorHandoffOutcome.parse(receipt))) {
        throw new Error('operator_handoff_recovery_outcome_mismatch');
      }
      return { execution, completedReceipt: receipt, reason: 'operator_handoff_recovery_completed_cleanup', action: 'reconcile-completed' as const };
    }
    if (!execution) return { reason: 'operator_handoff_recovery_execution_missing' };
    if (execution.outcome) return { execution, reason: 'operator_handoff_recovery_completed', action: 'reconcile-completed' as const };
    const inspection = execution.witness ? await this.inspections.witness(execution.witness)
      : await this.inspections.owner(binding.owner);
    if (inspection.state !== 'stopped' || !inspection.proof) return { execution, inspection, reason: inspection.reason };
    if (JSON.stringify(inspection.proof.owner) !== JSON.stringify(binding.owner)
      || (execution.witness && (JSON.stringify(inspection.proof.launcher) !== JSON.stringify(execution.witness.launcher)
        || JSON.stringify(inspection.proof.namespace) !== JSON.stringify(execution.witness.namespace)))) {
      throw new Error('operator_handoff_recovery_proof_mismatch');
    }
    return { execution, inspection, reason: execution.witness ? 'operator_handoff_recovery_stopped_unknown'
      : 'operator_handoff_recovery_never_started', action: 'release-stopped-unverified' as const };
  }

  private digest(state: Awaited<ReturnType<OperatorHandoffRecovery['state']>>, execution?: OperatorHandoffExecution) {
    return operatorHandoffExecutionDigest({ job: operatorJobDigest(state.job), status: state.job.status,
      artifact: state.record.artifact.digest, receipt: state.receipt, binding: state.binding, execution });
  }

  async preview(origin: OperatorJobOrigin, id: string, receiptID: string): Promise<OperatorHandoffRecoveryPreview> {
    const state = await this.state(origin, id, receiptID);
    const base = { kind: 'operator-handoff-recovery' as const, jobID: id, receiptID,
      originalGoal: state.record.artifact.goal, warning };
    if (state.resolution) return { ...base, digest: state.resolution.digest, eligible: false,
      reason: 'operator_handoff_recovery_already_resolved', resolution: state.resolution,
      execution: state.binding ? await new OperatorHandoffExecutionJournal(this.handoffs.jobs.home, state.binding).read() : undefined };
    const inspected = await this.inspect(state.binding, state.receipt);
    const digest = this.digest(state, inspected.execution);
    const fresh = await this.state(origin, id, receiptID);
    if (this.digest(fresh, inspected.execution) !== digest || fresh.resolution) throw new Error('operator_handoff_recovery_stale');
    return { ...base, ...inspected, digest, eligible: Boolean(inspected.action) };
  }

  async recover(origin: OperatorJobOrigin, id: string, receiptID: string, digest: string, note: string, context: Context) {
    this.context(origin, context);
    if (!note.trim() || note.length > OPERATOR_HANDOFF_RECOVERY_LIMITS.noteChars) throw new Error('operator_handoff_recovery_note_invalid');
    const previous = await this.state(origin, id, receiptID);
    if (previous.resolution) return this.reuse(previous, digest, note);
    const preview = await this.preview(origin, id, receiptID);
    if (preview.digest !== digest) throw new Error('operator_handoff_recovery_stale');
    if (!preview.eligible) throw new Error(`operator_handoff_recovery_ineligible:${preview.reason}`);
    const proof = await this.approval(preview, note, context);
    this.context(origin, context);
    const fresh = await this.preview(origin, id, receiptID);
    if (fresh.resolution) return this.reuse(await this.state(origin, id, receiptID), digest, note);
    if (!fresh.eligible || fresh.digest !== digest || fresh.action !== preview.action) throw new Error('operator_handoff_recovery_stale');
    const resolution = await this.commit(origin, id, receiptID, fresh, note, proof, context);
    const state = await this.state(origin, id, receiptID);
    await releaseMatchedAdmission(this.handoffs.jobs.home, state.binding!.admission);
    return resolution;
  }

  private async approval(preview: OperatorHandoffRecoveryPreview, note: string, context: Context) {
    if (preview.action === 'reconcile-completed') return undefined;
    context.metadata({ title: `Release stopped check: ${preview.jobID}/${preview.receiptID}` });
    return this.permissions.ask(context, { patterns: [`handoff/${preview.jobID}/${preview.receiptID}/${preview.digest}`],
      metadata: { ...preview, note, action: 'Release only this stopped check without passing it or running it again', approvalScope: 'once' } });
  }

  private async reuse(state: Awaited<ReturnType<OperatorHandoffRecovery['state']>>, digest: string, note: string) {
    if (!state.resolution || state.resolution.digest !== digest || state.resolution.note !== note) {
      throw new Error('operator_handoff_recovery_idempotency_conflict');
    }
    if (!state.binding) throw new Error('operator_handoff_recovery_execution_missing');
    await releaseMatchedAdmission(this.handoffs.jobs.home, state.binding.admission);
    return state.resolution;
  }

  private async commit(origin: OperatorJobOrigin, id: string, receiptID: string, preview: OperatorHandoffRecoveryPreview,
    note: string, proof: OperatorPermissionProof | undefined, context: Context) {
    // Process inspection and the native permission round trip are outside both mutation locks.
    return this.handoffs.jobs.transaction(async jobs => {
      const job = this.handoffs.jobs.bound(jobs, origin, id);
      return this.handoffs.store.transaction(async (ledger, save) => {
        this.context(origin, context);
        const record = ledger.records.find(candidate => candidate.artifact.jobID === id)!;
        const receipt = record.checks.find(candidate => candidate.id === receiptID)!;
        const binding = record.executions?.find(candidate => candidate.receiptID === receiptID);
        const previous = record.resolutions?.find(candidate => candidate.receiptID === receiptID);
        if (previous) {
          if (previous.digest !== preview.digest || previous.note !== note) throw new Error('operator_handoff_recovery_idempotency_conflict');
          return previous;
        }
        if (!binding || (receipt.status === 'completed' && preview.action !== 'reconcile-completed')) throw new Error('operator_handoff_recovery_stale');
        const journal = new OperatorHandoffExecutionJournal(this.handoffs.jobs.home, binding);
        return journal.withSnapshot(async execution => {
          const state = { job, record, receipt, binding, resolution: undefined };
          if (this.digest(state, execution) !== preview.digest) throw new Error('operator_handoff_recovery_stale');
          const resolution = makeResolution(receipt, preview, note, proof);
          if (proof && ledger.records.some(candidate => candidate.resolutions?.some(entry => entry.proof?.nonce === proof.nonce))) {
            throw new Error('operator_handoff_recovery_permission_reused');
          }
          (record.resolutions ??= []).push(resolution);
          await save();
          return resolution;
        });
      });
    });
  }
}

function makeResolution(receipt: OperatorCheckRecord, preview: OperatorHandoffRecoveryPreview,
  note: string, proof: OperatorPermissionProof | undefined): OperatorHandoffResolution {
  const completed = completedResolutionReceipt(receipt, preview);
  return { receiptID: receipt.id, digest: preview.digest,
    kind: completed ? 'completed' : 'stopped-unverified', prepared: originalHandoffPrepared(receipt), ...(completed ? { completed } : {}),
    ...(proof ? { proof } : {}), note, executionDigest: operatorHandoffExecutionDigest(preview.execution ?? null),
    ...(preview.inspection ? { inspection: preview.inspection } : {}), at: new Date().toISOString() };
}

function completedResolutionReceipt(receipt: OperatorCheckRecord, preview: OperatorHandoffRecoveryPreview) {
  if (preview.action !== 'reconcile-completed') return undefined;
  if (preview.completedReceipt) return { ...preview.completedReceipt };
  const execution = preview.execution;
  if (!execution?.outcome || !execution.completedAt) throw new Error('operator_handoff_recovery_completion_missing');
  const completed: OperatorCheckRecord = { ...receipt, ...execution.outcome, status: 'completed', completedAt: execution.completedAt };
  completed.digest = operatorCheckRecordDigest(completed);
  return completed;
}
