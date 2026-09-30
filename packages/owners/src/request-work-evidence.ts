import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Verdict } from './artifacts.ts';
import { clipped } from './chat-context.ts';
import { safeProse } from './friction.ts';
import { ReviewEvidence } from './desk-reviews.ts';
import type { WorkItem } from './ledger.ts';
import type { Runtime } from './runtime.ts';

export const REQUEST_EVIDENCE_LIMITS = { fieldChars: 240, findings: 8, checks: 24 };

function evidenceProse(value: string) {
  try { return clipped(safeProse(value), REQUEST_EVIDENCE_LIMITS.fieldChars); }
  catch { return '[unsafe text omitted]'; }
}

/** Only host publication attempts write this view; model reports are never verification. */
export const RequestWorkEvidence = z.object({
  request: z.string(), item: z.string(), owner: z.string(), planDigest: z.string().optional(),
  observedAt: z.string().datetime(),
  stage: z.enum(['verifying', 'reviewing', 'reviewed', 'blocked']),
  verification: ReviewEvidence.optional(),
  review: z.object({ reviewer: z.string(), verdict: Verdict }).optional(),
  blocker: z.string().optional(),
  abbreviated: z.boolean().default(false),
});
export type RequestWorkEvidence = z.infer<typeof RequestWorkEvidence>;

function evidencePath(runtime: Runtime, item: WorkItem) {
  const key = createHash('sha256').update(item.id).digest('hex');
  return join(runtime.stateDirectory, 'request-work-evidence', `${key}.json`);
}

type AttemptEvidence = Pick<RequestWorkEvidence, 'stage' | 'verification' | 'review' | 'blocker'>;
export async function recordRequestWorkEvidence(runtime: Runtime, item: WorkItem | undefined, attempt: AttemptEvidence) {
  if (!item?.request) return;
  const verdict = attempt.review?.verdict;
  const limits = REQUEST_EVIDENCE_LIMITS;
  const abbreviated = Boolean(verdict && (verdict.findings.length > limits.findings || verdict.summary.length > limits.fieldChars
    || verdict.findings.some(finding => [finding.file, finding.issue, finding.suggestion].some(value => value.length > limits.fieldChars)))
    || attempt.verification && attempt.verification.checks.length > limits.checks);
  const verification = attempt.verification ? { ...attempt.verification, checks: attempt.verification.checks.slice(0, limits.checks) } : undefined;
  const review = attempt.review && verdict ? { reviewer: attempt.review.reviewer, verdict: { ...verdict, summary: evidenceProse(verdict.summary),
    findings: [...verdict.findings].sort((left, right) => Number(right.severity === 'blocker') - Number(left.severity === 'blocker')).slice(0, limits.findings).map(finding => ({ ...finding, file: evidenceProse(finding.file),
      issue: evidenceProse(finding.issue), suggestion: evidenceProse(finding.suggestion) })) } } : undefined;
  const record = RequestWorkEvidence.parse({ ...attempt, verification, review, abbreviated, request: item.request, item: item.id,
    owner: item.owner, planDigest: item.planDocument?.digest, observedAt: new Date().toISOString() });
  const path = evidencePath(runtime, item);
  await mkdir(join(runtime.stateDirectory, 'request-work-evidence'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function readRequestWorkEvidence(runtime: Runtime, item: WorkItem) {
  const contents = await readFile(evidencePath(runtime, item), 'utf8');
  const evidence = RequestWorkEvidence.parse(JSON.parse(contents));
  if (evidence.item !== item.id || evidence.owner !== item.owner || evidence.request !== item.request) {
    throw new Error('request_work_evidence_mismatch');
  }
  return evidence;
}
