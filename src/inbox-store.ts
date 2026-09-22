import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IssueSnapshot, validateAssessment } from './contracts.ts';
import { inputHash, type RunRecord } from './triage.ts';
import { atomicJson, optionalJson, projectRoot } from './batch-store.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';
import { EVALUATION_MODEL } from './evaluation-policy.ts';

export { atomicJson };
export { Repository, Observation } from '@onionsoup/maintenance/issues';
import { Repository, Observation } from '@onionsoup/maintenance/issues';
export const Config = z.object({ schemaVersion: z.literal(1), repository: Repository,
  provider: z.enum(['copilot', 'codex']), model: z.literal(EVALUATION_MODEL),
  createdAt: z.iso.datetime(), promptVersion: z.string(), runtimeHash: z.string(), promptText: z.string(),
}).strict();
export type Config = z.infer<typeof Config>;
export const Index = z.object({ schemaVersion: z.literal(1), observations: z.array(Observation),
  lastScanAt: z.iso.datetime().optional(), scannedEntries: z.number().optional(), windowFull: z.boolean().optional(),
}).strict();
export type Index = z.infer<typeof Index>;
export type Attempt = { sequence: number; contentHash: string; record: RunRecord };
export type Refresh = { schemaVersion: 1; id: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed'; mode: 'refresh' | 'retry';
  maxIssues: number; maxSeconds: number; pages: number; pointReads: number; scanned: number; changed: number;
  skipped: number; attempted: number; completed: number; failed: number; warning?: string };

// Metadata-only changes must not spend model tokens. The original full snapshot stays in the run.
export function contentHash(input: IssueSnapshot) {
  return createHash('sha256').update(JSON.stringify([input.repository, input.number, input.title, input.body])).digest('hex');
}
export async function runtimeHash() {
  const files = ['packages/maintenance/src/contracts.ts', 'packages/maintenance/src/prompt.ts', 'packages/maintenance/src/triage.ts', 'packages/providers/src/index.ts', 'src/evaluation-policy.ts',
    'src/inbox-store.ts', 'packages/maintenance/src/github-issues.ts', 'src/inbox.ts', 'package-lock.json'];
  const contents = await Promise.all(files.map(file => readFile(join(projectRoot, file))));
  const hash = createHash('sha256');
  contents.forEach((bytes, i) => hash.update(files[i]).update('\0').update(bytes).update('\0'));
  return hash.digest('hex');
}
export async function loadConfig(directory: string) { return Config.parse(await optionalJson(join(directory, 'config.json'))); }
export async function initialize(directory: string, repository: string, provider: 'copilot' | 'codex') {
  Repository.parse(repository);
  const file = join(directory, 'config.json');
  const raw = await optionalJson(file);
  const hash = await runtimeHash();
  if (raw) {
    const config = Config.parse(raw);
    if (config.repository !== repository || config.provider !== provider || config.runtimeHash !== hash ||
      config.promptVersion !== PROMPT_VERSION || config.promptText !== SYSTEM_PROMPT)
      throw new Error('Inbox configuration/runtime changed. Use a new directory; the existing inbox remains readable.');
    return config;
  }
  const config: Config = { schemaVersion: 1, repository, provider, model: EVALUATION_MODEL,
    createdAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, promptText: SYSTEM_PROMPT, runtimeHash: hash };
  await atomicJson(file, config);
  return config;
}
export async function loadIndex(directory: string, config: Config): Promise<Index> {
  const index = Index.parse(await optionalJson(join(directory, 'index.json')) ?? { schemaVersion: 1, observations: [] });
  if (new Set(index.observations.map(o => o.number)).size !== index.observations.length) throw new Error('Duplicate inbox issue');
  for (const o of index.observations) if (o.snapshot && (o.snapshot.repository !== config.repository ||
    o.snapshot.number !== o.number || o.snapshot.title !== o.title || o.snapshot.updatedAt !== o.updatedAt))
    throw new Error('Inbox snapshot identity mismatch');
  return index;
}
export function attemptPath(directory: string, attempt: Attempt) {
  return join(directory, 'records', `${String(attempt.sequence).padStart(8, '0')}-${attempt.record.runId}.json`);
}
export async function loadAttempts(directory: string, config: Config): Promise<Attempt[]> {
  let names: string[];
  try { names = await readdir(join(directory, 'records')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const attempts: Attempt[] = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const a = await optionalJson(join(directory, 'records', name)) as Attempt;
    const r = a?.record;
    if (!Number.isSafeInteger(a?.sequence) || a.sequence < 1 || !r || r.schemaVersion !== 2 ||
      !z.string().uuid().safeParse(r.runId).success || !['running', 'completed', 'failed'].includes(r.status) ||
      !IssueSnapshot.safeParse(r.input).success || r.input.repository !== config.repository ||
      r.provider !== config.provider || r.model !== config.model || r.promptVersion !== config.promptVersion ||
      r.inputHash !== inputHash(r.input) || a.contentHash !== contentHash(r.input) ||
      !Array.isArray(r.events) || !Number.isFinite(Date.parse(r.startedAt)) ||
      (r.status !== 'running' && (!r.finishedAt || !Number.isFinite(Date.parse(r.finishedAt)))) ||
      name !== `${String(a.sequence).padStart(8, '0')}-${r.runId}.json`)
      throw new Error('Invalid inbox attempt; inspect records before continuing');
    if (r.status === 'completed') validateAssessment(r.assessment, r.input);
    else if (r.assessment) throw new Error('Unfinished/failed attempt contains assessment');
    attempts.push(a);
  }
  if (new Set(attempts.map(a => a.sequence)).size !== attempts.length) throw new Error('Duplicate attempt sequence');
  return attempts.sort((a, b) => a.sequence - b.sequence);
}
export function latestAttempt(attempts: Attempt[], snapshot: IssueSnapshot) {
  return attempts.filter(a => a.contentHash === contentHash(snapshot)).at(-1);
}
export async function withInboxLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, '.refresh.lock');
  const handle = await open(file, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Inbox is locked. If its process died, use inbox recover; do not start another refresh.');
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), at: new Date().toISOString() }));
    return await work();
  } finally { await handle.close(); await unlink(file); }
}
export async function recoverInbox(directory: string) {
  // Serialize explicit recovery commands. Refresh never automatically steals a lock.
  const guardPath = join(directory, '.recovery.lock');
  const guard = await open(guardPath, 'wx', 0o600);
  try {
    const lockPath = join(directory, '.refresh.lock');
    const old = await optionalJson(lockPath) as { pid: number; host: string } | undefined;
    if (old) {
      if (old.host !== hostname() || !Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Error('Cannot verify lock owner; inspect manually');
      try { process.kill(old.pid, 0); throw new Error('Lock owner is still alive; recovery refused'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await unlink(lockPath);
    }
    return await withInboxLock(directory, async () => {
      const config = await loadConfig(directory);
      const attempts = await loadAttempts(directory, config);
      let recovered = 0;
      for (const a of attempts.filter(a => a.record.status === 'running')) {
        a.record.status = 'failed'; a.record.failure = 'interrupted_process';
        a.record.finishedAt = new Date().toISOString();
        a.record.events.push({ type: 'recoveredInterruptedRun', at: a.record.finishedAt });
        await atomicJson(attemptPath(directory, a), a); recovered++;
      }
      return recovered;
    });
  } finally { await guard.close(); await unlink(guardPath); }
}
