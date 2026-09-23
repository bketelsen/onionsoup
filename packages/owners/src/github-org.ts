import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GithubOrgDomain } from './declarations.ts';

const run = promisify(execFile);

export const GITHUB_ORG_LIMITS = { repos: 200, runsPerRepo: 1, timeoutMs: 60_000 };

async function gh(args: readonly string[]) {
  const { stdout } = await run('gh', [...args], { timeout: GITHUB_ORG_LIMITS.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

interface RepoFacts {
  name: string;
  description: string;
  pushedAt: string;
  openPullRequests: number;
  openIssues: number;
  defaultBranchCi: string;
}

async function defaultBranchCi(org: string, repo: string, branch: string) {
  const runs = JSON.parse(await gh(['run', 'list', '--repo', `${org}/${repo}`, '--branch', branch, '--limit', String(GITHUB_ORG_LIMITS.runsPerRepo), '--json', 'conclusion,status,workflowName,createdAt']).catch(() => '[]')) as { conclusion: string; status: string; workflowName: string; createdAt: string }[];
  const latest = runs[0];
  return latest ? `${latest.workflowName}: ${latest.status === 'completed' ? latest.conclusion : latest.status} (${latest.createdAt.slice(0, 10)})` : 'no runs';
}

/** Host code writes a read-only snapshot of the org into the owner's evidence folder: repos, open work, CI. */
export async function refreshGithubOrgEvidence(domain: GithubOrgDomain, evidenceDirectory: string) {
  const takenAt = new Date().toISOString();
  const listed = JSON.parse(await gh(['repo', 'list', domain.org, '--no-archived', '--limit', String(GITHUB_ORG_LIMITS.repos),
    '--json', 'name,description,pushedAt,defaultBranchRef,pullRequests,issues'])) as {
      name: string; description: string | null; pushedAt: string; defaultBranchRef: { name: string } | null;
      pullRequests: { totalCount: number }; issues: { totalCount: number };
    }[];
  const recent = listed.sort((left, right) => right.pushedAt.localeCompare(left.pushedAt));
  const facts: RepoFacts[] = [];
  for (const repo of recent) {
    const watched = domain.watch.length === 0 || domain.watch.includes(repo.name);
    facts.push({
      name: repo.name,
      description: repo.description ?? '',
      pushedAt: repo.pushedAt.slice(0, 10),
      openPullRequests: repo.pullRequests.totalCount,
      openIssues: repo.issues.totalCount,
      defaultBranchCi: watched && repo.defaultBranchRef ? await defaultBranchCi(domain.org, repo.name, repo.defaultBranchRef.name) : 'not watched',
    });
  }
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'repos.json'), JSON.stringify(facts, null, 2) + '\n');
  const table = facts.map(fact => `| ${fact.name} | ${fact.pushedAt} | ${fact.openPullRequests} | ${fact.openIssues} | ${fact.defaultBranchCi} |`).join('\n');
  await writeFile(join(evidenceDirectory, 'SNAPSHOT.md'), `# ${domain.org} snapshot

Taken ${takenAt} by host code with gh (read-only). ${facts.length} active repositories, most recently pushed first.
CI is the latest default-branch run${domain.watch.length ? ` for watched repositories (${domain.watch.join(', ')})` : ''}.

| repository | last push | open PRs | open issues | default-branch CI |
|---|---|---|---|---|
${table}
`);
  return `snapshot ${takenAt}`;
}
