import { randomUUID } from 'node:crypto';
import { OperatorApplicationStore } from './operator-application-store.ts';
import { OPERATOR_APPLICATION_LIMITS, type OperatorApplication, type OperatorApplicationAttempt } from './operator-application-types.ts';
import { prepareOperatorApplicationFile, runOperatorApplicationFile, inspectOperatorApplicationFile,
  cleanupOperatorApplicationStage } from './operator-application-writer.ts';
import { inspectOperatorCheckOwner, inspectOperatorCheckWitness, readOperatorCheckOwner } from './operator-check-execution.ts';
import { operatorWriteSha256, validateOperatorWriteWorkspace, validateOperatorApplicationWorkspace, type OperatorWriteMutation } from './operator-write-workspace.ts';

export const operatorApplicationEffects = { prepare: prepareOperatorApplicationFile, run: runOperatorApplicationFile,
  inspect: inspectOperatorApplicationFile, cleanup: cleanupOperatorApplicationStage };
export type OperatorApplicationEffects = typeof operatorApplicationEffects;
export function applicationReceipts(record: OperatorApplication) {
  return record.operations.flatMap(operation => operation.receipt ? [operation.receipt] : []);
}
export async function mutateApplication(store: OperatorApplicationStore, id: string, action: (record: OperatorApplication) => void) {
  return store.transaction(id, async (record, save) => {
    if (!record) throw new Error('operator_application_missing');
    action(record);
    await save(record);
    return record;
  });
}
export async function applicationAttemptInspection(attempt: OperatorApplicationAttempt) {
  if (attempt.inspection?.state === 'stopped' && attempt.inspection.proof) return attempt.inspection;
  return attempt.witness ? inspectOperatorCheckWitness(attempt.witness) : inspectOperatorCheckOwner(attempt.owner);
}

/** One worker holds the execution lock. Ledger transactions only persist facts, never wait on a subprocess. */
export class OperatorApplicationFiles {
  constructor(readonly store: OperatorApplicationStore, readonly effects = operatorApplicationEffects) {}
  private async record(id: string) {
    const record = await this.store.read(id);
    if (!record) throw new Error('operator_application_missing');
    return record;
  }
  private operation(record: OperatorApplication, mutationID: string) {
    const operation = record.operations.find(candidate => candidate.mutationID === mutationID);
    if (!operation) throw new Error('operator_application_operation_missing');
    return operation;
  }
  private async prepare(id: string, mutation: OperatorWriteMutation) {
    const record = await this.record(id);
    const existing = record.operations.find(operation => operation.mutationID === mutation.id);
    if (existing) {
      if (!existing.intent) throw new Error('operator_application_preparation_uncertain');
      return;
    }
    await validateOperatorWriteWorkspace(record.scope.target, applicationReceipts(record));
    await mutateApplication(this.store, id, current => {
      current.operations.push({ mutationID: mutation.id, status: 'preparing', attempts: [] });
    });
    const mode = record.scope.artifact.files.find(file => file.path === mutation.path)!.mode;
    const intent = await this.effects.prepare(record.scope.target, mutation, mode);
    await mutateApplication(this.store, id, current => {
      const operation = this.operation(current, mutation.id);
      operation.intent = intent;
      operation.status = 'prepared';
    });
  }
  private async observe(id: string, mutation: OperatorWriteMutation) {
    const operation = this.operation(await this.record(id), mutation.id);
    const attempt = operation.attempts.at(-1);
    if (!attempt) return 'before' as const;
    const inspection = await applicationAttemptInspection(attempt);
    if (inspection.state !== 'stopped' || !inspection.proof) throw new Error('operator_application_execution_unproven');
    const observation = await this.effects.inspect(operation.intent!, inspection, attempt.owner);
    await mutateApplication(this.store, id, current => {
      const latest = this.operation(current, mutation.id).attempts.at(-1)!;
      Object.assign(latest, { inspection, observation, endedAt: new Date().toISOString() });
    });
    return observation.state;
  }
  private async run(id: string, mutation: OperatorWriteMutation) {
    const record = await this.record(id);
    const operation = this.operation(record, mutation.id);
    await validateOperatorApplicationWorkspace(record.scope.target, applicationReceipts(record), [operation.intent!.stage]);
    if (operation.attempts.length >= OPERATOR_APPLICATION_LIMITS.attemptsPerFile) throw new Error('operator_application_attempt_limit');
    const attempt: OperatorApplicationAttempt = { id: `attempt_${randomUUID()}`,
      owner: await readOperatorCheckOwner(), startedAt: new Date().toISOString() };
    await mutateApplication(this.store, id, current => this.operation(current, mutation.id).attempts.push(attempt));
    const outcome = await this.effects.run(operation.intent!, { onWitness: async witness => {
      if (JSON.stringify(witness.owner) !== JSON.stringify(attempt.owner)) throw new Error('operator_application_owner_mismatch');
      await mutateApplication(this.store, id, current => { this.operation(current, mutation.id).attempts.at(-1)!.witness = witness; });
    } });
    await mutateApplication(this.store, id, current => {
      Object.assign(this.operation(current, mutation.id).attempts.at(-1)!, outcome, { endedAt: new Date().toISOString() });
    });
    if (outcome.observation.state !== 'after') throw new Error(`operator_application_${outcome.observation.state}`);
  }
  private async receipt(id: string, mutation: OperatorWriteMutation) {
    let operation = this.operation(await this.record(id), mutation.id);
    const attempt = operation.attempts.at(-1)!;
    if (attempt.observation?.state !== 'after' || attempt.inspection?.state !== 'stopped') throw new Error('operator_application_receipt_unproven');
    await mutateApplication(this.store, id, current => { this.operation(current, mutation.id).status = 'published'; });
    await this.effects.cleanup(operation.intent!, attempt.inspection, attempt.owner);
    const observed = await this.effects.inspect(operation.intent!, attempt.inspection, attempt.owner);
    if (observed.state !== 'after' || observed.stage || observed.target?.links !== 1) throw new Error('operator_application_cleanup_unproven');
    const body = { mutationID: mutation.id, path: mutation.path, beforeSha256: mutation.beforeSha256,
      afterSha256: mutation.afterSha256, snapshotDigest: mutation.snapshotDigest,
      ...(mutation.beforeSha256 === 'absent' ? { created: observed.target } : {}) };
    await mutateApplication(this.store, id, current => {
      operation = this.operation(current, mutation.id);
      operation.receipt = { ...body, digest: operatorWriteSha256(JSON.stringify(body)) };
      operation.status = 'applied';
    });
  }
  async apply(id: string, mutation: OperatorWriteMutation) {
    const existing = (await this.record(id)).operations.find(operation => operation.mutationID === mutation.id);
    if (existing?.status === 'applied') return;
    await this.prepare(id, mutation);
    const state = await this.observe(id, mutation);
    const observedActions: Partial<Record<typeof state, () => Promise<void>>> = {
      before: () => this.run(id, mutation), after: async () => undefined,
    };
    const proceed = observedActions[state];
    if (!proceed) throw new Error(`operator_application_${state}`);
    await proceed();
    await this.receipt(id, mutation);
  }
}
