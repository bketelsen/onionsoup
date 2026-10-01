import { z } from 'zod';
import { AdmissionRecord } from './deployment-admission.ts';
import { OperatorCheckOwner, OperatorCheckWitness, OperatorCheckInspection } from './operator-check-execution.ts';
import { OperatorCheckRecord, operatorCheckRecordDigest } from './operator-check-types.ts';
import { operatorHandoffArtifactDigest, operatorHandoffBaselineDigest } from './operator-handoff-artifact.ts';
import { OperatorPermissionProof } from './operator-jobs-types.ts';
import { OperatorHandoffArtifact } from './operator-handoff-types.ts';
import { OperatorWriteSnapshot, OperatorWriteMutation, OperatorWriteReceipt, operatorWriteSha256 } from './operator-write-workspace.ts';
import { OperatorApplicationFileIntent, OperatorApplicationFileObservation } from './operator-application-writer-types.ts';

export const OPERATOR_APPLICATION_LIMITS = { attemptsPerFile: 4, diffPreviewChars: 12_000 };
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Scope = z.object({ version: z.literal(1), jobDigest: Hash, artifact: OperatorHandoffArtifact,
  checks: z.array(OperatorCheckRecord).min(1), target: OperatorWriteSnapshot,
  mutations: z.array(OperatorWriteMutation).min(1), digest: Hash });
export function operatorApplicationScopeDigest(input: z.infer<typeof Scope>) {
  const { digest: _digest, ...body } = Scope.parse(input);
  return operatorWriteSha256(JSON.stringify(body));
}
export const OperatorApplicationScope = Scope.superRefine((scope, context) => {
  const { digest: targetDigest, ...targetBody } = scope.target;
  const changed = scope.artifact.files.filter(file => file.beforeSha256 !== file.afterSha256);
  if (scope.digest !== operatorApplicationScopeDigest(scope)
    || targetDigest !== operatorWriteSha256(JSON.stringify(targetBody))
    || scope.artifact.digest !== operatorHandoffArtifactDigest(scope.artifact)
    || scope.target.head !== scope.artifact.base.head || scope.target.tree !== scope.artifact.base.tree
    || operatorHandoffBaselineDigest(scope.target) !== scope.artifact.base.sourceDigest
    || scope.artifact.diffSha256 !== operatorWriteSha256(scope.artifact.diff)
    || scope.mutations.length !== changed.length
    || scope.target.approvedPaths.length !== changed.length
    || new Set(scope.mutations.map(mutation => mutation.path)).size !== scope.mutations.length
    || scope.mutations.some(mutation => mutation.snapshotDigest !== scope.target.digest
      || mutation.beforeSha256 === mutation.afterSha256
      || !scope.target.approvedPaths.includes(mutation.path)
      || mutation.afterSha256 !== operatorWriteSha256(mutation.content)
      || !scope.artifact.files.some(file => file.path === mutation.path
        && file.beforeSha256 === mutation.beforeSha256 && file.afterSha256 === mutation.afterSha256))
    || scope.checks.some(check => check.status !== 'completed' || check.exitCode !== 0
      || check.artifactDigest !== scope.artifact.digest || check.digest !== operatorCheckRecordDigest(check)
      || !scope.artifact.checks.some(command => command.id === check.checkID
        && JSON.stringify(command.command) === JSON.stringify(check.command)))
    || scope.artifact.checks.length !== scope.checks.length
    || new Set(scope.checks.map(check => check.checkID)).size !== scope.checks.length) {
    context.addIssue({ code: 'custom', message: 'operator_application_scope_invalid' });
  }
});
export type OperatorApplicationScope = z.infer<typeof OperatorApplicationScope>;
export const OperatorApplicationAttempt = z.object({ id: Identifier, owner: OperatorCheckOwner,
  startedAt: z.string(), witness: OperatorCheckWitness.optional(), inspection: OperatorCheckInspection.optional(),
  observation: OperatorApplicationFileObservation.optional(), exitCode: z.number().int().optional(), endedAt: z.string().optional() })
  .superRefine((attempt, context) => {
    if (!validAttemptInspection(attempt)) context.addIssue({ code: 'custom', message: 'operator_application_stop_proof_mismatch' });
  });
