import { z } from 'zod';
import { OperatorChildEvidence, OperatorChildWrite, OperatorJobIntake, OperatorJobOrigin,
  OperatorTaskInput, OPERATOR_JOB_LIMITS } from './operator-jobs-types.ts';
import { OperatorCheckCommand } from './operator-check-types.ts';
import { OPERATOR_WRITE_LIMITS } from './operator-write-workspace.ts';

export const OPERATOR_HANDOFF_LIMITS = { checks: 4, diffBytes: 32 * 1024 * 1024,
  sourceBytes: OPERATOR_WRITE_LIMITS.treeBytes, sourceFiles: OPERATOR_WRITE_LIMITS.trackedFiles + OPERATOR_WRITE_LIMITS.approvedFiles,
  changedFiles: OPERATOR_JOB_LIMITS.tasksPerJob * OPERATOR_WRITE_LIMITS.approvedFiles };
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const OperatorHandoffChild = OperatorTaskInput.safeExtend({
  artifactDigest: Hash.optional(), approvalScopeDigest: Hash.optional(), acceptanceDigest: Hash.optional(),
  approval: OperatorChildWrite.shape.approval.optional(), acceptance: OperatorChildWrite.shape.acceptance,
  evidence: OperatorChildEvidence,
});
export type OperatorHandoffChild = z.infer<typeof OperatorHandoffChild>;
export const OperatorHandoffCheck = z.object({ id: z.string().min(1), command: OperatorCheckCommand,
  provenance: z.array(z.object({ childID: z.string().min(1), checkID: z.string().min(1) })).min(1) });
export type OperatorHandoffCheck = z.infer<typeof OperatorHandoffCheck>;
export const OperatorHandoffArtifact = z.object({
  version: z.literal(1), digest: Hash, jobID: z.string().min(1), origin: OperatorJobOrigin, intake: OperatorJobIntake,
  goal: z.string().min(1), constraints: z.array(z.string()),
  base: z.object({ commonDirectory: z.string().min(1), head: z.string().min(1), tree: z.string().min(1), sourceDigest: Hash }),
  children: z.array(OperatorHandoffChild).min(1).max(OPERATOR_JOB_LIMITS.tasksPerJob),
  files: z.array(z.object({ path: z.string().min(1), beforeSha256: z.union([Hash, z.literal('absent')]),
    afterSha256: Hash, mode: z.number().int(), childID: z.string().min(1) })).max(OPERATOR_HANDOFF_LIMITS.changedFiles),
  diff: z.string().max(OPERATOR_HANDOFF_LIMITS.diffBytes), diffSha256: Hash, sourceDigest: Hash,
  checks: z.array(OperatorHandoffCheck).max(OPERATOR_HANDOFF_LIMITS.checks),
});
export type OperatorHandoffArtifact = z.infer<typeof OperatorHandoffArtifact>;
