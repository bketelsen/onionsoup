import { z } from 'zod';
import { IssueSnapshot } from './contracts.ts';
import { inputHash } from './triage.ts';

export const Commit = z.string().regex(/^[a-f0-9]{40}$/);
export const SourcePath = z.string().min(1).max(400).refine(p =>
  !p.startsWith('/') && !/[\\\x00-\x1f]/.test(p) && !p.split('/').some(s => ['.', '..', '.git', ''].includes(s)), 'Use a repository-relative path');
export const LocationInput = z.object({ schemaVersion: z.literal(1), issue: IssueSnapshot,
  parent: z.object({ runId: z.string().uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptVersion: z.string(), kind: z.literal('bug_report'), bug_readiness: z.literal('ready'), summary: z.string().max(600) }).strict(),
  repository: z.object({ name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), commit: Commit }).strict(),
}).strict().superRefine((input, ctx) => {
  if (inputHash(input.issue) !== input.parent.inputHash || input.issue.repository !== input.repository.name)
    ctx.addIssue({ code: 'custom', message: 'Handoff source identity/hash mismatch' });
});
export type LocationInput = z.infer<typeof LocationInput>;
const Pointer = z.object({ excerptId: z.string().regex(/^E[1-9][0-9]*$/),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  symbol: z.string().min(1).max(160).nullable(), reason: z.string().min(1).max(500),
}).strict();
export const BriefDraft = z.object({ status: z.enum(['located', 'not_located']), summary: z.string().min(1).max(800),
  codePointers: z.array(Pointer).max(4), testPointers: z.array(Pointer).max(3),
  uncertainties: z.array(z.string().min(1).max(500)).min(1).max(5),
}).strict();
export type BriefDraft = z.infer<typeof BriefDraft>;
export const Citation = z.object({ path: SourcePath, startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  quote: z.string().min(1).max(2000), symbol: z.string().min(1).max(160).nullable(), reason: z.string().min(1).max(500) }).strict();
export const LocationBrief = z.object({ schemaVersion: z.literal(1), status: z.enum(['located', 'not_located']),
  summary: z.string().min(1).max(800), codePointers: z.array(Citation).max(4), testPointers: z.array(Citation).max(3),
  uncertainties: z.array(z.string().min(1).max(500)).min(1).max(5) }).strict();
export type LocationBrief = z.infer<typeof LocationBrief>;
export type Excerpt = { id: string; path: string; startLine: number; endLine: number; lines: string[] };
export const LOCATION_LIMITS = { steps: 12, timeoutMs: 180000, inspectionCalls: 12, contextChars: 36000,
  matches: 12, readLines: 60, readChars: 6000, citationLines: 30, fileBytes: 262144 } as const;
export const isTestPath = (path: string) => /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:^|\/)test_[^/]+|(?:[._-])(?:test|spec)(?:[._-]|$)/i.test(path);
export function resolveBrief(raw: unknown, excerpts: Excerpt[], searchedTests: boolean): LocationBrief {
  const draft = BriefDraft.parse(raw);
  if (!searchedTests) throw new Error('TEST_SEARCH_REQUIRED: search the tests scope before submitting');
  if (draft.status === 'located' && !draft.codePointers.length) throw new Error('CODE_POINTER_REQUIRED');
  if (draft.status === 'not_located' && (draft.codePointers.length || draft.testPointers.length)) throw new Error('NOT_LOCATED_MUST_HAVE_NO_POINTERS');
  const resolve = (pointer: z.infer<typeof Pointer>, tests: boolean) => {
    const e = excerpts.find(e => e.id === pointer.excerptId);
    if (!e || pointer.startLine < e.startLine || pointer.endLine > e.endLine || pointer.startLine > pointer.endLine ||
      pointer.endLine - pointer.startLine + 1 > LOCATION_LIMITS.citationLines)
      throw new Error('UNREAD_CITATION: choose at most 30 lines within an excerpt you read');
    if (tests !== isTestPath(e.path)) throw new Error(tests ? 'TEST_PATH_REQUIRED' : 'CODE_PATH_REQUIRED');
    const quote = e.lines.slice(pointer.startLine - e.startLine, pointer.endLine - e.startLine + 1).join('\n');
    if (pointer.symbol && !quote.includes(pointer.symbol)) throw new Error('SYMBOL_NOT_IN_CITATION: cite its literal text or use null');
    return Citation.parse({ path: e.path, startLine: pointer.startLine, endLine: pointer.endLine,
      quote, symbol: pointer.symbol, reason: pointer.reason });
  };
  return LocationBrief.parse({ schemaVersion: 1, ...draft,
    codePointers: draft.codePointers.map(p => resolve(p, false)), testPointers: draft.testPointers.map(p => resolve(p, true)) });
}
