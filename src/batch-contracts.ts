import { z } from 'zod';
import { IssueSnapshot } from './contracts.ts';

export const ModelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const BatchCase = z.object({
  input: IssueSnapshot, inputHash: z.string(), url: z.string().url(),
  commentsExcluded: z.number().int().nonnegative(),
  bucket: z.enum(['short', 'feature', 'intermittent', 'detailed']),
  declaredAgentGenerated: z.boolean(),
}).strict();
export type BatchCase = z.infer<typeof BatchCase>;
export const BatchManifest = z.object({
  schemaVersion: z.literal(1), batchId: z.string().uuid(), capturedAt: z.iso.datetime(),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  provider: z.enum(['copilot', 'codex']), models: z.array(ModelId).min(1).max(3),
  selection: z.object({ seed: z.string(), before: z.number().int().positive().nullable(),
    requestedCount: z.number().int().min(1).max(50), fetchedEntries: z.number(),
    eligibleCount: z.number(), rejectedCount: z.number(), method: z.string() }).strict(),
  frozen: z.object({ promptVersion: z.string(), promptText: z.string(),
    files: z.record(z.string(), z.string()) }).strict(),
  criteria: z.object({ minimumCases: z.literal(30), acceptanceRate: z.literal(0.9),
    allowedFalseReady: z.literal(0), costDecision: z.literal('human_required') }).strict(),
  cases: z.array(BatchCase).min(1).max(50),
}).strict();
export type BatchManifest = z.infer<typeof BatchManifest>;

export const Feedback = z.object({
  batchId: z.string().uuid(), model: ModelId, issue: z.number().int().positive(),
  runId: z.string().uuid(), reviewer: z.string().trim().min(1).max(100),
  role: z.enum(['operator', 'maintainer']), verdict: z.enum(['accept', 'revise', 'reject']),
  falseReady: z.boolean(), unnecessaryQuestions: z.boolean(),
  overlookedEvidence: z.boolean(), unsupportedClaims: z.boolean(),
  notes: z.string().max(6000),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === 'accept' && (value.falseReady || value.unnecessaryQuestions || value.overlookedEvidence || value.unsupportedClaims))
    ctx.addIssue({ code: 'custom', message: 'An unchanged acceptance cannot also flag a quality defect' });
  if (value.verdict !== 'accept' && !value.notes.trim())
    ctx.addIssue({ code: 'custom', message: 'Explain what needs revision or why the assessment is rejected' });
});
export type Feedback = z.infer<typeof Feedback>;
export const FeedbackFile = z.object({ schemaVersion: z.literal(1), reviews: z.array(Feedback) }).strict();
export const CostDecision = z.object({
  acceptable: z.boolean(), reviewer: z.string().trim().min(1).max(100),
  note: z.string().trim().min(1).max(2000), recordedAt: z.iso.datetime(),
}).strict();
export type CostDecision = z.infer<typeof CostDecision>;
