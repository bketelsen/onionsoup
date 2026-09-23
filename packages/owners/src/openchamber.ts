import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRepositoryOwner } from './declarations.ts';
import type { Runtime } from './runtime.ts';
import { ensureDesk } from './workspace.ts';

/**
 * Every persona owner gets a desk and an OpenChamber project for it, with the owner as the default agent,
 * so adding an owner needs no clicking. Only missing projects and missing fields are added: anything the
 * person set (a default model, a label, an icon) is left alone.
 */
export const OPENCHAMBER = {
  settingsPath: join(homedir(), '.config/openchamber/settings.json'),
  serverUrl: 'http://127.0.0.1:3000',
};

interface ProjectEntry { id: string; path: string; label?: string; icon?: string; color?: string; defaultAgent?: string; addedAt?: number; lastOpenedAt?: number; [key: string]: unknown }

export function projectId(path: string) {
  return `path_${Buffer.from(path).toString('base64url')}`;
}

/**
 * Where an owner's chats run: a repository owner's desk worktree (a group owner's folder of them), otherwise the
 * folder its read-only snapshot lives in. Creates it if needed.
 */
export async function chatDirectory(runtime: Runtime, ownerId: string) {
  const owner = runtime.owner(ownerId);
  for (const view of runtime.repositoryViews(owner.id)) if (owner.domain.kind === 'repository-group') await ensureDesk(view, runtime.desksRoot);
  const path = isRepositoryOwner(owner) ? (await ensureDesk(owner, runtime.desksRoot)).path
    : owner.domain.kind === 'repository-group' ? join(runtime.desksRoot, owner.id) : runtime.evidenceDirectory(owner.id);
  await mkdir(path, { recursive: true });
  return path;
}

async function desiredProjects(runtime: Runtime) {
  const desired: ProjectEntry[] = [];
  for (const declared of runtime.declarations.owners.values()) {
    if (!declared.persona) continue;
    const path = await chatDirectory(runtime, declared.id);
    desired.push({ id: projectId(path), path, label: declared.persona.name, icon: declared.persona.icon, color: declared.persona.color, defaultAgent: declared.persona.name });
  }
  return desired;
}

function merge(existing: ProjectEntry[], desired: ProjectEntry[]) {
  const now = Date.now();
  const changes: string[] = [];
  const projects = existing.map(entry => ({ ...entry }));
  for (const want of desired) {
    const current = projects.find(entry => entry.path === want.path);
    if (!current) {
      projects.push({ ...want, addedAt: now, lastOpenedAt: now });
      changes.push(`added ${want.label} (${want.path})`);
      continue;
    }
    for (const key of ['label', 'icon', 'color', 'defaultAgent'] as const) {
      if (current[key] === undefined && want[key] !== undefined) {
        current[key] = want[key];
        changes.push(`${want.label}: set ${key}`);
      }
    }
  }
  return { projects, changes };
}

/** Through the running server when there is one, so its clients see the change; otherwise the file, atomically. */
async function saveProjects(projects: ProjectEntry[]) {
  const running = await fetch(`${OPENCHAMBER.serverUrl}/api/config/settings`, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
  if (running) {
    const response = await fetch(`${OPENCHAMBER.serverUrl}/api/config/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects }) });
    if (!response.ok) throw new Error(`openchamber_settings_put_failed: HTTP ${response.status}`);
    return 'running server';
  }
  const settings = JSON.parse(await readFile(OPENCHAMBER.settingsPath, 'utf8').catch(() => '{}')) as Record<string, unknown>;
  await mkdir(dirname(OPENCHAMBER.settingsPath), { recursive: true });
  const temporary = `${OPENCHAMBER.settingsPath}.onionsoup.tmp`;
  await writeFile(temporary, JSON.stringify({ ...settings, projects }, null, 2) + '\n');
  await rename(temporary, OPENCHAMBER.settingsPath);
  return 'settings file';
}

async function currentProjects() {
  const fromServer = await fetch(`${OPENCHAMBER.serverUrl}/api/config/settings`, { signal: AbortSignal.timeout(2_000) })
    .then(async response => (response.ok ? ((await response.json()) as { projects?: ProjectEntry[] }).projects : undefined), () => undefined);
  if (fromServer) return fromServer;
  const settings = JSON.parse(await readFile(OPENCHAMBER.settingsPath, 'utf8').catch(() => '{}')) as { projects?: ProjectEntry[] };
  return settings.projects ?? [];
}

export async function syncOpenChamber(runtime: Runtime) {
  const { projects, changes } = merge(await currentProjects(), await desiredProjects(runtime));
  if (!changes.length) return { changes, via: 'nothing to do' };
  return { changes, via: await saveProjects(projects) };
}
