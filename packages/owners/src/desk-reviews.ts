import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Finding, Verdict } from './artifacts.ts';
import type { Runtime } from './runtime.ts';

/**
 * The review rounds of one owner's desk change in one repository. Each round keeps the tree it reviewed, so the
 * next reviewer sees what changed since and checks the earlier findings first instead of starting over.
 */
export const DeskReviewRound = z.object({
  at: z.string(), reviewer: z.string(), decision: Verdict.shape.decision, summary: z.string(), findings: z.array(Finding), tree: z.string(),
});
export type DeskReviewRound = z.infer<typeof DeskReviewRound>;
const DeskReviewHistory = z.object({ rounds: z.array(DeskReviewRound) });

/**
 * Whose rounds they are: the desk's for a repository, or an approved plan's worktree's, which keeps its own so two
 * plans in one repository never share a history or a budget.
 */
export function reviewSubject(repository: string, planItem?: string) {
  return planItem ? `${repository}/plans/${planItem}` : repository;
}

function historyPath(runtime: Runtime, ownerId: string, subject: string) {
  return join(runtime.stateDirectory, 'desk-reviews', `${ownerId}--${subject.replaceAll('/', '--')}.json`);
}

export async function deskReviewRounds(runtime: Runtime, ownerId: string, subject: string) {
  const text = await readFile(historyPath(runtime, ownerId, subject), 'utf8').catch(() => undefined);
  return text ? DeskReviewHistory.parse(JSON.parse(text)).rounds : [];
}

export async function recordDeskReview(runtime: Runtime, ownerId: string, subject: string, round: DeskReviewRound) {
  const path = historyPath(runtime, ownerId, subject);
  const rounds = [...await deskReviewRounds(runtime, ownerId, subject), round];
  await mkdir(join(runtime.stateDirectory, 'desk-reviews'), { recursive: true });
  await writeFile(path, JSON.stringify({ rounds }, null, 2) + '\n');
  return rounds;
}

/** An approved change, or the person's reset, starts the next desk change with no history. */
export async function clearDeskReviews(runtime: Runtime, ownerId: string, subject: string) {
  await rm(historyPath(runtime, ownerId, subject), { force: true });
}
