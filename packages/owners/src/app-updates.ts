import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Duty } from './declarations.ts';
import type { ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { withTruenas } from './truenas.ts';

/**
 * App updates on the NAS. Detection is deterministic and needs no model; a model (the owner) is woken only
 * when updates exist, to read release notes and decide update or hold. Every "update" becomes an update-app
 * request that a standing grant or a person approves, and host code performs it through the TrueNAS API.
 * A hold is remembered for that target version, so the owner is not re-asked about the same release daily.
 */
export const APP_UPDATE_LIMITS = { holdDays: 7, updateWaitMs: 15 * 60_000, pollMs: 10_000 };

interface AppUpdate { name: string; state: string; version: string; latestVersion: string; humanVersion: string; imageUpdates: boolean }

const RawApp = z.object({
  name: z.string(),
  state: z.string().optional(),
  version: z.string().optional(),
  latest_version: z.string().nullable().optional(),
  human_version: z.string().optional(),
  upgrade_available: z.boolean().optional(),
  image_updates_available: z.boolean().optional(),
}).loose();

function appsIn(report: string): AppUpdate[] {
  const parsed = JSON.parse(report) as unknown;
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>).find(Array.isArray) ?? [];
  return (list as unknown[]).map(entry => RawApp.safeParse(entry)).filter(result => result.success).map(result => result.data)
    .filter(app => app.upgrade_available || app.image_updates_available)
    .map(app => ({
      name: app.name, state: app.state ?? 'unknown', version: app.version ?? '?',
      latestVersion: app.latest_version ?? app.version ?? '?', humanVersion: app.human_version ?? '?', imageUpdates: Boolean(app.image_updates_available),
    }));
}

export const UpdateDecisions = z.object({
  apps: z.array(z.object({
    name: z.string(),
    decision: z.enum(['update', 'hold']),
    reason: z.string().describe('For hold: the blocker (breaking change, required migration, known regression). For update: why it is safe.'),
    notesRead: z.array(z.string()).describe('Release note URLs you actually read'),
  })),
});
export type UpdateDecisions = z.infer<typeof UpdateDecisions>;

interface Hold { version: string; reason: string; at: string }

async function readHolds(runtime: Runtime, ownerId: string): Promise<Record<string, Hold>> {
  return JSON.parse(await readFile(join(runtime.stateDirectory, `holds-${ownerId}.json`), 'utf8').catch(() => '{}')) as Record<string, Hold>;
}

async function writeHolds(runtime: Runtime, ownerId: string, holds: Record<string, Hold>) {
  await writeFile(join(runtime.stateDirectory, `holds-${ownerId}.json`), JSON.stringify(holds, null, 2) + '\n');
}

function isHeld(hold: Hold | undefined, app: AppUpdate) {
  if (!hold || hold.version !== app.latestVersion) return false;
  return Date.now() - Date.parse(hold.at) < APP_UPDATE_LIMITS.holdDays * 86_400_000;
}

function decisionBrief(duty: Duty, apps: readonly AppUpdate[], notebook: string) {
  const table = apps.map(app => `- ${app.name}: catalog ${app.version} → ${app.latestVersion} (app/chart ${app.humanVersion})${app.imageUpdates ? '; container image update' : ''}; state ${app.state}`).join('\n');
  return [
    `Duty: ${duty.id}. These TrueNAS apps have updates available:`,
    table,
    `<instructions>\n${duty.instructions}\n</instructions>`,
    `<notebook>\n${notebook}\n</notebook>`,
    `For each app, find and read the release notes between the installed and the latest version (the upstream project's
releases or changelog, and the TrueNAS catalog entry). Use truenas_app_get evidence in your notebook for the upstream
project if needed. Decide update or hold. Hold when notes mention breaking changes, manual migration steps, database or
config migrations you cannot confirm are automatic, removed features the app's configuration uses, or known regressions.
If you could not read any notes for an app, hold it and say so. List the URLs you actually read.`,
  ].join('\n\n');
}

