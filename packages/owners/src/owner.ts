import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Learnings, OwnerAnswers, Survey } from './artifacts.ts';
import { describeAsk, InstanceAsk } from './requests.ts';
import { FOLLOW_UP_DESCRIPTIONS, requestInstance } from './brokering.ts';
import { composeAskBrief, distillBrief, learningsBrief, ownerAnswerBrief, surveyBrief, workSoFarText } from './briefs.ts';
import { hasIncus, type Duty, type OwnerDeclaration, type ResolvedOwner } from './declarations.ts';
import { refreshIncusEvidence } from './incus.ts';
import { refreshTruenasEvidence } from './truenas.ts';
import { reviewAppUpdates } from './app-updates.ts';
import { maintainPullRequests } from './rebase.ts';
import { rosterText } from './roster.ts';
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

type Refresh = (runtime: Runtime, owner: OwnerDeclaration) => Promise<string>;

/** How each kind of domain brings its workspace up to date before the owner reads it. */
const REFRESH: Record<OwnerDeclaration['domain']['kind'], Refresh> = {
  'git-repository': async (runtime, owner) => `commit ${(await refreshCheckout(runtime.repositoryOwner(owner.id))).slice(0, 12)}`,
  incus: async (runtime, owner) => refreshIncusEvidence(runtime.incus, runtime.incusOwner(owner.id), runtime.managed),
  truenas: async (runtime, owner) => refreshTruenasEvidence(runtime.truenasOwner(owner.id).domain, runtime.evidenceDirectory(owner.id)),
};

/** Bring the owner's workspace up to date, plus its incus snapshot when it holds incus beside a repository. */
export async function refreshWorkspace(runtime: Runtime, owner: OwnerDeclaration) {
  const label = await REFRESH[owner.domain.kind](runtime, owner);
  if (owner.domain.kind === 'incus' || !owner.incus) return label;
  return `${label}; ${await refreshIncusEvidence(runtime.incus, runtime.incusOwner(owner.id), runtime.managed)}`;
}

/** The owner's incus snapshot, for briefs whose session runs in a repository and cannot read the evidence folder. */
export async function incusEvidenceText(runtime: Runtime, owner: OwnerDeclaration) {
  if (!hasIncus(owner) || owner.domain.kind === 'incus') return '';
  return readFile(join(runtime.evidenceDirectory(owner.id), 'SNAPSHOT.md'), 'utf8').catch(() => '');
}

/** A duty that asks another owner for an instance; the rest happens through the request's lifecycle. */
async function requestInstanceDuty(runtime: Runtime, owner: ResolvedOwner, duty: Duty) {
  if (!duty.requestTo || !duty.followUp) throw new Error(`duty_missing_request_target: ${owner.id}/${duty.id}`);
  const notebook = runtime.notebook(owner.id);
  const snapshot = await refreshWorkspace(runtime, owner);
  const brief = composeAskBrief(duty, await notebook.orientation(), snapshot, duty.requestTo, FOLLOW_UP_DESCRIPTIONS[duty.followUp] ?? duty.followUp);
  const result = await runtime.hire(owner.id, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${owner.id}: ${duty.id}`, brief, schema: InstanceAsk });
  const request = await requestInstance(runtime, owner.id, duty.requestTo, result.value, duty.followUp);
  return { request, cost: result.cost };
}

/**
 * A wake: the owner surveys its domain and updates its notebook. With a workflow it opens work items;
 * without one it raises attention items for a person, because it has no freelancers to hire.
 */
export async function wake(runtime: Runtime, ownerId: string, dutyId: string) {
  const { owner, notebook } = await prepare(runtime, ownerId);
  const duty = owner.duties.find(candidate => candidate.id === dutyId);
  if (!duty) throw new Error(`unknown_duty: ${ownerId}/${dutyId}`);
  if (duty.kind === 'app-updates') {
    const { summary, opened } = await reviewAppUpdates(runtime, ownerId, duty);
    return { survey: { summary, notebook: [], proposals: [] }, items: [], attention: [], request: opened[0], cost: 0 };
  }
  if (duty.kind === 'maintain-prs') {
    const { summary, opened } = await maintainPullRequests(runtime, ownerId);
    return { survey: { summary, notebook: [], proposals: [] }, items: opened, attention: [], request: undefined, cost: 0 };
  }
  if (duty.kind === 'request-instance') {
    const { request, cost } = await requestInstanceDuty(runtime, owner, duty);
    const summary = `asked ${request.to} for ${describeAsk(request.ask)}: ${request.ask.purpose} (${request.id})`;
    return { survey: { summary, notebook: [], proposals: [] }, items: [], attention: [], request, cost };
  }
  const snapshot = await refreshWorkspace(runtime, owner);
  const history = (await runtime.ledger.list()).filter(item => item.owner === ownerId).slice(-SURVEY_LIMITS.recentWork);
  const mode = owner.workflow && duty.raises === 'work' ? 'work' : 'attention';
  const evidence = await incusEvidenceText(runtime, owner);
  const brief = surveyBrief(duty, await notebook.orientation(), snapshot, owner.maxProposals, workSoFarText(history), mode, rosterText(runtime.declarations, ownerId))
    + (evidence ? `\n\n<your-incus-snapshot>\n${evidence}\n</your-incus-snapshot>` : '');
  const result = await runtime.hire(ownerId, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${ownerId}: ${dutyId}`, brief, schema: Survey });
  const survey = result.value;
  await notebook.apply(survey.notebook, `${dutyId} at ${snapshot}`);
  const proposals = survey.proposals.slice(0, owner.maxProposals);
  const items: WorkItem[] = [];
  if (mode === 'work') {
    for (const proposal of proposals) items.push(await runtime.ledger.create(ownerId, owner.workflow!, proposal));
  } else {
    for (const proposal of proposals) await notebook.journal({ kind: 'attention', note: `${proposal.title}: ${proposal.goal}` });
  }
  await notebook.journal({ kind: 'wake', note: `${dutyId}: ${survey.summary}`, model: owner.model, outcome: `${proposals.length} ${mode} items; $${result.cost.toFixed(4)}` });
  await notebook.commit(`journal ${dutyId}`);
  return { survey, items, attention: mode === 'attention' ? proposals : [], request: undefined, cost: result.cost };
}

/** The owner answers a planner's questions, as a project manager would. */
export async function answerQuestions(runtime: Runtime, item: WorkItem, questions: readonly string[]) {
  const { owner, notebook } = await prepare(runtime, item.owner);
  const brief = ownerAnswerBrief(item, questions, await notebook.orientation());
  return runtime.hireFor(item, 'plan', 'owner', { role: 'owner', model: owner.model, directory: owner.workspace, title: `${item.id}: owner answers`, brief, schema: OwnerAnswers });
}

/** After a work item ends, the owner writes down what it learned. */
export async function recordLearnings(runtime: Runtime, item: WorkItem) {
  const { owner, notebook } = await prepare(runtime, item.owner);
  const brief = learningsBrief(item, await notebook.orientation());
  const learnings = await runtime.hireFor(item, 'learn', 'owner', { role: 'owner', model: owner.model, directory: owner.workspace, title: `${item.id}: learnings`, brief, schema: Learnings });
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
  const result = await runtime.hire(ownerId, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${ownerId}: distill`, brief, schema: Learnings });
  await notebook.apply(result.value.notebook, `distill ${journal.length} journal lines`);
  await writeFile(markerPath, new Date().toISOString());
  return { edits: result.value.notebook.length, cost: result.cost };
}
