import { z } from 'zod';

export const DIRECT_REQUEST_REVIEW_LIMITS = { noteChars: 8_000 };

/** An explicit scoped review, not a grant or an inferred semantic match. */
export const DirectRequestPlanReviewInput = z.object({
  request: z.string().regex(/^r-[a-zA-Z0-9-]+$/), item: z.string().regex(/^w-[a-zA-Z0-9-]+$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'revise', 'needs-human']),
  scope: z.enum(['matched', 'needs-human']), note: z.string().trim().min(1).max(DIRECT_REQUEST_REVIEW_LIMITS.noteChars),
});
export type DirectRequestPlanReviewInput = z.infer<typeof DirectRequestPlanReviewInput>;

export const DirectRequestPlanReview = DirectRequestPlanReviewInput.extend({
  reviewer: z.string(), repository: z.string(), grantTarget: z.string(), at: z.string().datetime(),
});
export type DirectRequestPlanReview = z.infer<typeof DirectRequestPlanReview>;
