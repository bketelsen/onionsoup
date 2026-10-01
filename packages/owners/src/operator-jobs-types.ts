import { z } from 'zod';
import { OPERATOR_CHECK_LIMITS, OperatorTaskCheck, OperatorCheckRecord } from './operator-check-types.ts';
import { OperatorWriteSnapshot, OperatorWriteArtifact, OperatorWriteMutation, OperatorWriteReceipt } from './operator-write-workspace.ts';

export const OPERATOR_INVESTIGATOR = 'onionsoup-operator-investigator';
export const OPERATOR_RECOVERY_PERMISSION = 'onionsoup_operator_recovery';
export const OPERATOR_WRITE_PERMISSION = 'onionsoup_operator_write';
export const OPERATOR_JOB_LIMITS = { concurrentChildren: 2, tasksPerJob: 12, textChars: 24_000 };
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Text = z.string().trim().min(1).max(OPERATOR_JOB_LIMITS.textChars);
export const OperatorPermissionProof = z.object({ permissionID: Identifier, sessionID: Identifier, messageID: Identifier,
  reply: z.literal('once'), callID: Text, nonce: z.string().uuid() });
export type OperatorPermissionProof = z.infer<typeof OperatorPermissionProof>;
export const OperatorRecoveryPermissionProof = OperatorPermissionProof;
export type OperatorRecoveryPermissionProof = OperatorPermissionProof;
export const OperatorJobOrigin = z.object({ operator: Text, sessionID: Identifier, directory: Text });
export type OperatorJobOrigin = z.infer<typeof OperatorJobOrigin>;
export const OperatorJobIntake = z.object({ messageID: Identifier, text: Text });
export type OperatorJobIntake = z.infer<typeof OperatorJobIntake>;
export const OperatorTaskInput = z.object({
  id: Identifier, goal: Text, directory: Text, access: z.enum(['read-only', 'write']), dependsOn: z.array(Identifier).default([]),
  files: z.array(Text).optional(), createFiles: z.array(Text).optional(),
  checks: z.array(OperatorTaskCheck).min(1).max(OPERATOR_CHECK_LIMITS.checksPerTask).optional(),
}).superRefine((task, context) => {
  if (task.access === 'write' && !task.files?.length && !task.createFiles?.length) context.addIssue({ code: 'custom', message: 'operator_write_files_required' });
  if (task.access === 'read-only' && (task.files || task.createFiles || task.checks)) {
    context.addIssue({ code: 'custom', message: 'operator_readonly_files_forbidden' });
  }
  if (task.createFiles?.some(path => task.files?.includes(path))) {
    context.addIssue({ code: 'custom', message: 'operator_write_create_scope_overlap' });
  }
  if (task.checks && new Set(task.checks.map(check => check.id)).size !== task.checks.length) {
    context.addIssue({ code: 'custom', message: 'operator_check_duplicate_id' });
  }
});
export const OperatorJobInput = z.object({
  key: Identifier, goal: Text, constraints: z.array(Text), tasks: z.array(OperatorTaskInput).min(1).max(OPERATOR_JOB_LIMITS.tasksPerJob),
});
export type OperatorJobInput = z.infer<typeof OperatorJobInput>;
export const OperatorChildEvidence = z.object({
  sessionID: Identifier, promptID: Identifier, messageID: Identifier, text: Text,
  truncated: z.boolean().optional(), originalChars: z.number().int().nonnegative().optional(),
  fullTextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  tools: z.array(z.object({ callID: Text, tool: Text, status: z.enum(['completed', 'error']) })),
});
export type OperatorChildEvidence = z.infer<typeof OperatorChildEvidence>;
export const OperatorChildAttempt = z.object({
  id: Identifier, messageID: Identifier, createdAt: Text, sentAt: Text.optional(), endedAt: Text.optional(), reason: Text.optional(),
});
export const OperatorWriteOperation = z.object({
  callID: Text, messageID: Identifier, mutation: OperatorWriteMutation,
  status: z.enum(['prepared', 'applied', 'not-applied']), receipt: OperatorWriteReceipt.optional(),
  preparedAt: Text, resolvedAt: Text.optional(),
});
export type OperatorWriteOperation = z.infer<typeof OperatorWriteOperation>;
export const OperatorChildWrite = z.object({
  baseline: OperatorWriteSnapshot,
  approval: z.object({ scopeDigest: Text, proof: OperatorPermissionProof, at: Text }),
  operations: z.array(OperatorWriteOperation),
  checks: z.array(OperatorCheckRecord).max(OPERATOR_CHECK_LIMITS.checksPerTask * OPERATOR_CHECK_LIMITS.attemptsPerCheck).optional(),
  artifact: OperatorWriteArtifact.optional(),
  acceptance: z.object({ digest: Text, proof: OperatorPermissionProof, at: Text }).optional(),
});
export type OperatorChildWrite = z.infer<typeof OperatorChildWrite>;
export const OperatorWriteCreateApproval = z.object({ scopeDigest: Text, proof: OperatorPermissionProof,
  baselines: z.record(Identifier, OperatorWriteSnapshot) });
