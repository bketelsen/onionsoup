import { canReconcileRequest, reconcileRequest } from './request-recovery.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { processRequest, requestCanRun } from './brokering.ts';
import { chatDirectory } from './chats.ts';
import { requestParticipants } from './delegation.ts';
import { noticeWorkChanges } from './notices.ts';
import { superviseInitiatives } from './org-work.ts';
import { distill, distillIsDue } from './memory.ts';
import type { WorkItem } from './ledger.ts';
import { wake } from './owner.ts';
import { refreshPublications } from './rebase.ts';
import { requestRunnerIsAlive, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { advance, isRunnable, retirePipelineItems } from './work-recovery.ts';

export const DAEMON_LIMITS = {
  tickMs: 60_000, shutdownGraceMs: 5_000, parallelItems: 4, parallelDuties: 2, parallelMemory: 1, parallelRequests: 2,
};

/**
 * Long work runs beside the tick, not inside it: a work item's hires take many minutes, and while the tick waited
 * on them no duty, request or notice moved (a 15-minute check once went an hour late). Each job has a key; a key
 * runs at most once at a time, and each kind of job has a cap, so the machine is not buried in sandboxes.
 */
export class Background {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly limit: number) {}

  has(key: string) {
    return this.running.has(key);
  }

  get size() {
    return this.running.size;
  }

  keys() {
    return [...this.running.keys()];
  }

  /** Start `job` unless its key is running or the cap is reached; returns whether it started. */
  start(key: string, job: () => Promise<void>) {
    if (this.running.has(key) || this.running.size >= this.limit) return false;
    const done = job().finally(() => this.running.delete(key));
    this.running.set(key, done);
    return true;
  }

  /** Wait for everything started so far (a one-off tick from the CLI must not return while work runs). */
  async drain() {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }
}

const requests = new Background(DAEMON_LIMITS.parallelRequests);
const requestOwners = new Set<string>();

const items = new Background(DAEMON_LIMITS.parallelItems);
const duties = new Background(DAEMON_LIMITS.parallelDuties);
const memories = new Background(DAEMON_LIMITS.parallelMemory);

/** Wait for background work the ticks started. */
export async function drain() {
  await Promise.all([items.drain(), duties.drain(), memories.drain(), requests.drain()]);
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function everyMs(every: string) {
  const unit = every.at(-1)!;
  return Number(every.slice(0, -1)) * UNIT_MS[unit]!;
}

export interface TickLog {
  duty(ownerId: string, dutyId: string, summary: string): void;
  item(item: WorkItem): void;
  request(request: ResourceRequest): void;
  error(context: string, error: unknown): void;
}

async function readDutyState(path: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Record<string, string>;
}

/** Remember when a duty last ran, whether the daemon or a person started it. */
export async function recordDutyRun(runtime: Runtime, ownerId: string, dutyId: string) {
  const statePath = join(runtime.stateDirectory, 'duties.json');
  const lastRun = await readDutyState(statePath);
  lastRun[`${ownerId}/${dutyId}`] = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(lastRun, null, 2) + '\n');
}

async function runDueDuties(runtime: Runtime, log: TickLog, reserved: ReadonlySet<string>) {
  const statePath = join(runtime.stateDirectory, 'duties.json');
  const lastRun = await readDutyState(statePath);
  for (const owner of runtime.declarations.owners.values()) {
    if (memories.has(owner.id)) continue;
    for (const duty of owner.duties.filter(candidate => candidate.every)) {
      const key = `${owner.id}/${duty.id}`;
      const previous = lastRun[key] ? Date.parse(lastRun[key]) : 0;
      if (reserved.has(owner.id)) continue;
      if (Date.now() - previous < everyMs(duty.every!) || duties.has(key)) continue;
      const started = duties.start(key, async () => {
        try {
          const result = await wake(runtime, owner.id, duty.id);
          log.duty(owner.id, duty.id, result.survey.summary);
        } catch (error) {
          log.error(key, error);
        }
      });
      // A duty that could not start (the cap) stays due and starts on a later tick.
      if (!started) continue;
      lastRun[key] = new Date().toISOString();
      await writeFile(statePath, JSON.stringify(lastRun, null, 2) + '\n');
    }
  }
}

/**
 * Advance runnable work items in the background, at most one per owner at a time: an owner's items share its
 * checkout, where creating worktrees at once would collide.
 */
function advanceRunnable(runnable: readonly WorkItem[], runtime: Runtime, log: TickLog, reserved: ReadonlySet<string>) {
  const busyOwners = new Set(items.keys().map(key => key.split('/')[0]));
  for (const item of runnable) {
    if (memories.has(item.owner)) continue;
    if (reserved.has(item.owner) || busyOwners.has(item.owner) || items.has(`${item.owner}/${item.id}`)) continue;
    const started = items.start(`${item.owner}/${item.id}`, async () => {
      try {
        await advance(runtime, item.id, log.item);
      } catch (error) {
        log.error(item.id, error);
      }
    });
    if (started) busyOwners.add(item.owner);
  }
}

