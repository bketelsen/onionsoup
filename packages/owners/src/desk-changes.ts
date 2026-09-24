import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WorkItem } from './ledger.ts';
import { Verdict } from './artifacts.ts';
import { requestPublish } from './brokering.ts';
import { requireFreelancer, type RepositoryOwner } from './declarations.ts';
import { pickModel } from './families.ts';
import type { Runtime } from './runtime.ts';
import { ensureDesk, git, verificationPassed, verify } from './workspace.ts';

const run = promisify(execFile);

export const DESK_CHANGE_LIMITS = { diffChars: 60_000 };

/**
 * An owner's desk work becomes a reviewed change: host code verifies the desk in the sandbox, hires a reviewer
 * from another model family to check the diff, and only if it is approved commits, pushes a branch and opens a
 * PR. An owner holding a merge grant from the person merges its own approved PR, and a site built from the
 * repository is then published through its host's grant.
 */
export interface DeskChangeResult { outcome: 'merged' | 'opened' | 'needs-work' | 'nothing-to-do'; summary: string; url?: string; publishRequest?: string }

function hasMergeGrant(owner: RepositoryOwner) {
  return owner.grants.some(grant => grant.to === owner.id && grant.action === 'merge' && (grant.target === owner.domain.name || grant.target === '*'));
}

function reviewBrief(owner: RepositoryOwner, title: string, summary: string, patch: string) {
  return [
    `You have been hired to review a change ${owner.persona?.name ?? owner.id} made in ${owner.domain.name}. Do not edit anything.`,
    `<title>${title}</title>`,
    `<what-the-owner-says-it-does>\n${summary}\n</what-the-owner-says-it-does>`,
    `<diff-against-${owner.domain.baseBranch}>\n${patch}\n</diff-against-${owner.domain.baseBranch}>`,
    `Approve only if the diff does what the owner says and nothing else, is correct, and keeps to the repository's
conventions. Revise, with specific findings, otherwise. Replan is not available here; use revise.`,
  ].join('\n\n');
}

async function prepareDeskChanges(runtime: Runtime, ownerId: string, title: string, summary: string, repository?: string): Promise<DeskChangeResult> {
  const owner = runtime.repositoryOwner(ownerId, repository);
  const desk = await ensureDesk(owner, runtime.desksRoot);
  if (!(await git(desk.path, ['status', '--porcelain'])).trim()) return { outcome: 'nothing-to-do', summary: 'The desk has no changes.' };
  await git(desk.path, ['fetch', '-q', 'origin']);
  const verification = await verify(owner, desk.path, runtime.toolsDirectory);
  if (!verificationPassed(verification)) {
    const failed = verification.filter(result => result.exitCode !== 0).map(result => `${result.command}: ${result.output.slice(-600)}`).join('\n');
    return { outcome: 'needs-work', summary: `Verification failed; nothing was committed.\n${failed}` };
  }
  await git(desk.path, ['add', '-A', '--intent-to-add']);
  const patch = (await git(desk.path, ['diff', `origin/${owner.domain.baseBranch}`])).slice(0, DESK_CHANGE_LIMITS.diffChars);
  const reviewer = pickModel(runtime.declarations.families, requireFreelancer(runtime.declarations, 'review').models, [runtime.family(owner.model)]);
  const verdict = (await runtime.hire(owner.id, { role: 'reviewer', model: reviewer.model, directory: desk.path, title: `${owner.id}: review desk change`, brief: reviewBrief(owner, title, summary, patch), schema: Verdict })).value;
  const notebook = runtime.notebook(owner.id);
  if (verdict.decision !== 'approve') {
    await notebook.journal({ kind: 'desk-change-reviewed', outcome: verdict.decision, note: `${title}: ${verdict.summary}` });
    const findings = verdict.findings.map(finding => `- [${finding.severity}] ${finding.file}: ${finding.issue} → ${finding.suggestion}`).join('\n');
    return { outcome: 'needs-work', summary: `${reviewer.model} asked for changes; nothing was committed.\n${verdict.summary}\n${findings}` };
  }
  await git(desk.path, ['add', '-A']);
  const item = await runtime.ledger.create(owner.id, DESK_WORKFLOW, {
    title, goal: summary, rationale: 'Reviewed changes from the owner desk', acceptance: ['Host verification and cross-family review pass'],
    size: 'small', repository,
  }, {
    status: 'landing', worktree: desk.path,
    implementations: [{ report: { summary, filesChanged: [], deviationsFromPlan: [] }, diffStat: patch, verification }],
    verdicts: [verdict],
    deskPublication: {
      stage: 'commit', reviewer: reviewer.model,
      reviewedHead: (await git(desk.path, ['rev-parse', 'HEAD'])).trim(),
      reviewedTree: (await git(desk.path, ['write-tree'])).trim(),
    },
  });
  return deskResult(await advanceDeskPublication(runtime, item.id));
}

