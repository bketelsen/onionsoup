import { createHash, randomUUID } from 'node:crypto';
import { runSshProcess, boundedSshArguments, type QueryResult } from '@onionsoup/runtime/ssh';
export type { QueryResult } from '@onionsoup/runtime/ssh';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
export const Engine = z.enum(['docker', 'podman', 'incus']);
export type Engine = z.infer<typeof Engine>;
export const ContainerTarget = z.object({ schemaVersion: z.literal(1), assetId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/), user: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/),
  port: z.number().int().min(1).max(65535).default(22), engines: z.array(Engine).min(1).max(3).default(['docker','podman','incus'])
    .refine(value => new Set(value).size === value.length, 'Duplicate engines'),
}).strict();
export type ContainerTarget = z.infer<typeof ContainerTarget>;
export const COMMANDS: Readonly<Record<Engine, string>> = Object.freeze({
  docker: "test -x /usr/bin/docker || exit 69; exec /usr/bin/env -u DOCKER_CONTEXT -u DOCKER_HOST -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH LC_ALL=C /usr/bin/docker --host unix:///var/run/docker.sock ps --all --format '{{json .State}}'",
  podman: "test -x /usr/bin/podman || exit 69; exec /usr/bin/env -u CONTAINER_HOST -u CONTAINER_CONNECTION LC_ALL=C /usr/bin/podman --remote=false ps --all --format '{{json .State}}'",
  incus: "test -x /usr/bin/incus || exit 69; exec /usr/bin/env -u INCUS_SOCKET -u INCUS_REMOTE LC_ALL=C /usr/bin/incus --force-local list --all-projects --format csv --columns s",
});
export const SCOPES = { docker: 'local-default-docker-socket', podman: 'ssh-user-local-podman', incus: 'local-incus-daemon-all-visible-projects' } as const;
export function sshArguments(raw: unknown, engine: Engine) {
  const target = ContainerTarget.parse(raw); Engine.parse(engine);
  if (!target.engines.includes(engine)) throw new Error('Engine not selected');
  return boundedSshArguments(target, COMMANDS[engine]);
}
const State = z.enum(['created','running','restarting','removing','paused','exited','dead','configured','stopped',
  'frozen','freezing','thawed','starting','stopping','aborting','error','ready','unknown']);
const Counts = z.object({ total: z.number().int().min(0).max(5000), states: z.array(z.object({ state: State,
  count: z.number().int().min(1).max(5000) }).strict()).max(State.options.length) }).strict().refine(value =>
  new Set(value.states.map(row => row.state)).size === value.states.length && value.states.reduce((sum,row) => sum + row.count, 0) === value.total,
  'State counts must partition total');
export function normalizeContainerStates(engine: Engine, stdout: string) {
  Engine.parse(engine);
  if (Buffer.byteLength(stdout) > 256 * 1024) throw new Error('Output limit');
  const trimmed = stdout.trim();
  if (!trimmed) return Counts.parse({ total: 0, states: [] });
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 5000 || lines.some(line => !line.trim())) throw new Error('Invalid rows');
  const counts = new Map<z.infer<typeof State>, number>();
  for (const line of lines) {
    // Only a single state column is requested. Arbitrary strings never leave normalization.
    const raw = engine === 'incus' ? line.trim() : JSON.parse(line);
    if (typeof raw !== 'string' || !/^[a-zA-Z_-]{1,40}$/.test(raw)) throw new Error('Invalid state');
    const parsed = State.safeParse(raw.toLowerCase()), state = parsed.success ? parsed.data : 'unknown';
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return Counts.parse({ total: lines.length, states: [...counts].sort(([a],[b]) => a.localeCompare(b)).map(([state,count]) => ({ state,count })) });
}
const Failure = z.enum(['cli_unavailable','ssh_failed','query_failed','timeout','cancelled','output_limit','invalid_output','not_started']);
export type InventoryTransport = (target: ContainerTarget, engine: Engine, signal: AbortSignal) => Promise<QueryResult>;
// Client-side bounds do not turn the existing SSH identity into a server-side read-only account.
export const queryOverSsh: InventoryTransport = (target, engine, signal) => runSshProcess(sshArguments(target, engine), signal);
const Query = z.object({ engine: Engine, scope: z.enum(Object.values(SCOPES)), commandHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending','running','collected','unavailable','failed','not_attempted']), startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(), failure: Failure.optional(), counts: Counts.optional() }).strict();
export const ContainerRun = z.object({ schemaVersion: z.literal(1), kind: z.literal('container-inventory'), runId: z.uuid(),
  assetId: ContainerTarget.shape.assetId, targetHash: z.string().regex(/^[a-f0-9]{64}$/), commandVersion: z.literal('ssh-container-states-v1'),
  readOnlyCommands: z.literal(true), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['running','completed','partial','failed']), queries: z.array(Query).min(1).max(3),
}).strict();
export type ContainerRun = z.infer<typeof ContainerRun>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function collectContainerInventory(raw: unknown, options: { directory: string; signal?: AbortSignal; transport?: InventoryTransport }) {
  const target = ContainerTarget.parse(raw);
  const record: ContainerRun = { schemaVersion: 1, kind: 'container-inventory', runId: randomUUID(), assetId: target.assetId,
    targetHash: hash(JSON.stringify(target)), commandVersion: 'ssh-container-states-v1', readOnlyCommands: true,
    startedAt: new Date().toISOString(), status: 'running', queries: target.engines.map(engine => ({ engine, scope: SCOPES[engine],
      commandHash: hash(COMMANDS[engine]), status: 'pending' })) };
  await mkdir(options.directory, { mode: 0o700 });
  const save = () => atomicJson(join(options.directory, 'observation.json'), ContainerRun.parse(record));
  await save();
  const deadline = AbortSignal.timeout(65000), signal = AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]);
  for (const query of record.queries) {
    if (signal.aborted) { query.status = 'not_attempted'; query.failure = deadline.aborted ? 'timeout' : 'cancelled'; await save(); continue; }
    query.startedAt = new Date().toISOString(); query.status = 'running'; await save();
    let failure: 'query_failed'|'invalid_output' = 'query_failed';
    try {
      const result = await (options.transport ?? queryOverSsh)(target, query.engine, signal);
      if (result.failure || signal.aborted) { query.status = 'failed'; query.failure = deadline.aborted ? 'timeout' : signal.aborted ? 'cancelled' : result.failure; }
      else if (result.code === 69) { query.status = 'unavailable'; query.failure = 'cli_unavailable'; }
      else if (result.code !== 0) { query.status = 'failed'; query.failure = result.code === 255 ? 'ssh_failed' : 'query_failed'; }
      else { failure = 'invalid_output'; query.counts = normalizeContainerStates(query.engine, result.stdout); query.status = 'collected'; }
    } catch { query.status = 'failed'; query.failure = failure; }
    query.finishedAt = new Date().toISOString(); await save();
  }
  const collected = record.queries.filter(query => query.status === 'collected').length;
  record.status = collected === record.queries.length ? 'completed' : collected > 0 ? 'partial' : 'failed';
  record.finishedAt = new Date().toISOString(); await save(); return record;
}
