import { z } from 'zod';

export const NotebookRegister = z.enum(['MAP', 'WISDOM', 'FAILURES', 'decisions', 'open-questions']);
export type NotebookRegister = z.infer<typeof NotebookRegister>;

export const NotebookEdit = z.object({
  register: NotebookRegister,
  mode: z.enum(['append', 'replace-section']),
  section: z.string().describe('Markdown heading text (without #) the edit belongs under'),
  text: z.string().describe('Markdown body for that section'),
});
export type NotebookEdit = z.infer<typeof NotebookEdit>;

export const ProposedWork = z.object({
  title: z.string(),
  goal: z.string(),
  rationale: z.string().describe('Why this matters, citing files or notebook sections'),
  acceptance: z.array(z.string()).min(1),
  size: z.enum(['small', 'medium']),
  repository: z.string().optional().describe('Only for owners of several repositories: which one this work is in (owner/name)'),
});
export type ProposedWork = z.infer<typeof ProposedWork>;

export const Survey = z.object({
  summary: z.string(),
  notebook: z.array(NotebookEdit),
  proposals: z.array(ProposedWork),
});
export type Survey = z.infer<typeof Survey>;

export const Plan = z.object({
  summary: z.string(),
  steps: z.array(z.object({ description: z.string(), files: z.array(z.string()) })).min(1),
  tests: z.array(z.string()).min(1).describe('Tests to add or change, and how they prove acceptance'),
  risks: z.array(z.string()),
  outOfScope: z.array(z.string()),
  questionsForOwner: z.array(z.string()).describe('Questions only the owner can answer; empty if none'),
});
export type Plan = z.infer<typeof Plan>;

export const OwnerAnswers = z.object({
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type OwnerAnswers = z.infer<typeof OwnerAnswers>;

export const ImplementationReport = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()),
  deviationsFromPlan: z.array(z.string()),
});
export type ImplementationReport = z.infer<typeof ImplementationReport>;

export const Finding = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  file: z.string(),
  issue: z.string(),
  suggestion: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const Verdict = z.object({
  decision: z.enum(['approve', 'revise', 'replan']),
  summary: z.string(),
  findings: z.array(Finding),
});
export type Verdict = z.infer<typeof Verdict>;

export const Learnings = z.object({
  notebook: z.array(NotebookEdit),
});
export type Learnings = z.infer<typeof Learnings>;