export type OperatorWriteCreateApproval = z.infer<typeof OperatorWriteCreateApproval>;
export const OperatorChild = OperatorTaskInput.safeExtend({
  title: Text, sessionID: Identifier.optional(),
  status: z.enum(['queued', 'creating', 'dispatching', 'running', 'completed', 'blocked', 'cancelled', 'abandoned', 'needs-review']),
  write: OperatorChildWrite.optional(),
  attempts: z.array(OperatorChildAttempt), evidence: OperatorChildEvidence.optional(), blocker: Text.optional(),
  operation: z.object({ token: Identifier, kind: z.enum(['create', 'dispatch', 'observe', 'adopt', 'abort', 'retry']),
    startedAt: Text, expiresAt: Text }).optional(),
  uncertainty: z.object({ kind: z.enum(['creation', 'dispatch', 'observation']), since: Text, observations: z.number().int().nonnegative(),
    lastObservedAt: Text, nextCheckAt: Text, needsDecision: z.boolean(), reason: Text }).optional(),
  abandonment: z.object({ digest: Text, at: Text, actor: Text, note: Text, unknownOutcome: z.literal(true),
    operationToken: Identifier.optional(), attemptID: Identifier.optional(), messageID: Identifier.optional(),
    approval: OperatorRecoveryPermissionProof }).optional(),
});
export type OperatorChild = z.infer<typeof OperatorChild>;
export const OperatorJobEvent = z.object({
  id: Identifier, at: Text, kind: z.enum(['created', 'progress', 'blocked', 'ready', 'paused', 'resumed', 'cancelled', 'synthesized', 'abandoned', 'recovery-denied', 'write-review', 'write-accepted']),
  childID: Identifier.optional(), detail: Text,
});
export type OperatorJobEvent = z.infer<typeof OperatorJobEvent>;
export const OperatorJob = z.object({
  id: Identifier, origin: OperatorJobOrigin, intake: OperatorJobIntake, key: Identifier,
  goal: Text, constraints: z.array(Text), scope: z.enum(['read-only-investigation', 'scoped-write']),
  createdAt: Text, updatedAt: Text, revision: z.number().int(),
  status: z.enum(['running', 'paused', 'blocked', 'needs-synthesis', 'needs-review', 'completed', 'cancelled']),
  children: z.array(OperatorChild), events: z.array(OperatorJobEvent),
  synthesis: z.object({ digest: Text, evidenceIDs: z.array(Identifier), text: Text, at: Text }).optional(),
});
export type OperatorJob = z.infer<typeof OperatorJob>;
export const OperatorJobLedger = z.object({ version: z.literal(1), jobs: z.array(OperatorJob) });
export type OperatorJobLedger = z.infer<typeof OperatorJobLedger>;

/** Trusted runtime projection, never inferred from a model's claimed completion. */
export interface OperatorSessionMessage {
  id: string;
  role: 'user' | 'assistant';
  parentID?: string;
  completed?: boolean;
  error?: string;
  text: string;
  tools: Array<{ callID: string; tool: string; status: 'pending' | 'running' | 'completed' | 'error' }>;
}
export interface OperatorSessionSnapshot {
  status: 'idle' | 'busy' | 'retry';
  messages: OperatorSessionMessage[];
}
export interface OperatorSupervisorClient {
  listSessions(directory: string, options?: OperatorClientOptions): Promise<Array<{ id: string; title: string }>>;
  createSession(directory: string, title: string, options?: OperatorClientOptions): Promise<{ id: string }>;
  readSession(directory: string, sessionID: string, options?: OperatorClientOptions): Promise<OperatorSessionSnapshot>;
  prompt(directory: string, sessionID: string, messageID: string, text: string, options?: OperatorClientOptions): Promise<void>;
  abort(directory: string, sessionID: string, options?: OperatorClientOptions): Promise<void>;
}
export interface OperatorClientOptions { signal?: AbortSignal }

export interface OperatorWriteHost {
  inspect(job: OperatorJob, child: OperatorChild, snapshot: OperatorSessionSnapshot): Promise<z.infer<typeof OperatorWriteArtifact>>;
}
