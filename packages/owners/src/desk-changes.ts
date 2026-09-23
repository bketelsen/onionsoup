import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function proposeDeskChanges(runtime: Runtime, ownerId: string, title: string, summary: string): Promise<DeskChangeResult> {
  const owner = runtime.repositoryOwner(ownerId);
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
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const branch = `owners/${owner.id}-${stamp}`;
  await git(desk.path, ['add', '-A']);
  await git(desk.path, ['commit', '-q', '-m', `${title}\n\n${summary}\n\nOwner: ${owner.id}\nReviewed-by: ${reviewer.model}`]);
  await git(desk.path, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  const created = await run('gh', ['pr', 'create', '--repo', owner.domain.name, '--base', owner.domain.baseBranch, '--head', branch, '--title', title,
    '--body', `${summary}\n\nReviewed by \`${reviewer.model}\`: ${verdict.summary}\n\nOpened by the onionsoup owner \`${owner.id}\` from its desk.`]);
  const url = created.stdout.trim().split('\n').at(-1) ?? '';
  if (!hasMergeGrant(owner)) {
    await notebook.journal({ kind: 'desk-change-opened', outcome: url, note: title });
    await notebook.commit('journal desk change').catch(() => undefined);
    return { outcome: 'opened', summary: `Opened ${url}; a person merges it.`, url };
  }
  await run('gh', ['pr', 'merge', url, '--squash', '--delete-branch']);
  await git(desk.path, ['fetch', '-q', 'origin']);
  await git(desk.path, ['reset', '-q', '--hard', `origin/${owner.domain.baseBranch}`]);
  await notebook.journal({ kind: 'desk-change-merged', outcome: url, note: `${title} (reviewed by ${reviewer.model}; merged under the person's merge grant)` });
  const hostsSite = [...runtime.declarations.owners.values()].flatMap(other => (other.domain.kind === 'truenas' ? other.domain.sites : [])).find(site => site.source === owner.id);
  const publish = hostsSite ? await requestPublish(runtime, owner.id, hostsSite.id, `Publish merged change: ${title}`) : undefined;
  await notebook.commit('journal desk change').catch(() => undefined);
  return { outcome: 'merged', summary: `Merged ${url}${publish ? `; publishing ${hostsSite!.id} (${publish.id})` : ''}.`, url, publishRequest: publish?.id };
}
