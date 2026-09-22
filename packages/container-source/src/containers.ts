import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
import { boundedSshArguments, runSshProcess, type QueryResult } from '@onionsoup/runtime/ssh';
import { ContainerTarget, Engine, SCOPES } from './index.ts';

/** Fixed, read-only listing commands. One JSON document per container; nothing else is ever run. */
export const CONTAINER_COMMANDS: Readonly<Record<Engine, string>> = Object.freeze({
  docker: "test -x /usr/bin/docker || exit 69; exec /usr/bin/env -u DOCKER_CONTEXT -u DOCKER_HOST -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH LC_ALL=C /usr/bin/docker --host unix:///var/run/docker.sock ps --all --no-trunc --format '{{json .}}'",
  podman: "test -x /usr/bin/podman || exit 69; exec /usr/bin/env -u CONTAINER_HOST -u CONTAINER_CONNECTION LC_ALL=C /usr/bin/podman --remote=false ps --all --format json",
  incus: "test -x /usr/bin/incus || exit 69; exec /usr/bin/env -u INCUS_SOCKET -u INCUS_REMOTE LC_ALL=C /usr/bin/incus --force-local list --all-projects --format json",
});
export const CONTAINERS_COMMAND_VERSION = 'ssh-containers-v1';
export const CONTAINER_LIMITS = { outputBytes: 4 * 1024 * 1024, facts: 150, selected: 15, textChars: 200 } as const;

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ContainerId = z.string().regex(/^r-[a-f0-9]{64}$/);
const State = z.enum(['created', 'running', 'restarting', 'removing', 'paused', 'exited', 'dead', 'stopped', 'frozen', 'error', 'unknown']);
export type ContainerState = z.infer<typeof State>;
const Time = z.iso.datetime().nullable();

/** What the model may see about one container or instance. Names stay in the private lookup. */
export const ContainerFact = z.object({
  id: ContainerId,
  engine: Engine,
  kind: z.enum(['container', 'instance']),
  state: State,
  statusText: z.string().max(CONTAINER_LIMITS.textChars),
  exitCode: z.number().int().nullable(),
  restarts: z.number().int().min(0).nullable(),
  unhealthy: z.boolean().nullable(),
  createdAt: Time,
  startedAt: Time,
  image: z.string().max(CONTAINER_LIMITS.textChars).nullable(),
}).strict();
export type ContainerFact = z.infer<typeof ContainerFact>;
export type ContainerName = { engine: Engine; name: string; project?: string };

const Query = z.object({
  engine: Engine, scope: z.enum(Object.values(SCOPES) as [string, ...string[]]), commandHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'running', 'collected', 'unavailable', 'failed', 'not_attempted']),
  failure: z.enum(['cli_unavailable', 'ssh_failed', 'query_failed', 'timeout', 'cancelled', 'output_limit', 'invalid_output', 'not_started']).optional(),
  startedAt: z.iso.datetime().optional(), finishedAt: z.iso.datetime().optional(), total: z.number().int().min(0).optional(),
}).strict();

