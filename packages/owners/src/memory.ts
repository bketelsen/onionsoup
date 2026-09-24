import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Learnings } from './artifacts.ts';
import { distillBrief } from './briefs.ts';
import { MemoryState, type MemoryStatus } from './memory-config.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

function paths(runtime: Runtime, ownerId: string) {
  const directory = join(runtime.stateDirectory, 'memory', ownerId);
  return { directory, state: join(directory, 'state.json'), queue: join(directory, 'queue') };
}

function isAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readState(runtime: Runtime, ownerId: string) {
  const contents = await readFile(paths(runtime, ownerId).state, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  const state = MemoryState.parse(JSON.parse(contents));
  if (state.status === 'running' && !isAlive(state.activeRunner)) {
    return { ...state, status: 'failed' as const, activeRunner: undefined, error: 'distill_interrupted: runtime stopped' };
  }
  return state;
}

async function saveState(runtime: Runtime, ownerId: string, state: MemoryState) {
  const target = paths(runtime, ownerId);
  await mkdir(target.directory, { recursive: true });
  const temporary = `${target.state}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + '\n');
  await rename(temporary, target.state);
}

async function queued(runtime: Runtime, ownerId: string) {
  return (await readdir(paths(runtime, ownerId).queue).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(file => file.endsWith('.json')).sort();
}

/** Queue a manual run without competing for the daemon's lock or erasing a concurrent request. */
export async function requestDistill(runtime: Runtime, ownerId: string, by: string) {
  runtime.owner(ownerId);
  const queue = paths(runtime, ownerId).queue;
  await mkdir(queue, { recursive: true });
  const at = new Date().toISOString();
  await writeFile(join(queue, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ at, by }) + '\n');
  return memoryStatus(runtime, ownerId);
}

export async function memoryStatus(runtime: Runtime, ownerId: string): Promise<MemoryStatus> {
  const owner = runtime.owner(ownerId);
  const state = await readState(runtime, ownerId);
  const requests = await queued(runtime, ownerId);
  const requestedAt = Number(requests.at(-1)?.split('-')[0] ?? 0);
  const attemptedAt = state.lastAttempt ? Date.parse(state.lastAttempt) : 0;
  const interval = state.status === 'failed' ? owner.memory.retryMs
    : state.hasMore ? owner.memory.batchDelayMs : owner.memory.everyMs;
  const isImmediate = requests.length > 0 && (state.status === 'idle' || requestedAt > attemptedAt);
  const nextAttemptAt = owner.memory.enabled || requests.length
    ? new Date(isImmediate ? Date.now() : attemptedAt + interval).toISOString() : undefined;
  return { ...state, queued: requests.length > 0, automatic: owner.memory.enabled, nextAttemptAt };
}

async function snapshotFor(runtime: Runtime, ownerId: string, state: MemoryState) {
  const legacy = state.cursor ? undefined : await readFile(
    join(runtime.stateDirectory, `distill-${ownerId}.txt`), 'utf8',
  ).then(text => text.trim(), (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return runtime.notebook(ownerId).journalSnapshot(runtime.owner(ownerId).memory, state.cursor, legacy);
}

/** Check time and input deterministically; an empty journal never wakes a model. */
export async function distillIsDue(runtime: Runtime, ownerId: string, now = Date.now()) {
  const policy = runtime.owner(ownerId).memory;
  const state = await readState(runtime, ownerId);
  const requests = await queued(runtime, ownerId);
  const requestedAt = Number(requests.at(-1)?.split('-')[0] ?? 0);
  const attemptedAt = state.lastAttempt ? Date.parse(state.lastAttempt) : 0;
  if (state.status !== 'idle' && requestedAt <= attemptedAt && now - attemptedAt < policy.retryMs) return false;
  if (requests.length) return true;
  const interval = state.status !== 'idle' ? policy.retryMs : state.hasMore ? policy.batchDelayMs : policy.everyMs;
  if (!policy.enabled || now - attemptedAt < interval) return false;
  try {
    const snapshot = await snapshotFor(runtime, ownerId, state);
    const advancesWithoutHire = !snapshot.lines.length && JSON.stringify(snapshot.cursor) !== JSON.stringify(state.cursor);
    return advancesWithoutHire || snapshot.lines.length >= policy.minEntries || (state.hasMore && snapshot.lines.length > 0);
  } catch (error) {
    // Execute once to persist the bad entry for the surface, then use the retry delay without losing it.
    if (error instanceof Error && /^memory_entry_(too_large|invalid):/.test(error.message)) return true;
    throw error;
  }
}

async function consumeRequests(runtime: Runtime, ownerId: string, requests: string[]) {
  for (const request of requests) {
    await unlink(join(paths(runtime, ownerId).queue, request)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function runSnapshot(runtime: Runtime, ownerId: string, state: MemoryState) {
  const snapshot = await snapshotFor(runtime, ownerId, state);
  if (!snapshot.lines.length) return { edits: 0, cost: 0, entries: 0, cursor: snapshot.cursor, hasMore: snapshot.hasMore };
  const owner = runtime.owner(ownerId);
  const notebook = runtime.notebook(ownerId);
  await notebook.ensure(await runtime.text(`charters/${ownerId}.md`));
  const brief = distillBrief(snapshot.lines, await notebook.orientation());
  const delivered = await runtime.hire(ownerId, {
    role: 'owner', model: owner.model, directory: owner.workspace,
    title: `${ownerId}: distill`, brief, schema: Learnings,
  });
  await notebook.apply(delivered.value.notebook, `distill ${snapshot.lines.length} journal lines`);
  return { edits: delivered.value.notebook.length, cost: delivered.cost,
    entries: snapshot.lines.length, cursor: snapshot.cursor, hasMore: snapshot.hasMore };
}

async function executeDistill(runtime: Runtime, ownerId: string) {
  const previous = await readState(runtime, ownerId);
  const requests = await queued(runtime, ownerId);
  let saved: MemoryState = {
    ...previous, status: 'running', lastAttempt: new Date().toISOString(), error: undefined, activeRunner: process.pid,
  };
  await saveState(runtime, ownerId, saved);
  try {
    const outcome = await runSnapshot(runtime, ownerId, previous);
    saved = { ...saved, status: 'idle', cursor: outcome.cursor, hasMore: outcome.hasMore, activeRunner: undefined,
      lastCompleted: outcome.entries ? new Date().toISOString() : previous.lastCompleted,
      entries: outcome.entries, edits: outcome.edits };
    await saveState(runtime, ownerId, saved);
    if (!outcome.hasMore) await consumeRequests(runtime, ownerId, requests);
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await saveState(runtime, ownerId, { ...saved, status: 'failed', activeRunner: undefined, error: `distill_failed: ${reason}` });
    throw error;
  }
}

/** The daemon executes queued/automatic runs; the same lock protects direct callers across processes. */
export async function distill(runtime: Runtime, ownerId: string) {
  runtime.owner(ownerId);
  return withRecordLock(join(paths(runtime, ownerId).directory, 'run.lock'), () => executeDistill(runtime, ownerId));
}

/** Include memory state in the surface's change stream without reading journal contents. */
export async function memoryFingerprint(runtime: Runtime) {
  return Promise.all([...runtime.declarations.owners.keys()].map(ownerId => memoryStatus(runtime, ownerId)));
}
