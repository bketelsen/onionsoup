import { execFile } from 'node:child_process';
import { z } from 'zod';
import { promisify } from 'node:util';
import type { WorkItem } from './ledger.ts';
import type { Runtime } from './runtime.ts';
import { git } from './workspace.ts';

const run = promisify(execFile);

function section(title: string, lines: readonly string[]) {
  return lines.length ? [`### ${title}`, '', ...lines, ''] : [];
}

function prBody(item: WorkItem) {
  const lastImplementation = item.implementations.at(-1);
  const lastVerdict = item.verdicts.at(-1);
  const verification = (lastImplementation?.verification ?? []).map(result => `- \`${result.command}\`: exit ${result.exitCode}`);
  const hires = item.hires.map(hire => `| ${hire.stage} | ${hire.craft} | \`${hire.model}\` | ${hire.family} | ${hire.outcome} |`);
  return [
    item.plan?.summary ?? item.proposal.goal,
    '',
    ...section('Why', [item.proposal.rationale]),
    ...section('Acceptance', item.proposal.acceptance.map(entry => `- ${entry}`)),
    ...section('Plan', (item.plan?.steps ?? []).map((step, index) => `${index + 1}. ${step.description}`)),
    ...section('Host verification (sandboxed)', verification),
    ...section('Review', lastVerdict ? [`${lastVerdict.decision}: ${lastVerdict.summary}`] : []),
    ...section('Who did what', ['| stage | craft | model | family | outcome |', '|---|---|---|---|---|', ...hires]),
    `Opened by the onionsoup owner \`${item.owner}\` for work item \`${item.id}\`. Plan approved by ${item.planApproval?.by ?? 'unknown'}.`,
  ].join('\n');
}

/** Push a landed work item's branch and open a draft PR. Only a person runs this; no model can reach it. */
export async function publish(runtime: Runtime, itemId: string, by: string) {
  const item = await runtime.ledger.update(itemId, current => {
    if (current.publication) return current;
    if (current.activeRunner) throw new Error('work_item_active');
    if (current.status !== 'landed' || !current.branch || !current.landedCommit) throw new Error(`not_landed: ${current.status}`);
    return { ...current, activeRunner: process.pid, resumeStatus: 'landed' };
  });
  if (item.publication) return item;
  try {
    await publishClaimed(runtime, item, by);
    return await runtime.ledger.update(itemId, current => ({ ...current, activeRunner: undefined, reason: undefined }));
  } catch (error) {
    await runtime.ledger.update(itemId, current => ({
      ...current, activeRunner: undefined, reason: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}

async function publishClaimed(runtime: Runtime, item: WorkItem, by: string) {
  const owner = runtime.repositoryFor(item);
  if (item.repairOf) return publishRepair(runtime, item, by);
  const existing = await run('gh', ['pr', 'list', '--repo', owner.domain.name, '--head', item.branch!, '--state', 'all', '--json', 'url,state']);
  const previous = z.array(PublishedPullRequest).parse(JSON.parse(existing.stdout))[0];
  const opened = previous ?? await openPullRequest(runtime, item);
  const states = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;
  const url = opened.url;
  const published = { ...item, publication: {
    url, branch: item.branch!, by, at: new Date().toISOString(), state: states[opened.state],
  } };
  await runtime.notebook(item.owner).journal({ kind: 'published', workItem: item.id, outcome: url, note: `by ${by}` });
  await runtime.notebook(item.owner).commit(`journal ${item.id}`);
  return runtime.ledger.update(item.id, current => ({ ...current, publication: published.publication }));
}

const PublishedPullRequest = z.object({ url: z.string(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']) });

async function openPullRequest(runtime: Runtime, item: WorkItem) {
  const owner = runtime.repositoryFor(item);
  await git(owner.workspace, ['push', '-q', 'origin', `${item.branch}:${item.branch}`]);
  const { stdout } = await run('gh', [
    'pr', 'create', '--draft', '--repo', owner.domain.name, '--base', owner.domain.baseBranch,
    '--head', item.branch!, '--title', item.proposal.title, '--body', prBody(item),
  ]);
  return PublishedPullRequest.parse({ url: stdout.trim().split('\n').at(-1), state: 'OPEN' });
}

/** A repair appends to the original PR; reject a moved head instead of overwriting somebody else's work. */
async function publishRepair(runtime: Runtime, item: WorkItem, by: string) {
  const target = item.repairOf!;
  const owner = runtime.repositoryFor(item);
  const { stdout } = await run('gh', ['pr', 'view', target.prUrl, '--json', 'state,headRefOid']);
  const remote = z.object({ state: z.string(), headRefOid: z.string() }).parse(JSON.parse(stdout));
  if (remote.state !== 'OPEN') throw new Error('repair_pr_not_open');
  const wasPushed = remote.headRefOid === item.landedCommit;
  if (!wasPushed && remote.headRefOid !== target.previousHead) throw new Error('repair_head_changed');
  if (!wasPushed) {
    await git(owner.workspace, ['merge-base', '--is-ancestor', target.previousHead, item.landedCommit!]);
    await git(owner.workspace, ['push', '-q', `--force-with-lease=${target.branch}:${target.previousHead}`,
      'origin', `${item.landedCommit}:refs/heads/${target.branch}`]);
  }
  const publication = { url: target.prUrl, branch: target.branch, by, at: new Date().toISOString(), state: 'open' as const };
  await runtime.ledger.update(target.itemId, source => ({ ...source, landedCommit: item.landedCommit }));
  const published = await runtime.ledger.update(item.id, current => ({ ...current, publication }));
  await runtime.notebook(item.owner).journal({ kind: 'published', workItem: item.id, outcome: target.prUrl, note: `CI repair by ${by}` });
  return published;
}
