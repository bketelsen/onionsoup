import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Survey, type ProposedWork } from './artifacts.ts';
import { describeAsk, InstanceAsk } from './requests.ts';
import { FOLLOW_UP_DESCRIPTIONS, requestInstance } from './brokering.ts';
import { composeAskBrief, surveyBrief, workSoFarText } from './briefs.ts';
import { canChange, hasIncus, repositoryNames, repositoryShortName, type Duty, type OwnerDeclaration, type ResolvedOwner } from './declarations.ts';
import { refreshIncusEvidence } from './incus.ts';
import { refreshGithubOrgEvidence } from './github-org.ts';
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
  'repository-group': async (runtime, owner) => {
    const views = runtime.repositoryViews(owner.id);
    const commits = [];
    for (const view of views) commits.push(`${view.domain.name} in ./${repositoryShortName(view.domain.name)} at commit ${(await refreshCheckout(view)).slice(0, 12)}`);
    return `repositories (one directory each): ${commits.join('; ')}`;
  },
  incus: async (runtime, owner) => refreshIncusEvidence(runtime.incus, runtime.incusOwner(owner.id), runtime.managed),
  truenas: async (runtime, owner) => refreshTruenasEvidence(runtime.truenasOwner(owner.id).domain, runtime.evidenceDirectory(owner.id)),
  'github-org': async (runtime, owner) => (owner.domain.kind === 'github-org' ? refreshGithubOrgEvidence(owner.domain, runtime.evidenceDirectory(owner.id)) : ''),
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

/** How a survey's proposals reach the person: work an owner could plan with them, or things only they can act on. */
const PROPOSAL_NOTES: Record<'work' | 'attention', (proposal: ProposedWork) => string> = {
  work: proposal => `proposed work${proposal.repository ? ` in ${proposal.repository}` : ''}: ${proposal.title}: ${proposal.goal} (plan it with the owner in chat)`,
  attention: proposal => `${proposal.title}: ${proposal.goal}`,
};

/**
 * A wake: the owner surveys its domain and updates its notebook. What it proposes goes to the person as attention
 * items: work an owner that can change its domain plans with them in chat, or things only the person can act on.
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
  const mode = canChange(owner) && duty.raises === 'work' ? 'work' : 'attention';
  const evidence = await incusEvidenceText(runtime, owner);
  const brief = surveyBrief(duty, await notebook.orientation(), snapshot, owner.maxProposals, workSoFarText(history), mode, rosterText(runtime.declarations, ownerId))
    + (evidence ? `\n\n<your-incus-snapshot>\n${evidence}\n</your-incus-snapshot>` : '');
  const groupNote = owner.domain.kind === 'repository-group'
    ? `\n\nYou own several repositories: ${repositoryNames(owner).join(', ')}. Every proposal must name its repository.`
    : '';
  const result = await runtime.hire(ownerId, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${ownerId}: ${dutyId}`, brief: brief + groupNote, schema: Survey });
  const survey = result.value;
  await notebook.apply(survey.notebook, `${dutyId} at ${snapshot}`);
  const proposals = survey.proposals.slice(0, owner.maxProposals);
  for (const proposal of proposals) await notebook.journal({ kind: 'attention', note: PROPOSAL_NOTES[mode](proposal) });
  await notebook.journal({ kind: 'wake', note: `${dutyId}: ${survey.summary}`, model: owner.model, outcome: `${proposals.length} ${mode} items; $${result.cost.toFixed(4)}` });
  await notebook.commit(`journal ${dutyId}`);
  return { survey, items: [] as WorkItem[], attention: proposals, request: undefined, cost: result.cost };
}
