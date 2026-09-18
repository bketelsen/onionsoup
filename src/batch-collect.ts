import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IssueSnapshot } from './contracts.ts';
import { inputHash } from './triage.ts';
import { BatchManifest, type BatchCase } from './batch-contracts.ts';
import { EVALUATION_MODEL } from './evaluation-policy.ts';
import { atomicJson, freezeRuntime } from './batch-store.ts';

const execute = promisify(execFile);
const GitHubIssue = z.object({ number: z.number().int().positive(), title: z.string(),
  body: z.string().nullable(), updated_at: z.string(), comments: z.number().int().nonnegative(),
  pull_request: z.unknown().optional(), type: z.object({ name: z.string() }).nullable().optional(),
  labels: z.array(z.object({ name: z.string() })).optional(),
});

export function selectCases(raw: unknown[], repository: string, options: { count: number; before?: number; seed: string }) {
  const buckets: Record<BatchCase['bucket'], BatchCase[]> = { short: [], feature: [], intermittent: [], detailed: [] };
  const seen = new Set<number>();
  let rejectedCount = 0;
  for (const row of raw) {
    const parsed = GitHubIssue.safeParse(row);
    if (!parsed.success) { rejectedCount++; continue; }
    const issue = parsed.data;
    if (issue.pull_request !== undefined || seen.has(issue.number) || (options.before && issue.number >= options.before)) continue;
    seen.add(issue.number);
    const parsedInput = IssueSnapshot.safeParse({ schemaVersion: 1, repository, number: issue.number,
      title: issue.title, body: issue.body ?? '', updatedAt: issue.updated_at });
    if (!parsedInput.success) { rejectedCount++; continue; }
    const input = parsedInput.data;
    // These buckets balance source shapes, not predicted model outcomes or gold labels.
    const feature = /feature|enhancement/i.test(issue.type?.name ?? '') ||
      issue.labels?.some(l => /feature|enhancement/i.test(l.name)) || /describe the enhancement|what i.d like to add/i.test(input.body);
    const bucket = input.body.length < 1500 ? 'short' : feature ? 'feature' :
      /intermittent|sometimes|sporadic|randomly|no deterministic|unverified reproduction/i.test(input.body) ? 'intermittent' : 'detailed';
    buckets[bucket].push({ input, inputHash: inputHash(input),
      url: `https://github.com/${repository}/issues/${issue.number}`,
      commentsExcluded: issue.comments, bucket, declaredAgentGenerated: /agent.generated|prepared by.*(?:bot|assistant)|prepared by GPT/i.test(input.body) });
  }
  const rank = (item: BatchCase) => createHash('sha256').update(`${options.seed}:${repository}:${item.input.number}`).digest('hex');
  for (const rows of Object.values(buckets)) rows.sort((a, b) => rank(a).localeCompare(rank(b)));
  const eligibleCount = Object.values(buckets).reduce((sum, b) => sum + b.length, 0);
  const selected: BatchCase[] = [];
  while (selected.length < options.count) {
    let added = false;
    for (const rows of Object.values(buckets)) {
      if (rows.length && selected.length < options.count) { selected.push(rows.shift()!); added = true; }
    }
    if (!added) throw new Error(`Only ${eligibleCount} eligible issues; requested ${options.count}`);
  }
  return { cases: selected, eligibleCount, rejectedCount };
}

export async function collectBatch(repository: string, directory: string, options: {
  count: number; before?: number; seed: string; provider: 'copilot' | 'codex';
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Repository must be owner/name');
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 50) throw new Error('Count must be 1–50');
  if (options.before !== undefined && (!Number.isInteger(options.before) || options.before < 1)) throw new Error('Before must be a positive issue number');
  const rows: unknown[] = [];
  for (let page = 1; page <= 3; page++) {
    const { stdout } = await execute('gh', ['api', `repos/${repository}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`],
      { maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
    const items: unknown = JSON.parse(stdout);
    if (!Array.isArray(items)) throw new Error('GitHub did not return an issue list');
    rows.push(...items);
    if (items.length < 100) break;
  }
  const selection = selectCases(rows, repository, options);
  const manifest: BatchManifest = BatchManifest.parse({ schemaVersion: 1, batchId: randomUUID(),
    capturedAt: new Date().toISOString(), repository, provider: options.provider, models: [EVALUATION_MODEL],
    selection: { seed: options.seed, before: options.before ?? null, requestedCount: options.count,
      fetchedEntries: rows.length, eligibleCount: selection.eligibleCount, rejectedCount: selection.rejectedCount,
      method: 'Seeded hash ordering within short, feature, intermittent, detailed buckets; round-robin selection from at most 300 latest open API entries. No model output used.' },
    frozen: await freezeRuntime(),
    criteria: { minimumCases: 30, acceptanceRate: 0.9, allowedFalseReady: 0, costDecision: 'human_required' },
    cases: selection.cases });
  // Refuse an existing batch rather than replacing snapshots or prior evaluations.
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await atomicJson(join(directory, 'manifest.json'), manifest);
  return manifest;
}
