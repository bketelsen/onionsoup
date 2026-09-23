import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { processRequests } from './brokering.ts';
import { syncOpenChamber } from './openchamber.ts';
import type { WorkItem, WorkStatus } from './ledger.ts';
import { wake } from './owner.ts';
import type { ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { advance } from './workflow.ts';

export const DAEMON_LIMITS = { tickMs: 60_000, shutdownGraceMs: 5_000 };

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function everyMs(every: string) {
  const unit = every.at(-1)!;
  return Number(every.slice(0, -1)) * UNIT_MS[unit]!;
}

/** Statuses the runtime moves on its own; everything else waits for a person or is finished. */
const RUNNABLE: readonly WorkStatus[] = ['proposed', 'planning', 'implementing', 'reviewing', 'landing'];

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

async function runDueDuties(runtime: Runtime, log: TickLog) {
  const statePath = join(runtime.stateDirectory, 'duties.json');
  const lastRun = await readDutyState(statePath);
  for (const owner of runtime.declarations.owners.values()) {
    for (const duty of owner.duties.filter(candidate => candidate.every)) {
      const key = `${owner.id}/${duty.id}`;
      const previous = lastRun[key] ? Date.parse(lastRun[key]) : 0;
      if (Date.now() - previous < everyMs(duty.every!)) continue;
      lastRun[key] = new Date().toISOString();
      await writeFile(statePath, JSON.stringify(lastRun, null, 2) + '\n');
      try {
        const result = await wake(runtime, owner.id, duty.id);
        log.duty(owner.id, duty.id, result.survey.summary);
      } catch (error) {
        log.error(key, error);
      }
    }
  }
}

async function advanceRunnable(runtime: Runtime, log: TickLog) {
  for (const item of (await runtime.ledger.list()).filter(candidate => RUNNABLE.includes(candidate.status))) {
    try {
      await advance(runtime, item.id, log.item);
    } catch (error) {
      log.error(item.id, error);
    }
  }
}

/** One pass: owners' OpenChamber projects, requests (people may be waiting on an instance), due duties, work items. */
export async function tick(runtime: Runtime, log: TickLog) {
  try {
    await runtime.reloadDeclarations();
  } catch (error) {
    log.error('configuration (keeping the last good one)', error);
  }
  try {
    const { changes } = await syncOpenChamber(runtime);
    for (const change of changes) log.duty('openchamber', 'sync', change);
  } catch (error) {
    log.error('openchamber', error);
  }
  try {
    await processRequests(runtime, log.request);
  } catch (error) {
    log.error('requests', error);
  }
  await runDueDuties(runtime, log);
  await advanceRunnable(runtime, log);
}

/** Always on: tick forever. Work cut off by a stop is marked interrupted at the next start, never replayed. */
export async function daemon(runtime: Runtime, log: TickLog, signal: AbortSignal) {
  const stranded = await runtime.ledger.markInterrupted();
  if (stranded) log.error('startup', new Error(`${stranded} work items were interrupted by the last stop`));
  while (!signal.aborted) {
    await tick(runtime, log);
    await sleep(DAEMON_LIMITS.tickMs, undefined, { signal }).catch(() => {});
  }
}
