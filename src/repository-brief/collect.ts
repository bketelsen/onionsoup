import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BriefRequest, CollectionKey, Item, CIRun, Snapshot, REPO_BRIEF_LIMITS, type Collection } from './contracts.ts';
const execute = promisify(execFile);
export type GithubReader = (endpoint: string, signal: AbortSignal) => Promise<unknown>;
export const githubReader: GithubReader = async (endpoint, signal) => {
  const { stdout } = await execute('gh', ['api', '--method', 'GET', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint],
    { signal, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};
const now = () => new Date().toISOString();
const Search = z.object({ total_count: z.number().int().nonnegative(), incomplete_results: z.boolean(), items: z.array(z.unknown()).max(100) });
const RawItem = z.object({ number: z.number().int().positive(), repository_url: z.string(), title: z.string(),
  labels: z.array(z.object({ name: z.string() })), user: z.object({ login: z.string(), type: z.string() }).nullable(),
  state: z.enum(['open','closed']), created_at: z.iso.datetime(), updated_at: z.iso.datetime(), closed_at: z.iso.datetime().nullable(),
  pull_request: z.object({ merged_at: z.iso.datetime().nullable().optional() }).optional() });
function parseItem(raw: unknown, repository: string) {
  const r = RawItem.parse(raw);
  if (r.repository_url.toLowerCase() !== `https://api.github.com/repos/${repository}`.toLowerCase()) throw new Error('Mismatched repository');
  const kind = r.pull_request ? 'pr' : 'issue';
  return Item.parse({ id: `${kind}:${r.number}`, number: r.number, kind, title: r.title, labels: r.labels.map(l => l.name),
    author: r.user?.login ?? null, bot: r.user?.type === 'Bot', state: r.state, createdAt: r.created_at, updatedAt: r.updated_at,
    closedAt: r.closed_at, mergedAt: r.pull_request?.merged_at ?? null });
}
// GitHub ignores repeated comparison qualifiers in this endpoint. Use one inclusive
// range with second-resolution endpoints representing the half-open request window.
export function githubDateRange(request: BriefRequest) {
  const first = new Date(Math.ceil(Date.parse(request.since) / 1000) * 1000).toISOString().replace('.000Z','Z');
  const last = new Date(Math.ceil(Date.parse(request.until) / 1000) * 1000 - 1000).toISOString().replace('.000Z','Z');
  return `${first}..${last}`;
}
export function collectionQuery(request: BriefRequest, key: CollectionKey) {
  const range = (field: string) => `${field}:${githubDateRange(request)}`;
  const suffix: Record<CollectionKey,string> = {
    openIssues: 'is:issue is:open', openPRs: 'is:pr is:open', createdIssues: `is:issue ${range('created')}`,
    closedIssues: `is:issue is:closed ${range('closed')}`, createdPRs: `is:pr ${range('created')}`,
    mergedPRs: `is:pr is:merged ${range('merged')}`, closedUnmergedPRs: `is:pr is:closed is:unmerged ${range('closed')}`,
  };
  return `repo:${request.repository} ${suffix[key]}`;
}
export function matchesCollection(i: Item, key: CollectionKey, r: BriefRequest) {
  const within = (at: string | null) => at !== null && Date.parse(at) >= Date.parse(r.since) && Date.parse(at) < Date.parse(r.until);
  if (i.kind !== (key.endsWith('Issues') ? 'issue' : 'pr')) return false;
  if (key.startsWith('open')) return i.state === 'open';
  if (key.startsWith('created')) return within(i.createdAt);
  if (key === 'mergedPRs') return within(i.mergedAt);
  return i.state === 'closed' && within(i.closedAt) && (key !== 'closedUnmergedPRs' || i.mergedAt === null);
}
export async function collectRepository(raw: unknown, options: { reader?: GithubReader; signal: AbortSignal;
  checkpoint?: (snapshot: Snapshot) => Promise<void> }): Promise<Snapshot> {
  const request = BriefRequest.parse(raw), reader = options.reader ?? githubReader;
  const startedAt = now(); let requestsUsed = 0;
  const read = async (endpoint: string) => {
    options.signal.throwIfAborted();
    if (requestsUsed >= REPO_BRIEF_LIMITS.requests) throw new Error('Request allowance exhausted');
    requestsUsed++; return reader(endpoint, options.signal);
  };
  const search = async (query: string, perPage = 100, sort = 'updated', order = 'desc') => Search.parse(await read(
    `search/issues?${new URLSearchParams({ q: query, per_page: String(perPage), sort, order })}`));
  const collections: Collection[] = [];
  for (const key of CollectionKey.options) {
    const c: Collection = { key, query: collectionQuery(request, key), observedAt: now(), status: 'unavailable',
      total: null, incomplete: true, items: [], rejected: 0 };
    try {
      const response = await search(c.query);
      c.total = response.total_count; c.incomplete = response.incomplete_results; c.status = 'available';
      const seen = new Set<string>();
      for (const row of response.items) {
        try {
          const item = parseItem(row, request.repository);
          if (!matchesCollection(item, key, request) || seen.has(item.id)) throw new Error('Invalid collection member');
          seen.add(item.id); c.items.push(item);
        } catch { c.rejected++; }
      }
    } catch { c.failure = options.signal.aborted ? 'cancelled' : 'request_failed'; }
    c.observedAt = now(); collections.push(c);
  }
  let defaultBranch: string | null = null;
  const ci: Snapshot['ci'] = { observedAt: now(), status: 'unavailable', total: null, runs: [], rejected: 0 };
  try {
    const repo = z.object({ full_name: z.string(), default_branch: z.string().min(1) }).parse(await read(`repos/${request.repository}`));
    if (repo.full_name.toLowerCase() !== request.repository.toLowerCase()) throw new Error('Repository mismatch');
    defaultBranch = repo.default_branch;
    const response = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(z.unknown()).max(100) }).parse(
      await read(`repos/${request.repository}/actions/runs?${new URLSearchParams({ branch: defaultBranch, created: githubDateRange(request), per_page: '100' })}`));
    ci.status = 'available'; ci.total = response.total_count;
    const seen = new Set<number>();
    for (const row of response.workflow_runs) {
      try {
        const r = z.object({ id: z.number(), name: z.string().nullable(), head_branch: z.string(), created_at: z.string(),
          status: z.string(), conclusion: z.string().nullable(), run_attempt: z.number() }).parse(row);
        const run = CIRun.parse({ id: r.id, name: r.name ?? 'Unnamed workflow', branch: r.head_branch,
          createdAt: r.created_at, status: r.status, conclusion: r.conclusion, attempt: r.run_attempt });
        if (run.branch !== defaultBranch || Date.parse(run.createdAt) < Date.parse(request.since) ||
          Date.parse(run.createdAt) >= Date.parse(request.until) || seen.has(run.id)) throw new Error('Invalid CI row');
        seen.add(run.id); ci.runs.push(run);
      } catch { ci.rejected++; }
    }
  } catch { /* Unavailable is not zero. */ }
  ci.observedAt = now();
  const candidates = [...new Set(collections.find(c => c.key === 'createdPRs')!.items.filter(i => !i.bot && i.author).map(i => i.author!))].sort();
  const checks: Snapshot['contributors']['checks'] = [];
  for (const author of candidates.slice(0, REPO_BRIEF_LIMITS.contributorChecks)) {
    const check: Snapshot['contributors']['checks'][number] = { author, outcome: 'unknown', observedAt: now() };
    try {
      const response = await search(`repo:${request.repository} is:pr author:${author}`, 1, 'created', 'asc');
      if (response.incomplete_results || !response.items.length) throw new Error('Incomplete history');
      const first = parseItem(response.items[0], request.repository);
      if (first.kind !== 'pr' || first.author !== author || Date.parse(first.createdAt) >= Date.parse(request.until)) throw new Error('History mismatch');
      check.firstPR = first.number; check.firstCreatedAt = first.createdAt;
      check.outcome = Date.parse(first.createdAt) >= Date.parse(request.since) ? 'new' : 'existing';
    } catch { /* Unknown history remains unknown. */ }
    check.observedAt = now(); checks.push(check);
  }
  const snapshot = Snapshot.parse({ schemaVersion: 1, request, startedAt, finishedAt: now(), requestsUsed, defaultBranch, collections, ci,
    contributors: { candidates, checks } });
  await options.checkpoint?.(snapshot); return snapshot;
}