export const ContainersObservation = z.object({
  schemaVersion: z.literal(1), kind: z.literal('container-observation'), runId: z.uuid(),
  assetId: ContainerTarget.shape.assetId, targetHash: z.string().regex(/^[a-f0-9]{64}$/), commandVersion: z.literal(CONTAINERS_COMMAND_VERSION),
  readOnlyCommands: z.literal(true), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['running', 'completed', 'partial', 'failed']), queries: z.array(Query).min(1).max(3),
  /** Candidates for assessment among the facts, and how many were left out by the cap. Null until something was collected. */
  eligible: z.number().int().min(0).nullable(), omitted: z.number().int().min(0).nullable(), selected: z.array(ContainerId).max(CONTAINER_LIMITS.selected),
  facts: z.array(ContainerFact).max(CONTAINER_LIMITS.facts),
}).strict().superRefine((r, ctx) => {
  const ids = r.facts.map((f) => f.id);
  if (new Set(ids).size !== ids.length || r.selected.some((id) => !ids.includes(id))) ctx.addIssue({ code: 'custom', message: 'Selected containers must be unique supplied facts' });
  if ((r.eligible === null) !== (r.omitted === null) || (r.eligible !== null && r.eligible !== r.selected.length + r.omitted!)) ctx.addIssue({ code: 'custom', message: 'Eligibility counts must partition' });
});
export type ContainersObservation = z.infer<typeof ContainersObservation>;

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, CONTAINER_LIMITS.textChars) : '');
const time = (value: unknown): string | null => {
  if (typeof value === 'number' && value > 0) return new Date(value * 1000).toISOString();
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value) || Date.parse(value.replace(/ ([+-]\d{4}) \w+$/, '$1').replace(' ', 'T'));
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
};
const state = (value: unknown): ContainerState => {
  const parsed = State.safeParse(typeof value === 'string' ? value.toLowerCase() : '');
  return parsed.success ? parsed.data : 'unknown';
};
const health = (status: string): boolean | null => (/\(unhealthy\)/i.test(status) ? true : /\(healthy\)/i.test(status) ? false : null);
const exitFrom = (status: string): number | null => { const match = /Exited \((\d+)\)/.exec(status); return match ? Number(match[1]) : null; };

type Parsed = { fact: ContainerFact; name: ContainerName };
const parsers: Record<Engine, (stdout: string) => Parsed[]> = {
  docker: (stdout) => stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const row = JSON.parse(line) as Record<string, unknown>;
    const name = text(row.Names).split(',')[0] || text(row.ID);
    const status = text(row.Status);
    return { fact: { id: 'r-' + digest(['docker', name]), engine: 'docker', kind: 'container', state: state(row.State), statusText: status, exitCode: exitFrom(status), restarts: null, unhealthy: health(status), createdAt: time(row.CreatedAt), startedAt: null, image: text(row.Image) || null }, name: { engine: 'docker', name } };
  }),
  podman: (stdout) => {
    const rows = stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
    return rows.map((row) => {
      const names = Array.isArray(row.Names) ? row.Names.map(text) : [text(row.Names)];
      const name = names[0] || text(row.Id);
      const status = text(row.Status);
      const exited = row.Exited === true;
      return { fact: { id: 'r-' + digest(['podman', name]), engine: 'podman', kind: 'container', state: state(row.State), statusText: status, exitCode: exited && typeof row.ExitCode === 'number' ? row.ExitCode : exitFrom(status), restarts: typeof row.Restarts === 'number' ? row.Restarts : null, unhealthy: health(status), createdAt: time(row.Created ?? row.CreatedAt), startedAt: time(row.StartedAt), image: text(row.Image) || null }, name: { engine: 'podman', name } };
    });
  },
  incus: (stdout) => {
    const rows = stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
    return rows.map((row) => {
      const name = text(row.name), project = text(row.project) || 'default';
      const status = text(row.status);
      return { fact: { id: 'r-' + digest(['incus', project, name]), engine: 'incus', kind: 'instance', state: state(status), statusText: `${text(row.type) || 'instance'} ${status}`.trim(), exitCode: null, restarts: null, unhealthy: null, createdAt: time(row.created_at), startedAt: null, image: null }, name: { engine: 'incus', name, project } };
    });
  },
};

export function parseContainers(engine: Engine, stdout: string): Parsed[] {
  Engine.parse(engine);
  if (Buffer.byteLength(stdout) > CONTAINER_LIMITS.outputBytes) throw new Error('Output limit');
  return parsers[engine](stdout).map((row) => ({ fact: ContainerFact.parse(row.fact), name: row.name }));
}

/** Which containers deserve a look: crashed, restarting, unhealthy, or running with restarts. Stopped instances are normal. */
export function needsAttention(fact: ContainerFact) {
  return fact.unhealthy === true || fact.state === 'restarting' || fact.state === 'dead' || fact.state === 'error'
    || (fact.state === 'exited' && fact.exitCode !== null && fact.exitCode !== 0) || (fact.state === 'running' && (fact.restarts ?? 0) > 0);
}
const priority = (fact: ContainerFact) => (fact.unhealthy === true || fact.state === 'restarting' || fact.state === 'error' ? 0 : fact.state === 'exited' || fact.state === 'dead' ? 1 : 2);