/** The app-updates duty. Returns a summary; opens update-app requests for apps judged safe. */
export async function reviewAppUpdates(runtime: Runtime, ownerId: string, duty: Duty) {
  const owner = runtime.truenasOwner(ownerId);
  const report = await withTruenas(owner.domain, false, call => call('truenas_apps_update_report'));
  const open = new Set((await runtime.requests.list()).filter(request => request.ask.kind === 'update-app' && !['updated', 'failed', 'declined', 'denied'].includes(request.status)).map(request => (request.ask as { app: string }).app));
  const holds = await readHolds(runtime, ownerId);
  const candidates = appsIn(report).filter(app => !open.has(app.name) && !isHeld(holds[app.name], app));
  const notebook = runtime.notebook(ownerId);
  if (!candidates.length) {
    await notebook.journal({ kind: 'app-updates', note: 'no new updates to review (none available, held, or in flight)' });
    await notebook.commit('journal app-updates').catch(() => undefined);
    return { summary: 'no new app updates to review', opened: [] as ResourceRequest[] };
  }
  const brief = decisionBrief(duty, candidates, await notebook.orientation());
  const result = await runtime.hire(ownerId, { role: 'owner', model: owner.model, directory: owner.workspace, title: `${ownerId}: app updates`, brief, schema: UpdateDecisions, extraPermission: { webfetch: 'allow' } });
  const opened: ResourceRequest[] = [];
  for (const decision of result.value.apps) {
    const app = candidates.find(candidate => candidate.name === decision.name);
    if (!app) continue;
    if (decision.decision === 'hold') {
      holds[app.name] = { version: app.latestVersion, reason: decision.reason, at: new Date().toISOString() };
      await notebook.journal({ kind: 'app-held', note: `${app.name} ${app.version} → ${app.latestVersion}: ${decision.reason}`, outcome: decision.notesRead.join(' ') });
      continue;
    }
    const ask = { kind: 'update-app' as const, app: app.name, fromVersion: app.version, toVersion: app.latestVersion, purpose: decision.reason, notesRead: decision.notesRead };
    opened.push(await runtime.requests.open(ownerId, ownerId, ask, 'none'));
    await notebook.journal({ kind: 'app-update-proposed', note: `${app.name} ${app.version} → ${app.latestVersion}: ${decision.reason}`, outcome: decision.notesRead.join(' ') });
  }
  await writeHolds(runtime, ownerId, holds);
  await notebook.commit('journal app-updates').catch(() => undefined);
  const held = result.value.apps.filter(decision => decision.decision === 'hold').map(decision => decision.name);
  return { summary: `updates proposed: ${opened.map(request => (request.ask as { app: string }).app).join(', ') || 'none'}; held: ${held.join(', ') || 'none'}`, opened };
}

interface AppStatus { state?: string; version?: string; upgrade_available?: boolean }

/** truenas_app_get answers with a list holding the app. */
async function appStatus(runtime: Runtime, ownerId: string, app: string): Promise<AppStatus> {
  const owner = runtime.truenasOwner(ownerId);
  const text = await withTruenas(owner.domain, false, call => call('truenas_app_get', { name: app }));
  const parsed = JSON.parse(text) as AppStatus | AppStatus[];
  return (Array.isArray(parsed) ? parsed[0] : parsed) ?? {};
}

function describeStatus(status: AppStatus) {
  return `state ${status.state ?? '?'}, version ${status.version ?? '?'}`;
}

function isSettled(status: AppStatus, toVersion: string) {
  return status.state === 'RUNNING' && (status.version === toVersion || status.upgrade_available === false);
}

/**
 * Host code only, after approval: update through the TrueNAS API and wait until the app runs the new version.
 * Idempotent: an app already on the target version (a retry after a restart) is recorded, not updated again.
 */
export async function updateApp(runtime: Runtime, request: ResourceRequest) {
  if (request.ask.kind !== 'update-app') throw new Error('not_an_update_request');
  const { app, toVersion } = request.ask;
  const before = await appStatus(runtime, request.to, app);
  if (before.version === toVersion && before.upgrade_available === false && before.state === 'RUNNING') return `already on ${toVersion}; ${describeStatus(before)}`;
  if (before.version !== toVersion) {
    await withTruenas(runtime.truenasOwner(request.to).domain, true, call => call('truenas_app_update', { name: app }));
  }
  const deadline = Date.now() + APP_UPDATE_LIMITS.updateWaitMs;
  let last = describeStatus(before);
  while (Date.now() < deadline) {
    await sleep(APP_UPDATE_LIMITS.pollMs);
    const status = await appStatus(runtime, request.to, app).catch(() => ({} as AppStatus));
    last = describeStatus(status);
    if (isSettled(status, toVersion)) return last;
    if (status.state === 'CRASHED' || status.state === 'STOPPED') throw new Error(`app ${app} is ${status.state} after the update (${last})`);
  }
  throw new Error(`app ${app} did not settle on ${toVersion} (${last})`);
}
