import { execFile } from 'node:child_process';
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
  const item = await runtime.ledger.get(itemId);
  if (item.publication) return item;
  if (item.status !== 'landed' || !item.branch || !item.landedCommit) throw new Error(`not_landed: ${item.status}`);
  const owner = runtime.repositoryFor(item);
  await git(owner.workspace, ['push', '-q', 'origin', `${item.branch}:${item.branch}`]);
  const { stdout } = await run('gh', [
    'pr', 'create', '--draft',
    '--repo', owner.domain.name,
    '--base', owner.domain.baseBranch,
    '--head', item.branch,
    '--title', item.proposal.title,
    '--body', prBody(item),
  ]);
  const url = stdout.trim().split('\n').at(-1) ?? '';
  const published = { ...item, publication: { url, branch: item.branch, by, at: new Date().toISOString(), state: 'open' as const } };
  await runtime.notebook(item.owner).journal({ kind: 'published', workItem: item.id, outcome: url, note: `by ${by}` });
  await runtime.notebook(item.owner).commit(`journal ${item.id}`);
  return runtime.ledger.save(published);
}
