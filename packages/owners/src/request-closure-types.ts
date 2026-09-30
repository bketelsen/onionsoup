import { z } from 'zod';
import { Finding, ProposedWork, Verdict } from './artifacts.ts';
import { ReviewEvidence } from './desk-reviews.ts';

const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ClosureFinding = z.object({ id: Digest, finding: Finding });
export const ClosureReview = z.object({
  verdict: Verdict,
  resolutions: z.array(z.object({
    finding: Digest,
    disposition: z.enum(['fixed', 'outside-original-scope']),
    evidence: z.string().trim().min(1),
  })),
});
export type ClosureReview = z.infer<typeof ClosureReview>;
export const ClosureMerge = z.object({
  url: z.string().url(), repository: z.string(), baseBranch: z.string(),
  head: Commit, mergeCommit: Commit, mergedAt: z.string().datetime(),
});
export type ClosureMerge = z.infer<typeof ClosureMerge>;

/** Host-prepared evidence is separate from the original implementation/review history. */
export const RequestClosureCandidate = z.object({
  digest: Digest, item: z.string(), request: z.string(), owner: z.string(),
  proposal: ProposedWork, planDigest: z.string(), planDocumentDigest: Digest, approvalDigest: Digest, requestDigest: Digest,
  subjectDigest: Digest, configurationDigest: Digest, historyDigest: Digest,
  directory: z.string(), repository: z.string(), baseBranch: z.string(),
  head: Commit, tree: Commit, base: Commit,
  historicalMerges: z.array(ClosureMerge).min(1), followUps: z.array(ClosureMerge).min(1),
  originalFindings: z.array(ClosureFinding), verification: ReviewEvidence,
  review: ClosureReview.extend({ reviewer: z.string() }),
  preparedBy: z.string().min(1), preparedAt: z.string().datetime(),
});
export type RequestClosureCandidate = z.infer<typeof RequestClosureCandidate>;

/** Explicit human acceptance of one exact prepared scope; historical observations remain immutable. */
export const RequestAcceptance = z.object({
  candidate: RequestClosureCandidate, by: z.string().min(1), note: z.string().min(1), acceptedAt: z.string().datetime(),
});
export type RequestAcceptance = z.infer<typeof RequestAcceptance>;
