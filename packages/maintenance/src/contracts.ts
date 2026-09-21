import { z } from 'zod';

export const IssueSnapshot = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  title: z.string().min(1).max(500),
  body: z.string().max(24000),
}).strict();
export type IssueSnapshot = z.infer<typeof IssueSnapshot>;

export const fields = ['reproduction', 'expected', 'actual', 'environment'] as const;
export const Assessment = z.object({
  schemaVersion: z.literal(2),
  kind: z.enum(['bug_report', 'feature_request', 'support_question', 'other', 'unclear']),
  bug_readiness: z.enum(['ready', 'needs_information', 'not_applicable']),
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
export type Assessment = z.infer<typeof Assessment>;

// These checks enforce the public contract, independently of model instructions.
export function validateAssessment(raw: unknown, issue: IssueSnapshot): Assessment {
  const value = Assessment.parse(raw);
  if ((value.kind === 'bug_report') === (value.bug_readiness === 'not_applicable'))
    throw new Error('INCOMPATIBLE_READINESS: bug reports need ready or needs_information; other kinds need not_applicable');
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
  if (value.bug_readiness === 'ready' && (present.size !== 4 || missing.size !== 0))
    throw new Error('INCOMPLETE_READY: provide evidence for all four fields and no questions');
  if (value.bug_readiness === 'needs_information' && (missing.size === 0 || present.size + missing.size !== 4))
    throw new Error('INCOMPLETE_QUESTIONS: cover all four fields with evidence or a question');
  if (value.bug_readiness === 'not_applicable' && (present.size || missing.size))
    throw new Error('NOT_APPLICABLE: describe the request in summary; leave evidence and questions empty');
  return value;
}
