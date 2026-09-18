// Version 1 is retained only to validate historical records; never relabel its outcomes.
import { z } from 'zod';
import type { IssueSnapshot } from './contracts.ts';

export const fields = ['reproduction', 'expected', 'actual', 'environment'] as const;
export const LegacyAssessment = z.object({
  disposition: z.enum(['ready', 'needs_information', 'out_of_scope']),
  summary: z.string().min(1).max(600),
  evidence: z.array(z.object({
    field: z.enum(fields),
    source: z.enum(['title', 'body']),
    quote: z.string().min(1).max(800),
  }).strict()).max(4),
  questions: z.array(z.object({
    field: z.enum(fields),
    question: z.string().min(1).max(300),
  }).strict()).max(4),
}).strict();
export type LegacyAssessment = z.infer<typeof LegacyAssessment>;

// These checks enforce the public contract, independently of model instructions.
export function validateLegacyAssessment(raw: unknown, issue: IssueSnapshot): LegacyAssessment {
  const value = LegacyAssessment.parse(raw);
  const present = new Set(value.evidence.map(e => e.field));
  const missing = new Set(value.questions.map(q => q.field));
  if (present.size !== value.evidence.length || missing.size !== value.questions.length)
    throw new Error('DUPLICATE_FIELD: use each field once');
  for (const evidence of value.evidence) {
    if (!issue[evidence.source].includes(evidence.quote))
      throw new Error(`UNGROUNDED_EVIDENCE: ${evidence.field} quote must match the snapshot exactly`);
    if (missing.has(evidence.field))
      throw new Error(`CONFLICTING_FIELD: ${evidence.field} cannot be both present and missing`);
  }
  if (value.disposition === 'ready' && (present.size !== 4 || missing.size !== 0))
    throw new Error('INCOMPLETE_READY: provide evidence for all four fields and no questions');
  if (value.disposition === 'needs_information' && (missing.size === 0 || present.size + missing.size !== 4))
    throw new Error('INCOMPLETE_QUESTIONS: cover all four fields with evidence or a question');
  if (value.disposition === 'out_of_scope' && (present.size || missing.size))
    throw new Error('OUT_OF_SCOPE: explain in summary; leave evidence and questions empty');
  return value;
}