/** Memory hires run beside the tick, after the owner's existing work has finished. */
export async function scheduleMemory(runtime: Runtime, log: TickLog, unavailable: ReadonlySet<string> = new Set()) {
  const busy = new Set([...items.keys(), ...duties.keys()].map(key => key.split('/')[0]));
  for (const item of await runtime.ledger.list()) {
    if (item.activeRunner) busy.add(item.owner);
  }
  for (const ownerId of runtime.declarations.owners.keys()) {
    if (busy.has(ownerId) || unavailable.has(ownerId) || memories.has(ownerId)) continue;
    try {
      if (!(await distillIsDue(runtime, ownerId))) continue;
      memories.start(ownerId, async () => {
        try {
          const outcome = await distill(runtime, ownerId);
          log.duty(ownerId, 'distill', `${outcome.entries} entries, ${outcome.edits} edits`);
        } catch (error) {
          log.error(`${ownerId}/distill`, error);
        }
      });
    } catch (error) {
      log.error(`${ownerId}/distill`, error);
    }
  }
}

/** Requests sharing either owner serialize; different owners progress up to the configured cap. */
async function runRequests(runtime: Runtime, log: TickLog) {
  const busyOwners = new Set([...items.keys(), ...duties.keys()].map(key => key.split('/')[0]));
  for (const ownerId of memories.keys()) busyOwners.add(ownerId);
  for (const item of await runtime.ledger.list()) {
    if (item.activeRunner !== undefined && requestRunnerIsAlive(item.activeRunner)) busyOwners.add(item.owner);
  }
  const pendingRequests = await runtime.requests.list();
  for (const request of pendingRequests) {
    if (request.operation?.runner === undefined || !requestRunnerIsAlive(request.operation.runner)) continue;
    for (const owner of requestParticipants(runtime, request)) busyOwners.add(owner);
  }
  for (const request of pendingRequests) {
    if (request.status === 'work-running') {
      try {
        await processRequest(runtime, request.id, log.request);
      } catch (error) {
        log.error(request.id, error);
      }
      continue;
    }
    if (!requestCanRun(request) && !canReconcileRequest(request)) continue;
    const owners = requestParticipants(runtime, request);
    if ([...owners].some(owner => requestOwners.has(owner) || busyOwners.has(owner))) continue;
    requests.start(request.id, async () => {
      for (const owner of owners) requestOwners.add(owner);
      try {
        if (canReconcileRequest(request)) {
          const reconciled = await reconcileRequest(runtime, request.id);
          if (reconciled.status !== request.status) log.request(reconciled);
        }
        await processRequest(runtime, request.id, log.request);
      } catch (error) {
        log.error(request.id, error);
      } finally {
        for (const owner of owners) requestOwners.delete(owner);
      }
    });
  }
}

async function reservedRequestOwners(runtime: Runtime) {
  const reserved = new Set(requestOwners);
  for (const request of await runtime.requests.list()) {
    if (!request.operation?.runner || !requestRunnerIsAlive(request.operation.runner)) continue;
    for (const owner of requestParticipants(runtime, request)) reserved.add(owner);
  }
  return reserved;
}

/**
 * One pass: configuration, merged or closed PRs, requests (people may be waiting on an instance), initiatives, due
 * duties, work items, notices. PR states come first so everything after reacts to a merge on the same tick.
 */
export async function tick(runtime: Runtime, log: TickLog) {
  const stranded = await runtime.ledger.markInterrupted();
  if (stranded) log.error('recovery', new Error(`${stranded} work items lost their runner and await a person`));
  try {
    await runtime.reloadDeclarations();
  } catch (error) {
    log.error('configuration (keeping the last good one)', error);
  }
  try {
    const { unreadable } = await refreshPublications(runtime);
    if (unreadable.length) log.error('publications', new Error(`pr_state_unreadable: ${unreadable.join(', ')}`));
  } catch (error) {
    log.error('publications', error);
  }
  try {
    await runtime.requests.markInterrupted();
    await runRequests(runtime, log);
  } catch (error) {
    log.error('requests', error);
  }
  try {
    await superviseInitiatives(runtime, { onError: log.error });
  } catch (error) {
    log.error('initiatives', error);
  }
  let reserved: ReadonlySet<string>;
  try {
    reserved = await reservedRequestOwners(runtime);
  } catch (error) {
    log.error('request reservations', error);
    return; // Retry next tick when the owner reservations can be read safely.
  }
  await runDueDuties(runtime, log, reserved);
  const runnable = (await runtime.ledger.list()).filter(isRunnable);
  advanceRunnable(runnable, runtime, log, reserved);
  await scheduleMemory(runtime, log, reserved);
  try {
    for (const notice of await noticeWorkChanges(runtime, ownerId => chatDirectory(runtime, ownerId))) log.duty(notice.owner, 'notice', `${notice.workItem} ${notice.change}${notice.origin ? ' (to its chat)' : ''}`);
  } catch (error) {
    log.error('notices', error);
  }
}

/** Always on: tick forever. Work cut off by a stop is marked interrupted at the next start, never replayed. */
export async function daemon(runtime: Runtime, log: TickLog, signal: AbortSignal) {
  const stranded = await runtime.ledger.markInterrupted();
  if (stranded) log.error('startup', new Error(`${stranded} work items were interrupted by the last stop`));
  const retired = await retirePipelineItems(runtime);
  if (retired.length) log.error('startup', new Error(`pipeline_removed: ${retired.join(', ')} failed; plan them again if they are still wanted`));
  while (!signal.aborted) {
    await tick(runtime, log);
    await sleep(DAEMON_LIMITS.tickMs, undefined, { signal }).catch(() => {});
  }
}
