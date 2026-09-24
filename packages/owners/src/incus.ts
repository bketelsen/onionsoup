import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { IncusOwner, IncusPermission } from './declarations.ts';

const run = promisify(execFile);

export const INCUS_LIMITS = { commandTimeoutMs: 60_000, launchTimeoutMs: 5 * 60_000 };

/** The only way onionsoup talks to incus. Owners never get the CLI: it can delete things. */
export interface IncusClient {
  run(args: readonly string[], timeoutMs?: number): Promise<string>;
}

export const cliIncus: IncusClient = {
  async run(args, timeoutMs = INCUS_LIMITS.commandTimeoutMs) {
    const pending = run('incus', [...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    // `incus launch` reads instance config YAML from stdin when it is not a terminal; an open pipe
    // makes it wait forever without ever contacting the server. Close stdin on every call.
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout;
  },
};

const RawInstance = z.object({
  name: z.string(),
  type: z.string(),
  status: z.string(),
  project: z.string().optional(),
  created_at: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
  snapshots: z.array(z.object({ name: z.string(), created_at: z.string().optional() })).nullable().optional(),
}).loose();

export interface InstanceFact {
  name: string;
  type: string;
  status: string;
  project: string;
  image: string;
  createdAt: string;
  snapshots: number;
  newestSnapshot: string | null;
  managedByOnionsoup: boolean;
}

export interface RemoteSnapshot {
  remote: string;
  host: string;
  allow: IncusPermission[];
  status: 'collected' | 'unavailable';
  failure?: string;
  instances: InstanceFact[];
  storage: unknown;
}

function toFact(raw: z.infer<typeof RawInstance>, managed: ReadonlySet<string>, remote: string): InstanceFact {
  const snapshots = raw.snapshots ?? [];
  const newest = snapshots.map(snapshot => snapshot.created_at ?? '').sort().at(-1) || null;
  return {
    name: raw.name,
    type: raw.type,
    status: raw.status,
    project: raw.project ?? 'default',
    image: raw.config?.['image.description'] ?? 'unknown',
    createdAt: raw.created_at ?? 'unknown',
    snapshots: snapshots.length,
    newestSnapshot: newest,
    managedByOnionsoup: managed.has(`${remote}:${raw.name}`),
  };
}

async function observeRemote(client: IncusClient, remote: IncusOwner['domain']['remotes'][number], managed: ReadonlySet<string>): Promise<RemoteSnapshot> {
  const base = { remote: remote.name, host: remote.host, allow: remote.allow };
  try {
    const instances = z.array(RawInstance).parse(JSON.parse(await client.run(['list', `${remote.name}:`, '--all-projects', '--format', 'json'])));
    const storage = JSON.parse(await client.run(['storage', 'list', `${remote.name}:`, '--format', 'json'])) as unknown;
    return { ...base, status: 'collected', instances: instances.map(raw => toFact(raw, managed, remote.name)), storage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = /not found|no such remote|remote .* doesn't exist/i.test(message) ? `remote_not_configured: ${remote.name}` : message.split('\n')[0]!.slice(0, 300);
    return { ...base, status: 'unavailable', failure, instances: [], storage: null };
  }
}

function snapshotMarkdown(takenAt: string, remotes: readonly RemoteSnapshot[], owner: IncusOwner) {
  const lines = [`# Incus snapshot`, '', `Taken ${takenAt} by host code (read-only). Files next to this one hold the raw JSON.`, ''];
  for (const remote of remotes) {
    lines.push(`## ${remote.remote} (${remote.host}) — allowed: ${remote.allow.join(', ')}`, '');
    if (remote.status === 'unavailable') {
      lines.push(`Unavailable: ${remote.failure}`, '');
      continue;
    }
    lines.push('| instance | type | status | image | snapshots | newest snapshot | onionsoup-managed |', '|---|---|---|---|---|---|---|');
    for (const fact of remote.instances) {
      lines.push(`| ${fact.name} | ${fact.type} | ${fact.status} | ${fact.image} | ${fact.snapshots} | ${fact.newestSnapshot ?? '-'} | ${fact.managedByOnionsoup ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }
  lines.push(`Create policy: images ${owner.domain.images.join(', ')}; prefix \`${owner.domain.namePrefix}\`; at most ${owner.domain.maxManagedInstances} managed instances.`);
  return lines.join('\n') + '\n';
}

/** Refresh an incus owner's evidence workspace. Returns a short label for the survey brief. */
export async function refreshIncusEvidence(client: IncusClient, owner: IncusOwner, managed: ManagedInstances) {
  const managedKeys = new Set((await managed.list(owner.id)).map(entry => `${entry.remote}:${entry.name}`));
  const takenAt = new Date().toISOString();
  const remotes = await Promise.all(owner.domain.remotes.filter(remote => remote.allow.includes('observe')).map(remote => observeRemote(client, remote, managedKeys)));
  await mkdir(owner.workspace, { recursive: true });
  for (const remote of remotes) await writeFile(join(owner.workspace, `${remote.remote}.json`), JSON.stringify(remote, null, 2) + '\n');
  await writeFile(join(owner.workspace, 'SNAPSHOT.md'), snapshotMarkdown(takenAt, remotes, owner));
  return `snapshot ${takenAt}`;
}

export const ManagedInstance = z.object({
  remote: z.string(),
  name: z.string(),
  image: z.string(),
  requestId: z.string(),
  requestedBy: z.string(),
  createdAt: z.string(),
});
export type ManagedInstance = z.infer<typeof ManagedInstance>;

/** Instances onionsoup created. An owner may only ever delete what is in here. */
export class ManagedInstances {
  constructor(readonly directory: string) {}

  async list(ownerId: string) {
    const text = await readFile(this.path(ownerId), 'utf8').catch(() => '[]');
    return z.array(ManagedInstance).parse(JSON.parse(text));
  }

  async add(ownerId: string, entry: ManagedInstance) {
    const existing = (await this.list(ownerId)).filter(candidate => candidate.remote !== entry.remote || candidate.name !== entry.name);
    await this.write(ownerId, [...existing, entry]);
  }

  async remove(ownerId: string, remote: string, name: string) {
    await this.write(ownerId, (await this.list(ownerId)).filter(entry => !(entry.remote === remote && entry.name === name)));
  }

  private async write(ownerId: string, entries: ManagedInstance[]) {
    await mkdir(dirname(this.path(ownerId)), { recursive: true });
    const temporary = `${this.path(ownerId)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(entries, null, 2) + '\n');
    await rename(temporary, this.path(ownerId));
  }

  private path(ownerId: string) {
    return join(this.directory, `${ownerId}.json`);
  }
}

function requirePermission(owner: IncusOwner, remote: string, permission: IncusPermission) {
  const declared = owner.domain.remotes.find(candidate => candidate.name === remote);
  if (!declared) throw new Error(`remote_not_in_domain: ${remote}`);
  if (!declared.allow.includes(permission)) throw new Error(`remote_forbids_${permission}: ${remote}`);
}

export interface CreateSpec {
  remote: string;
  image: string;
  nameSuffix: string;
}

/** Everything a create must satisfy, checked before a person is ever asked. */
export async function checkCreate(owner: IncusOwner, managed: ManagedInstances, spec: CreateSpec) {
  requirePermission(owner, spec.remote, 'create');
  if (!owner.domain.images.includes(spec.image)) throw new Error(`image_not_allowed: ${spec.image}`);
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(spec.nameSuffix)) throw new Error(`bad_instance_name: ${spec.nameSuffix}`);
  if ((await managed.list(owner.id)).length >= owner.domain.maxManagedInstances) throw new Error('managed_instance_limit_reached');
  return `${owner.domain.namePrefix}${spec.nameSuffix}`;
}

/** Host code only, after a person approved it. */
export async function createInstance(client: IncusClient, owner: IncusOwner, managed: ManagedInstances, spec: CreateSpec, request: { id: string; requestedBy: string }) {
  const name = await checkCreate(owner, managed, spec);
  await client.run(['launch', spec.image, `${spec.remote}:${name}`, '-c', `user.onionsoup.request=${request.id}`], INCUS_LIMITS.launchTimeoutMs);
  await managed.add(owner.id, { remote: spec.remote, name, image: spec.image, requestId: request.id, requestedBy: request.requestedBy, createdAt: new Date().toISOString() });
  return { remote: spec.remote, name };
}

/** Host code only, after a person approved it; refuses anything onionsoup did not create. */
export async function deleteInstance(client: IncusClient, owner: IncusOwner, managed: ManagedInstances, remote: string, name: string) {
  requirePermission(owner, remote, 'delete');
  const isManaged = (await managed.list(owner.id)).some(entry => entry.remote === remote && entry.name === name);
  if (!isManaged || !name.startsWith(owner.domain.namePrefix)) throw new Error(`not_managed_by_onionsoup: ${remote}:${name}`);
  await client.run(['delete', '--force', `${remote}:${name}`], INCUS_LIMITS.launchTimeoutMs);
  await managed.remove(owner.id, remote, name);
}

/** Adopt only an instance tagged by this exact operation; name matches alone are not evidence. */
export async function reconcileInstance(client: IncusClient, owner: IncusOwner, managed: ManagedInstances,
  request: { id: string; from: string }, expected: { remote: string; name: string; image: string }) {
  const instances = z.array(RawInstance).parse(JSON.parse(await client.run(['list', `${expected.remote}:`, '--format', 'json'])));
  const found = instances.find(instance => instance.name === expected.name);
  if (!found || found.config?.['user.onionsoup.request'] !== request.id) return undefined;
  await managed.add(owner.id, { ...expected, requestId: request.id, requestedBy: request.from,
    createdAt: found.created_at ?? new Date().toISOString() });
  return { remote: expected.remote, name: expected.name };
}

export async function reconcileDeletion(client: IncusClient, owner: IncusOwner, managed: ManagedInstances,
  instance: { remote: string; name: string }) {
  const instances = z.array(RawInstance).parse(JSON.parse(await client.run(['list', `${instance.remote}:`, '--format', 'json'])));
  if (instances.some(candidate => candidate.name === instance.name)) return false;
  await managed.remove(owner.id, instance.remote, instance.name);
  return true;
}