export type OperatorApplicationAttempt = z.infer<typeof OperatorApplicationAttempt>;
export const OperatorApplicationOperation = z.object({ mutationID: Identifier,
  status: z.enum(['preparing', 'prepared', 'published', 'applied']), intent: OperatorApplicationFileIntent.optional(),
  attempts: z.array(OperatorApplicationAttempt), receipt: OperatorWriteReceipt.optional() });
export type OperatorApplicationOperation = z.infer<typeof OperatorApplicationOperation>;
export const OperatorApplication = z.object({ version: z.literal(1), id: Identifier, token: Identifier,
  scope: OperatorApplicationScope, approval: z.object({ proof: OperatorPermissionProof, at: z.string() }),
  status: z.enum(['approved', 'applying', 'blocked', 'applied']), reason: z.string().optional(),
  claimReleasedAt: z.string().optional(),
  operations: z.array(OperatorApplicationOperation),
  workers: z.array(z.object({ id: Identifier, owner: OperatorCheckOwner, admission: AdmissionRecord,
    startedAt: z.string(), endedAt: z.string().optional() })),
  result: z.object({ sourceDigest: Hash, diff: z.string(), diffSha256: Hash, at: z.string() }).optional(),
}).superRefine((record, context) => {
  if (record.approval.proof.sessionID !== record.scope.artifact.origin.sessionID
    || new Set(record.operations.map(operation => operation.mutationID)).size !== record.operations.length
    || record.operations.some(operation => {
      const mutation = record.scope.mutations.find(candidate => candidate.id === operation.mutationID);
      return !mutation || (operation.intent && JSON.stringify(operation.intent.mutation) !== JSON.stringify(mutation))
        || (operation.status !== 'preparing' && !operation.intent)
        || (operation.intent && operation.intent.directory !== record.scope.target.directory)
        || (operation.status === 'applied') !== Boolean(operation.receipt)
        || (operation.receipt && !validReceipt(mutation, operation.receipt))
        || operation.attempts.some(attempt => (attempt.witness
          && JSON.stringify(attempt.witness.owner) !== JSON.stringify(attempt.owner))
          || (attempt.inspection?.proof && JSON.stringify(attempt.inspection.proof.owner) !== JSON.stringify(attempt.owner)));
    }) || record.workers.some(worker => worker.admission.kind !== 'plugin:operator-application'
      || worker.owner.pid !== worker.admission.pid || worker.owner.started !== worker.admission.startTime)
    || (record.status === 'applied' && (!record.result
      || record.operations.length !== record.scope.mutations.length
      || record.operations.some(operation => operation.status !== 'applied')
      || record.result.sourceDigest !== record.scope.artifact.sourceDigest
      || record.result.diffSha256 !== operatorWriteSha256(record.result.diff)))) {
    context.addIssue({ code: 'custom', message: 'operator_application_record_invalid' });
  }
});
export type OperatorApplication = z.infer<typeof OperatorApplication>;

function validReceipt(mutation: z.infer<typeof OperatorWriteMutation>, receipt: z.infer<typeof OperatorWriteReceipt>) {
  const { digest, ...body } = receipt;
  return digest === operatorWriteSha256(JSON.stringify(body)) && receipt.mutationID === mutation.id
    && receipt.snapshotDigest === mutation.snapshotDigest && receipt.path === mutation.path
    && receipt.beforeSha256 === mutation.beforeSha256 && receipt.afterSha256 === mutation.afterSha256
    && (mutation.beforeSha256 === 'absent' ? Boolean(receipt.created
      && receipt.created.path === mutation.path && receipt.created.sha256 === mutation.afterSha256
      && receipt.created.links === 1 && receipt.created.birthtimeNs) : !receipt.created);
}

function validAttemptInspection(attempt: { owner: OperatorCheckOwner; witness?: OperatorCheckWitness; inspection?: OperatorCheckInspection }) {
  const inspection = attempt.inspection;
  if (!inspection || inspection.state !== 'stopped') return true;
  if (!inspection.proof || JSON.stringify(inspection.proof.owner) !== JSON.stringify(attempt.owner)) return false;
  if (attempt.witness) return JSON.stringify(inspection.proof.launcher) === JSON.stringify(attempt.witness.launcher)
    && JSON.stringify(inspection.proof.namespace) === JSON.stringify(attempt.witness.namespace);
  return !inspection.proof.launcher && !inspection.proof.namespace
    && ['operator_application_permit_not_sent', 'operator_check_owner_stopped'].includes(inspection.reason);
}