export const DESK_WORKFLOW = 'desk-publication';

export async function proposeDeskChanges(runtime: Runtime, ownerId: string, title: string, summary: string, repository?: string) {
  const pending = (await runtime.ledger.list()).find(item => item.owner === ownerId
    && item.proposal.repository === repository && item.deskPublication
    && item.deskPublication.stage !== 'complete' && item.status !== 'cancelled');
  if (pending) return deskResult(await advanceDeskPublication(runtime, pending.id));
  return prepareDeskChanges(runtime, ownerId, title, summary, repository);
}

function deskResult(item: WorkItem): DeskChangeResult {
  if (item.status === 'failed') return { outcome: 'needs-work', summary: `${item.reason}; retry propose changes to continue ${item.id}.` };
  const outcome = item.publication?.state === 'merged' ? 'merged' : 'opened';
  return { outcome, summary: `${outcome} ${item.publication?.url}`, url: item.publication?.url, publishRequest: item.deskPublication?.publishRequest };
}

type DeskStage = NonNullable<WorkItem['deskPublication']>['stage'];
type DeskStep = (runtime: Runtime, item: WorkItem) => Promise<Partial<WorkItem>>;

function checkpoint(item: WorkItem, stage: DeskStage) {
  return { ...item.deskPublication!, stage };
}

const commitDesk: DeskStep = async (_runtime, item) => {
  const desk = item.worktree!;
  const head = (await git(desk, ['rev-parse', 'HEAD'])).trim();
  if (head === item.deskPublication!.reviewedHead) {
    await git(desk, ['add', '-A']);
    const tree = (await git(desk, ['write-tree'])).trim();
    if (tree !== item.deskPublication!.reviewedTree) throw new Error('desk_changed_since_review');
    await git(desk, ['commit', '-q', '-m', `${item.proposal.title}\n\n${item.proposal.goal}\n\nWork-item: ${item.id}\nReviewed-by: ${item.deskPublication!.reviewer}`]);
  } else {
    const message = await git(desk, ['log', '-1', '--format=%B']);
    if (!message.split('\n').includes(`Work-item: ${item.id}`)) throw new Error('desk_head_changed');
  }
  return { landedCommit: (await git(desk, ['rev-parse', 'HEAD'])).trim(), branch: `owners/${item.id}`, deskPublication: checkpoint(item, 'push') };
};

const pushDesk: DeskStep = async (runtime, item) => {
  await git(runtime.repositoryFor(item).workspace, ['push', '-q', 'origin', `${item.landedCommit}:refs/heads/${item.branch}`]);
  return { deskPublication: checkpoint(item, 'open') };
};