export function selectContainerFacts(facts: ContainerFact[]) {
  const candidates = facts.filter(needsAttention).sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id));
  const selected = candidates.slice(0, CONTAINER_LIMITS.selected).map((f) => f.id);
  const others = facts.filter((f) => !selected.includes(f.id)).sort((a, b) => a.id.localeCompare(b.id));
  const retained = [...candidates.slice(0, CONTAINER_LIMITS.selected), ...others].slice(0, CONTAINER_LIMITS.facts);
  return { eligible: candidates.length, omitted: candidates.length - selected.length, selected, facts: retained };
}

export type ContainerTransport = (target: ContainerTarget, engine: Engine, signal: AbortSignal) => Promise<QueryResult>;
const overSsh: ContainerTransport = (target, engine, signal) => runSshProcess(boundedSshArguments(target, CONTAINER_COMMANDS[engine]), signal);

/** Collect per-container facts from every selected engine over SSH. Names go to `containers.private.json`, never into the observation. */
export async function collectContainers(raw: unknown, options: { directory: string; signal?: AbortSignal; transport?: ContainerTransport }) {
  const target = ContainerTarget.parse(raw);
  const record: ContainersObservation = {
    schemaVersion: 1, kind: 'container-observation', runId: randomUUID(), assetId: target.assetId, targetHash: digest(target), commandVersion: CONTAINERS_COMMAND_VERSION,
    readOnlyCommands: true, startedAt: new Date().toISOString(), status: 'running',
    queries: target.engines.map((engine) => ({ engine, scope: SCOPES[engine], commandHash: digest(CONTAINER_COMMANDS[engine]), status: 'pending' })),
    eligible: null, omitted: null, selected: [], facts: [],
  };
  await mkdir(options.directory, { mode: 0o700 });
  const save = () => atomicJson(join(options.directory, 'observation.json'), ContainersObservation.parse(record));
  await save();
  const deadline = AbortSignal.timeout(90000);
  const signal = AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]);
  const facts: ContainerFact[] = [];
  const names: Record<string, ContainerName> = {};
  for (const query of record.queries) {
    if (signal.aborted) { query.status = 'not_attempted'; query.failure = deadline.aborted ? 'timeout' : 'cancelled'; await save(); continue; }
    query.startedAt = new Date().toISOString();
    query.status = 'running';
    await save();
    let failure: 'query_failed' | 'invalid_output' = 'query_failed';
    try {
      const result = await (options.transport ?? overSsh)(target, query.engine, signal);
      if (result.failure || signal.aborted) { query.status = 'failed'; query.failure = deadline.aborted ? 'timeout' : signal.aborted ? 'cancelled' : result.failure; }
      else if (result.code === 69) { query.status = 'unavailable'; query.failure = 'cli_unavailable'; }
      else if (result.code !== 0) { query.status = 'failed'; query.failure = result.code === 255 ? 'ssh_failed' : 'query_failed'; }
      else {
        failure = 'invalid_output';
        const parsed = parseContainers(query.engine, result.stdout);
        for (const row of parsed) { facts.push(row.fact); names[row.fact.id] = row.name; }
        query.total = parsed.length;
        query.status = 'collected';
      }
    } catch { query.status = 'failed'; query.failure = failure; }
    query.finishedAt = new Date().toISOString();
    await save();
  }
  const collected = record.queries.filter((q) => q.status === 'collected').length;
  if (collected) Object.assign(record, selectContainerFacts(facts));
  record.status = collected === record.queries.length ? 'completed' : collected ? 'partial' : 'failed';
  record.finishedAt = new Date().toISOString();
  await atomicJson(join(options.directory, 'containers.private.json'), Object.fromEntries(record.facts.map((f) => [f.id, names[f.id]])));
  await save();
  return record;
}
