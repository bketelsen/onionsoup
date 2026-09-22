import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Learnings, OwnerAnswers, Survey } from './artifacts.ts';
import { distillBrief, learningsBrief, ownerAnswerBrief, surveyBrief, workSoFarText } from './briefs.ts';
import type { WorkItem } from './ledger.ts';
import type { Runtime } from './runtime.ts';
import { refreshCheckout } from './workspace.ts';

export const SURVEY_LIMITS = { recentWork: 20 };

async function prepare(runtime: Runtime, ownerId: string) {
  const owner = runtime.owner(ownerId);
  const notebook = runtime.notebook(ownerId);
  await notebook.ensure(await runtime.text(`charters/${ownerId}.md`));
  return { owner, notebook };
}

/** A wake: the owner surveys its domain, updates its notebook and opens work items. */
export async function wake(runtime: Runtime, ownerId: string, dutyId: string) {
  const { owner, notebook } = await prepare(runtime, ownerId);
  const duty = owner.duties.find(candidate => candidate.id === dutyId);
  if (!duty) throw new Error(`unknown_duty: ${ownerId}/${dutyId}`);
  const head = await refreshCheckout(owner);
  const history = (await runtime.ledger.list()).filter(item => item.owner === ownerId).slice(-SURVEY_LIMITS.recentWork);
  const brief = surveyBrief(duty, await notebook.orientation(), head, owner.maxProposals, workSoFarText(history));
  const result = await runtime.hire(ownerId, { role: 'owner', model: owner.model, directory: owner.checkout, title: `${ownerId}: ${dutyId}`, brief, schema: Survey });
  const survey = result.value;
  await notebook.apply(survey.notebook, `${dutyId} at ${head.slice(0, 8)}`);
  const proposals = survey.proposals.slice(0, owner.maxProposals);
  const items: WorkItem[] = [];
  for (const proposal of proposals) items.push(await runtime.ledger.create(ownerId, owner.workflow, proposal));
  await notebook.journal({ kind: 'wake', note: `${dutyId}: ${survey.summary}`, model: owner.model, outcome: `${items.length} work items; $${result.cost.toFixed(4)}` });
  await notebook.commit(`journal ${dutyId}`);
  return { survey, items, cost: result.cost };
}

/** The owner answers a planner's questions, as a project manager would. */
export async function answerQuestions(runtime: Runtime, item: WorkItem, questions: readonly string[]) {
  const { owner, notebook } = await prepare(runtime, item.owner);
  const brief = ownerAnswerBrief(item, questions, await notebook.orientation());
  return runtime.hireFor(item, 'plan', 'owner', { role: 'owner', model: owner.model, directory: owner.checkout, title: `${item.id}: owner answers`, brief, schema: OwnerAnswers });
}

/** After a work item ends, the owner writes down what it learned. */
export async function recordLearnings(runtime: Runtime, item: WorkItem) {
  const { owner, notebook } = await prepare(runtime, item.owner);
  const brief = learningsBrief(item, await notebook.orientation());
  const learnings = await runtime.hireFor(item, 'learn', 'owner', { role: 'owner', model: owner.model, directory: owner.checkout, title: `${item.id}: learnings`, brief, schema: Learnings });
  await notebook.apply(learnings.notebook, `learnings from ${item.id}`);
  await notebook.journal({ kind: 'work-ended', workItem: item.id, outcome: item.status, note: item.reason ?? item.proposal.title });
  await notebook.commit(`journal ${item.id}`);
  return learnings;
}

/** Fold the journal since the last distill into the registers. */
export async function distill(runtime: Runtime, ownerId: string) {
  const { owner, notebook } = await prepare(runtime, ownerId);
  const markerPath = join(runtime.stateDirectory, `distill-${ownerId}.txt`);
  const marker = await readFile(markerPath, 'utf8').then(text => text.trim(), () => undefined);
  const journal = await notebook.journalSince(marker);
  if (!journal.length) return { edits: 0, cost: 0 };
  const brief = distillBrief(journal, await notebook.orientation());
  const result = await runtime.hire(ownerId, { role: 'owner', model: owner.model, directory: owner.checkout, title: `${ownerId}: distill`, brief, schema: Learnings });
  await notebook.apply(result.value.notebook, `distill ${journal.length} journal lines`);
  await writeFile(markerPath, new Date().toISOString());
  return { edits: result.value.notebook.length, cost: result.cost };
}
