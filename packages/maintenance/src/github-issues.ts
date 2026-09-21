import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { IssueSnapshot } from './contracts.ts';
import { Repository, type Observation } from './issues.ts';

const execute = promisify(execFile);
const Issue = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  state: z.enum(['open', 'closed']), updated_at: z.iso.datetime(), comments: z.number().int().nonnegative(),
  pull_request: z.unknown().optional() });
export function observe(raw: unknown, repository: string, at: string): Observation | undefined {
  const issue = Issue.parse(raw);
  if (issue.pull_request !== undefined) return undefined;
  const snapshot = IssueSnapshot.safeParse({ schemaVersion: 1, repository, number: issue.number,
    title: issue.title, body: issue.body ?? '', updatedAt: issue.updated_at });
  return { number: issue.number, title: issue.title.slice(0, 500), state: issue.state,
    updatedAt: issue.updated_at, observedAt: at, commentsExcluded: issue.comments,
    ...(snapshot.success ? { snapshot: snapshot.data } : { rejection: 'invalid_snapshot' as const }) };
}
export type Scan = { observations: Observation[]; entries: number; windowFull: boolean };
export type Source = {
  scan(repository: string, pages: number, signal: AbortSignal): Promise<Scan>;
  get(repository: string, number: number, signal: AbortSignal): Promise<Observation>;
};
async function getJson(endpoint: string, signal: AbortSignal) {
  const { stdout } = await execute('gh', ['api', '--method', 'GET', endpoint],
    { signal, timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout) as unknown;
}
export const githubSource: Source = {
  async scan(repository, pages, signal) {
    Repository.parse(repository);
    const observations = new Map<number, Observation>();
    let entries = 0; let windowFull = false;
    for (let page = 1; page <= pages; page++) {
      const raw = await getJson(`repos/${repository}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`, signal);
      if (!Array.isArray(raw)) throw new Error('Invalid GitHub issue list');
      entries += raw.length; windowFull = raw.length === 100;
      for (const row of raw) {
        const item = observe(row, repository, new Date().toISOString());
        if (item && (!observations.has(item.number) || item.updatedAt > observations.get(item.number)!.updatedAt)) observations.set(item.number, item);
      }
      if (!windowFull) break;
    }
    return { observations: [...observations.values()], entries, windowFull };
  },
  async get(repository, number, signal) {
    Repository.parse(repository);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid issue number');
    const item = observe(await getJson(`repos/${repository}/issues/${number}`, signal), repository, new Date().toISOString());
    if (!item || item.number !== number) throw new Error('Expected matching issue, not pull request');
    return item;
  },
};
