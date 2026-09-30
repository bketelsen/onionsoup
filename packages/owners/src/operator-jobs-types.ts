import { z } from 'zod';

export const OPERATOR_INVESTIGATOR = 'onionsoup-operator-investigator';
export const OPERATOR_JOB_LIMITS = { concurrentChildren: 2, tasksPerJob: 12, textChars: 24_000 };
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Text = z.string().trim().min(1).max(OPERATOR_JOB_LIMITS.textChars);
export const OperatorJobOrigin = z.object({ operator: Text, sessionID: Identifier, directory: Text });
export type OperatorJobOrigin = z.infer<typeof OperatorJobOrigin>;
export const OperatorJobIntake = z.object({ messageID: Identifier, text: Text });
export type OperatorJobIntake = z.infer<typeof OperatorJobIntake>;
export const OperatorTaskInput = z.object({
  id: Identifier, goal: Text, directory: Text, access: z.literal('read-only'), dependsOn: z.array(Identifier).default([]),
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
export const OperatorChild = OperatorTaskInput.extend({
  title: Text, sessionID: Identifier.optional(),
  status: z.enum(['queued', 'creating', 'dispatching', 'running', 'completed', 'blocked', 'cancelled']),
  attempts: z.array(OperatorChildAttempt), evidence: OperatorChildEvidence.optional(), blocker: Text.optional(),
});
export type OperatorChild = z.infer<typeof OperatorChild>;
export const OperatorJobEvent = z.object({
  id: Identifier, at: Text, kind: z.enum(['created', 'progress', 'blocked', 'ready', 'paused', 'resumed', 'cancelled', 'synthesized']),
  childID: Identifier.optional(), detail: Text,
});
export type OperatorJobEvent = z.infer<typeof OperatorJobEvent>;
export const OperatorJob = z.object({
  id: Identifier, origin: OperatorJobOrigin, intake: OperatorJobIntake, key: Identifier,
  goal: Text, constraints: z.array(Text), scope: z.literal('read-only-investigation'),
  createdAt: Text, updatedAt: Text, revision: z.number().int(),
  status: z.enum(['running', 'paused', 'blocked', 'needs-synthesis', 'completed', 'cancelled']),
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
  listSessions(directory: string): Promise<Array<{ id: string; title: string }>>;
  createSession(directory: string, title: string): Promise<{ id: string }>;
  readSession(directory: string, sessionID: string): Promise<OperatorSessionSnapshot>;
  prompt(directory: string, sessionID: string, messageID: string, text: string): Promise<void>;
  abort(directory: string, sessionID: string): Promise<void>;
}
