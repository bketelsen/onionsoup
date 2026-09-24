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
  // Nothing in the codebase currently reads filesChanged (verified by grep), so a
  // model that omits it defaults to an empty array rather than failing the whole
  // deliverable. If a consumer starts depending on this field, revisit this
  // comment and the default together.
  filesChanged: z.array(z.string()).default([]),
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

/** A manager's review of a report's plan, under the person's standing approve-plans grant. */
export const ManagerPlanVerdict = z.object({
  decision: z.enum(['approve', 'revise', 'escalate']),
  note: z.string().describe('approve: anything worth keeping in mind (may be empty); revise: exactly what the planner must change; escalate: why the person should decide'),
});
export type ManagerPlanVerdict = z.infer<typeof ManagerPlanVerdict>;

export const Learnings = z.object({
  notebook: z.array(NotebookEdit),
});
export type Learnings = z.infer<typeof Learnings>;
