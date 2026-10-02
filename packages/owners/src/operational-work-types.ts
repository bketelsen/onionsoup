import { z } from 'zod';
import { Verdict } from './artifacts.ts';
import { ChatOrigin } from './chat-origin.ts';
import { ReviewEvidence } from './desk-reviews.ts';

/** Host observations of existing gated resource requests, never model-selected resources. */
export const OperationalEffect = z.object({
  request: z.string(), kind: z.literal('instance'), owner: z.string(),
  remote: z.string(), name: z.string(), image: z.string(),
  createApproval: z.string(), deleteApproval: z.string(),
  followUp: z.string(), followedUpAt: z.string().datetime().optional(),
  postcondition: z.literal('absent'), observedAt: z.string().datetime(),
});
export type OperationalEffect = z.infer<typeof OperationalEffect>;

export const OperationalCompletion = z.object({
  item: z.string(), request: z.string(), owner: z.string(),
  requestDigest: z.string(), goalDigest: z.string(), planDigest: z.string(), planDocumentDigest: z.string(),
  approvalDigest: z.string(), configurationDigest: z.string(),
  session: ChatOrigin, execution: ChatOrigin,
  source: z.object({ head: z.string(), tree: z.string(), directory: z.string() }),
  verification: ReviewEvidence, effects: z.array(OperationalEffect),
  review: z.object({ reviewer: z.string(), verdict: Verdict }),
  completedAt: z.string().datetime(),
});
export type OperationalCompletion = z.infer<typeof OperationalCompletion>;
export const OperationalEvidence = OperationalCompletion.omit({ review: true });