const PullRequest = z.object({ url: z.string(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']) });

async function openDeskPr(runtime: Runtime, item: WorkItem) {
  const owner = runtime.repositoryFor(item);
  const listed = await run('gh', ['pr', 'list', '--repo', owner.domain.name, '--head', item.branch!, '--state', 'all', '--json', 'url,state']);
  const existing = z.array(PullRequest).parse(JSON.parse(listed.stdout))[0];
  if (existing) return existing;
  const created = await run('gh', ['pr', 'create', '--repo', owner.domain.name, '--base', owner.domain.baseBranch,
    '--head', item.branch!, '--title', item.proposal.title,
    '--body', `${item.proposal.goal}\n\nReviewed by ${item.deskPublication!.reviewer}: ${item.verdicts.at(-1)!.summary}\n\nWork item: ${item.id}`]);
  return PullRequest.parse({ url: created.stdout.trim().split('\n').at(-1), state: 'OPEN' });
}

const openDesk: DeskStep = async (runtime, item) => {
  const opened = await openDeskPr(runtime, item);
  const states = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;
  const shouldMerge = hasMergeGrant(runtime.repositoryFor(item));
  return {
    publication: { url: opened.url, branch: item.branch!, by: item.owner, at: new Date().toISOString(), state: states[opened.state] },
    deskPublication: checkpoint(item, shouldMerge ? 'merge' : 'complete'),
  };
};

const mergeDesk: DeskStep = async (runtime, item) => {
  const owner = runtime.repositoryFor(item);
  if (!hasMergeGrant(owner)) return { deskPublication: checkpoint(item, 'complete') };
  const viewed = await run('gh', ['pr', 'view', item.publication!.url, '--json', 'url,state']);
  const current = PullRequest.parse(JSON.parse(viewed.stdout));
  if (current.state === 'CLOSED') throw new Error('desk_pr_closed');
  if (current.state === 'OPEN') {
    await runtime.notebook(item.owner).journal({ kind: 'grant-used', workItem: item.id, note: 'merge approved by standing grant' });
    await run('gh', ['pr', 'merge', current.url, '--squash', '--delete-branch']);
  }
  return { publication: { ...item.publication!, state: 'merged' }, deskPublication: checkpoint(item, 'finish') };
};

const finishDesk: DeskStep = async (runtime, item) => {
  const owner = runtime.repositoryFor(item);
  await git(item.worktree!, ['fetch', '-q', 'origin']);
  const head = (await git(item.worktree!, ['rev-parse', 'HEAD'])).trim();
  const isClean = !(await git(item.worktree!, ['status', '--porcelain'])).trim();
  if (head === item.landedCommit && isClean) await git(item.worktree!, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  const site = [...runtime.declarations.owners.values()]
    .flatMap(candidate => candidate.domain.kind === 'truenas' ? candidate.domain.sites : [])
    .find(candidate => candidate.source === item.owner);
  const purpose = `Publish merged desk work ${item.id}: ${item.proposal.title}`;
  const existing = (await runtime.requests.list()).find(request => request.from === item.owner && request.ask.purpose === purpose);
  const publish = site ? existing ?? await requestPublish(runtime, item.owner, site.id, purpose) : undefined;
  return { deskPublication: { ...checkpoint(item, 'complete'), publishRequest: publish?.id } };
};

const DESK_STEPS: Partial<Record<DeskStage, DeskStep>> = {
  commit: commitDesk, push: pushDesk, open: openDesk, merge: mergeDesk, finish: finishDesk,
};

export async function advanceDeskPublication(runtime: Runtime, itemId: string) {
  let item = await runtime.ledger.update(itemId, current => {
    if (current.activeRunner) throw new Error('work_item_active');
    if (current.status === 'cancelled') throw new Error('work_item_cancelled');
    return { ...current, status: 'landing', resumeStatus: 'landing', activeRunner: process.pid, reason: undefined };
  });
  try {
    let step = DESK_STEPS[item.deskPublication!.stage];
    while (step) {
      const changes = await step(runtime, item);
      item = await runtime.ledger.update(item.id, current => ({ ...current, ...changes }));
      step = DESK_STEPS[item.deskPublication!.stage];
    }
    item = await runtime.ledger.update(item.id, current => ({ ...current, status: 'landed', activeRunner: undefined }));
    await runtime.notebook(item.owner).journal({ kind: 'desk-change-published', workItem: item.id, outcome: item.publication?.url });
  } catch (error) {
    item = await runtime.ledger.update(item.id, current => ({
      ...current, status: 'failed', activeRunner: undefined, reason: error instanceof Error ? error.message : String(error),
    }));
  }
  return item;
}
