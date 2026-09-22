import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Capability } from '@onionsoup/job-host';
import { atomicJson, optionalJson } from '@onionsoup/runtime/storage';
import { liveModel } from '@onionsoup/providers';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { TrueNasTarget, TrueNasRun, collectTrueNasHealth } from '@onionsoup/truenas-source';
import { ContainerTarget, Engine } from '@onionsoup/container-source';
import { collectContainers, ContainersObservation } from '@onionsoup/container-source/containers';
import { KubernetesTarget, KubernetesRun, collectKubernetes } from '@onionsoup/kubernetes-source';
import { investigateWorkloads, TriageRun, findingCounts as workloadCounts } from '@onionsoup/workload-triage';
import { investigateContainers, ContainerTriageRun, findingCounts as containerCounts } from '@onionsoup/container-triage';
import { composeHomelabBrief, renderHomelabBrief } from '@onionsoup/homelab-brief';

const SourceId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const Origin = z.enum(['config', 'registry']);

/** One thing the homelab side can observe. The target is exactly what the collector needs; nothing else is ever read. */
export const SourceEntry = z.discriminatedUnion('kind', [
  z.object({ sourceId: SourceId, kind: z.literal('truenas'), target: TrueNasTarget, origin: Origin, addedAt: z.iso.datetime().optional() }).strict(),
  z.object({ sourceId: SourceId, kind: z.literal('containers'), target: ContainerTarget, origin: Origin, addedAt: z.iso.datetime().optional() }).strict(),
  z.object({ sourceId: SourceId, kind: z.literal('kubernetes'), target: KubernetesTarget, origin: Origin, addedAt: z.iso.datetime().optional() }).strict(),
]);
export type SourceEntry = z.infer<typeof SourceEntry>;
export type SourceKind = SourceEntry['kind'];
const SourcesFile = z.object({ schemaVersion: z.literal(1), sources: z.array(SourceEntry).max(200) }).strict();

/** Host configuration for the homelab side. */
export const HomelabConfig = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(z.object({ sourceId: SourceId, kind: z.enum(['truenas', 'containers', 'kubernetes']), target: z.json() }).strict()).max(200).default([]),
  /** A file holding the TrueNAS API key, either raw or as an `export TRUENAS_API_KEY=...` line. Never copied into records. */
  truenasApiKeyFile: z.string().min(1).optional(),
  /** How old an observation may be before a brief calls it stale. */
  maxAgeSeconds: z.number().int().min(60).max(86400).default(3600),
}).strict();
export type HomelabConfig = z.infer<typeof HomelabConfig>;

export type HomelabRegistryOptions = { directory: string; entries: HomelabConfig['sources']; truenasApiKeyFile?: string; maxAgeSeconds?: number };

const Observation = z.union([TrueNasRun, ContainersObservation, KubernetesRun]);
export type HomelabObservationRecord = z.infer<typeof Observation>;
const Investigation = z.union([TriageRun, ContainerTriageRun, z.object({
  schemaVersion: z.literal(1), kind: z.literal('truenas-assessment'), runId: z.uuid(), assetId: SourceId, observedAt: z.iso.datetime(),
  classification: z.enum(['attention_now', 'ok', 'insufficient_evidence']), reasons: z.array(z.string().max(300)).max(12), observation: TrueNasRun,
}).strict()]);
export type HomelabInvestigation = z.infer<typeof Investigation>;

export class HomelabRegistry {
  private readonly entries = new Map<string, SourceEntry>();
  private constructor(readonly options: HomelabRegistryOptions) {}

  /** A registry that only knows configured sources and keeps no latest observations on disk. */
  static fixed(options: HomelabRegistryOptions) {
    const registry = new HomelabRegistry(options);
    for (const entry of options.entries) registry.entries.set(entry.sourceId, SourceEntry.parse({ ...entry, origin: 'config' }));
    return registry;
  }

  static async open(options: HomelabRegistryOptions) {
    const registry = new HomelabRegistry(options);
    await mkdir(join(options.directory, 'latest'), { recursive: true, mode: 0o700 });
    for (const entry of options.entries) registry.entries.set(entry.sourceId, SourceEntry.parse({ ...entry, origin: 'config' }));
    const saved = await optionalJson(registry.file);
    if (saved !== undefined) for (const entry of SourcesFile.parse(saved).sources) if (!registry.entries.has(entry.sourceId)) registry.entries.set(entry.sourceId, entry);
    return registry;
  }
  private get file() { return join(this.options.directory, 'sources.json'); }
  list() { return [...this.entries.values()]; }
  names() { return [...this.entries.keys()]; }
  get(sourceId: string) { return this.entries.get(sourceId); }
  schema() {
    const names = this.names();
    return names.length ? z.enum(names as [string, ...string[]]) : SourceId.refine(() => false, 'No homelab sources are registered');
  }
  async save(entry: SourceEntry) {
    if (this.entries.get(entry.sourceId)?.origin === 'config') throw new Error('source_fixed_by_config');
    this.entries.set(entry.sourceId, SourceEntry.parse({ ...entry, origin: 'registry' }));
    await atomicJson(this.file, SourcesFile.parse({ schemaVersion: 1, sources: this.list().filter((e) => e.origin === 'registry') }));
    return this.entries.get(entry.sourceId)!;
  }
  private latestPath(sourceId: string, kind: 'observation' | 'investigation') { return join(this.options.directory, 'latest', `${sourceId}.${kind}.json`); }
  async recordLatest(sourceId: string, kind: 'observation' | 'investigation', record: unknown) { if (this.options.directory) await atomicJson(this.latestPath(sourceId, kind), record); }
  async latestObservation(sourceId: string): Promise<HomelabObservationRecord | undefined> {
    if (!this.options.directory) return undefined;
    const raw = await optionalJson(this.latestPath(sourceId, 'observation'));
    return raw === undefined ? undefined : Observation.parse(raw);
  }
  async latestInvestigation(sourceId: string): Promise<HomelabInvestigation | undefined> {
    if (!this.options.directory) return undefined;
    const raw = await optionalJson(this.latestPath(sourceId, 'investigation'));
    return raw === undefined ? undefined : Investigation.parse(raw);
  }
  /** The TrueNAS key from the configured file, or the environment; never stored. */
  async truenasApiKey() {
    if (this.options.truenasApiKeyFile) {
      const text = await readFile(this.options.truenasApiKeyFile, 'utf8');
      const match = /TRUENAS_API_KEY\s*=\s*["']?([^"'\s]+)["']?/.exec(text);
      return (match ? match[1] : text.trim()) || undefined;
    }
    return process.env.TRUENAS_API_KEY || undefined;
  }
}

/** Fields a person supplies to register or change a source; the host builds the exact target from them. */
const SourceFields = z.object({
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/).optional(),
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  engines: z.array(Engine).min(1).max(3).optional(),
  access: z.enum(['direct', 'sudo']).optional(),
  /** TrueNAS only: absolute path of the truenas-mcp binary on this host. */
  binary: z.string().min(1).optional(),
  tlsInsecure: z.boolean().optional(),
}).strict();

function buildTarget(kind: SourceKind, sourceId: string, fields: z.infer<typeof SourceFields>, previous?: SourceEntry['target']) {
  const prior = (previous ?? {}) as Record<string, unknown>;
  const pick = <T>(key: keyof typeof fields, fallback?: T) => (fields[key] !== undefined ? fields[key] : (prior[key] as T | undefined) ?? fallback);
  if (kind === 'truenas') return TrueNasTarget.parse({ schemaVersion: 1, assetId: sourceId, binary: pick('binary'), host: pick('host'), tlsInsecure: pick('tlsInsecure', false) });
  if (kind === 'containers') return ContainerTarget.parse({ schemaVersion: 1, assetId: sourceId, host: pick('host'), user: pick('user'), port: pick('port', 22), engines: pick('engines', ['docker', 'podman', 'incus']) });
  return KubernetesTarget.parse({ schemaVersion: 1, assetId: sourceId, host: pick('host'), user: pick('user'), port: pick('port', 22), access: pick('access', 'direct') });
}

type Names = Record<string, { name: string; namespace?: string; kind?: string; engine?: string; project?: string }>;
const label = (names: Names, id: string) => { const n = names[id]; return n ? (n.namespace ? `${n.namespace}/${n.name}` : n.project && n.project !== 'default' ? `${n.project}/${n.name}` : n.name) : id.slice(0, 12); };

/** Markdown for an investigation, with names joined from the private lookup. */
export function investigationMarkdown(sourceId: string, run: HomelabInvestigation, names: Names): string {
  if (run.kind === 'truenas-assessment') {
    return [`# TrueNAS ${sourceId}`, '', `Assessment: **${run.classification.replaceAll('_', ' ')}** as of ${run.observedAt}.`, '', ...run.reasons.map((r) => `- ${r}`), '', 'Deterministic reading of the health report; no model was involved.'].join('\n') + '\n';
  }
  const isContainers = run.kind === 'container-triage';
  const lines = [`# ${isContainers ? 'Containers' : 'Workloads'} on ${sourceId}`, '', `Observed ${run.input.startedAt}. Collection ${run.input.status}; assessment ${run.status}${run.failure ? ` (${run.failure})` : ''}.`];
  if (isContainers) lines.push(`Engines: ${run.input.queries.map((q) => `${q.engine} ${q.status}${q.total !== undefined ? ` (${q.total})` : ''}`).join(', ')}.`);
  else lines.push(`Sections: ${run.input.queries.map((q) => `${q.section} ${q.status}`).join(', ')}.`);
  lines.push(`Selected ${run.input.selected.length} of ${run.input.eligible ?? 'unknown'} candidates; ${run.input.omitted ?? 'unknown'} omitted by the cap.`, '');
  if (!run.result) lines.push('No assessment was produced.');
  else if (!run.result.findings.length) lines.push('Nothing selected for assessment: no container or pod showed a current problem in this snapshot. That is not a health guarantee.');
  else {
    const counts = isContainers ? containerCounts(run.result) : workloadCounts(run.result);
    lines.push(`${counts.attentionNow} need attention, ${counts.historical} historical, ${counts.insufficientEvidence} insufficient evidence.`, '');
    for (const finding of run.result.findings) {
      const id = 'containerId' in finding ? finding.containerId : finding.podId;
      const fact = (run.input.facts as { id: string }[]).find((f) => f.id === id) as Record<string, unknown> | undefined;
      const detail = fact ? ('engine' in fact ? `${fact.engine}, ${fact.statusText}` : `${fact.kind}, ${fact.phase ?? ''}`) : '';
      lines.push(`- **${finding.classification.replaceAll('_', ' ')}** — ${label(names, id)}${detail ? ` (${detail})` : ''}: ${finding.reason} Next: ${finding.nextInvestigation}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function assessTrueNas(observation: z.infer<typeof TrueNasRun>): HomelabInvestigation {
  const reasons: string[] = [];
  const evidence = observation.evidence;
  let classification: 'attention_now' | 'ok' | 'insufficient_evidence' = 'ok';
  if (!evidence || observation.status === 'failed') { classification = 'insufficient_evidence'; reasons.push(`Health report unavailable (${observation.failure ?? observation.status}).`); }
  else {
    if (evidence.pools && evidence.pools.flagged > 0) { classification = 'attention_now'; reasons.push(`${evidence.pools.flagged} of ${evidence.pools.count} pools are flagged.`); }
    const severe = evidence.alerts ? Object.entries(evidence.alerts.bySeverity).filter(([level, count]) => count > 0 && ['CRITICAL', 'ERROR', 'WARNING'].includes(level)) : [];
    if (severe.length) { classification = 'attention_now'; reasons.push(`Alerts: ${severe.map(([level, count]) => `${count} ${level.toLowerCase()}`).join(', ')} (${evidence.alerts!.dismissed} dismissed).`); }
    if (evidence.coverage.system_state && evidence.state && evidence.state !== 'READY') { classification = 'attention_now'; reasons.push(`System state is ${evidence.state}.`); }
    const missing = Object.entries(evidence.coverage).filter(([, ok]) => !ok).map(([key]) => key);
    if (missing.length) { if (classification === 'ok') classification = 'insufficient_evidence'; reasons.push(`Sections unavailable: ${missing.join(', ')}.`); }
    if (classification === 'ok') reasons.push(`Pools ${evidence.pools?.count ?? 'unknown'}, disks ${evidence.disks?.count ?? 'unknown'}, alerts ${evidence.alerts?.count ?? 'unknown'}: nothing flagged.`);
  }
  return { schemaVersion: 1, kind: 'truenas-assessment', runId: randomUUID(), assetId: observation.assetId, observedAt: observation.startedAt, classification, reasons, observation };
}

export type SourceView = z.infer<typeof SourceView>;

export type HomelabOptions = {
  provider: 'copilot' | 'codex';
  registry: HomelabRegistry;
  modelFactory?: typeof liveModel;
  /** Injectable collectors and investigators for tests. */
  collectors?: Partial<{ truenas: typeof collectTrueNasHealth; containers: typeof collectContainers; kubernetes: typeof collectKubernetes }>;
  investigators?: Partial<{ containers: typeof investigateContainers; kubernetes: typeof investigateWorkloads }>;
};

const SourceView = z.object({
  sourceId: SourceId, kind: z.enum(['truenas', 'containers', 'kubernetes']), origin: Origin, host: z.string(), detail: z.string(),
  latestObservation: z.object({ at: z.string(), status: z.string() }).strict().nullable(),
  latestInvestigation: z.object({ at: z.string(), status: z.string(), summary: z.string() }).strict().nullable(),
}).strict();

export async function describeSource(registry: HomelabRegistry, entry: SourceEntry) {
  const observation = await registry.latestObservation(entry.sourceId).catch(() => undefined);
  const investigation = await registry.latestInvestigation(entry.sourceId).catch(() => undefined);
  const detail = entry.kind === 'containers' ? `${entry.target.user}@${entry.target.host}: ${entry.target.engines.join(', ')}` : entry.kind === 'kubernetes' ? `${entry.target.user}@${entry.target.host} (${entry.target.access})` : entry.target.host;
  const summary = (run: HomelabInvestigation) => run.kind === 'truenas-assessment' ? run.classification.replaceAll('_', ' ') : !run.result ? run.failure ?? run.status : (() => { const c = run.kind === 'container-triage' ? containerCounts(run.result) : workloadCounts(run.result); return `${c.attentionNow} attention, ${c.historical} historical`; })();
  return SourceView.parse({
    sourceId: entry.sourceId, kind: entry.kind, origin: entry.origin, host: entry.target.host, detail,
    latestObservation: observation ? { at: observation.startedAt, status: observation.status } : investigation && 'input' in investigation ? { at: investigation.input.startedAt, status: investigation.input.status } : null,
    latestInvestigation: investigation ? { at: investigation.kind === 'truenas-assessment' ? investigation.observedAt : investigation.startedAt, status: investigation.kind === 'truenas-assessment' ? 'completed' : investigation.status, summary: summary(investigation) } : null,
  });
}

export function homelabCapabilities(options: HomelabOptions): Capability[] {
  const { registry } = options;
  const modelFactory = options.modelFactory ?? liveModel;
  const model = async () => (await modelFactory(EVALUATION_MODEL, options.provider)).model;
  const collectors = { truenas: collectTrueNasHealth, containers: collectContainers, kubernetes: collectKubernetes, ...options.collectors };
  const investigators = { containers: investigateContainers, kubernetes: investigateWorkloads, ...options.investigators };
  const common = { version: 'v1', metadata: { provider: options.provider, model: EVALUATION_MODEL, get sources() { return registry.names(); } } };
  const sourceFor = (sourceId: string) => { const entry = registry.get(sourceId); if (!entry) throw new Error(`unknown_source:${sourceId}`); return entry; };

  const describe = (entry: SourceEntry) => describeSource(registry, entry);

  async function refresh(entry: SourceEntry, directory: string, signal: AbortSignal): Promise<HomelabObservationRecord> {
    const observation = entry.kind === 'truenas'
      ? await collectors.truenas(entry.target, { directory, signal, apiKey: (await registry.truenasApiKey()) ?? '' })
      : entry.kind === 'containers' ? await collectors.containers(entry.target, { directory, signal }) : await collectors.kubernetes(entry.target, { directory, signal });
    const parsed = Observation.parse(observation);
    await registry.recordLatest(entry.sourceId, 'observation', parsed);
    return parsed;
  }

  const readNames = async (file: string): Promise<Names> => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } };

  const sources: Capability = {
    ...common, id: 'homelab.sources', timeoutMs: 30000,
    description: 'List the homelab sources the host observes, with the latest observation and assessment of each.',
    input: z.object({}).strict(), output: z.object({ sources: z.array(SourceView) }).strict(),
    outcome: (result) => ({ status: 'ok', label: `${result.sources.length} sources` }), effects: [],
    execute: async () => ({ sources: await Promise.all(registry.list().map(describe)) }),
  };

  const addSource: Capability = {
    ...common, id: 'homelab.add-source', timeoutMs: 30000, lane: () => 'homelab-registry',
    description: 'Register a homelab source: a TrueNAS host, an SSH host with Docker, Podman or Incus, or a k3s host. Nothing is collected until refreshed.',
    input: z.object({ sourceId: SourceId, kind: z.enum(['truenas', 'containers', 'kubernetes']), ...SourceFields.shape }).strict(),
    output: z.object({ source: SourceView }).strict(), outcome: (result) => ({ status: 'ok', label: `${result.source.kind} ${result.source.sourceId}` }), effects: ['local_artifacts'],
    execute: async ({ sourceId, kind, ...fields }) => {
      if (registry.get(sourceId)) throw new Error('source_exists');
      const entry = await registry.save(SourceEntry.parse({ sourceId, kind, target: buildTarget(kind, sourceId, SourceFields.parse(fields)), origin: 'registry', addedAt: new Date().toISOString() }));
      return { source: await describe(entry) };
    },
  };

  const updateSource: Capability = {
    ...common, id: 'homelab.update-source', timeoutMs: 30000, lane: () => 'homelab-registry',
    description: 'Change a registered homelab source: host, user, port, engines, sudo access, TrueNAS binary or TLS setting.',
    get input() { return z.object({ sourceId: registry.schema(), ...SourceFields.shape }).strict(); },
    output: z.object({ source: SourceView }).strict(), outcome: () => ({ status: 'ok', label: 'source updated' }), effects: ['local_artifacts'],
    execute: async ({ sourceId, ...fields }) => {
      const previous = sourceFor(sourceId);
      const entry = await registry.save(SourceEntry.parse({ ...previous, target: buildTarget(previous.kind, sourceId, SourceFields.parse(fields), previous.target) }));
      return { source: await describe(entry) };
    },
  };

  const refreshCapability: Capability = {
    ...common, id: 'homelab.refresh', timeoutMs: 300000, lane: (input) => `homelab:${input.sourceId}`,
    description: 'Collect a fresh read-only observation from one source and keep it as that source\'s latest.',
    get input() { return z.object({ sourceId: registry.schema() }).strict(); },
    output: z.object({ sourceId: SourceId, kind: z.enum(['truenas', 'containers', 'kubernetes']), observation: z.json(), markdown: z.string() }).strict(),
    outcome: (result) => { const status = String(result.observation?.status); return { status: status === 'completed' ? 'ok' : status === 'partial' ? 'partial' : 'failed', label: `collection ${status}` }; },
    effects: ['configured_source_reads', 'local_artifacts'],
    execute: async ({ sourceId }, ctx) => {
      const entry = sourceFor(sourceId);
      const observation = await refresh(entry, join(ctx.directory, 'source'), ctx.signal);
      return { sourceId, kind: entry.kind, observation, markdown: renderHomelabBrief(composeHomelabBrief([observation], { maxAgeSeconds: registry.options.maxAgeSeconds })) };
    },
  };

  const investigate: Capability = {
    ...common, id: 'homelab.investigate', timeoutMs: 600000, lane: (input) => `homelab:${input.sourceId}`,
    description: 'Collect fresh evidence from one source and assess it: pods on k3s, containers and instances on a Docker/Podman/Incus host, or the TrueNAS health report.',
    get input() { return z.object({ sourceId: registry.schema() }).strict(); },
    output: z.object({ sourceId: SourceId, kind: z.enum(['truenas', 'containers', 'kubernetes']), run: z.json(), names: z.json(), markdown: z.string() }).strict(),
    outcome: (result) => {
      const run = result.run as HomelabInvestigation;
      if (run.kind === 'truenas-assessment') return { status: run.classification === 'ok' ? 'ok' : run.classification === 'attention_now' ? 'failed' : 'partial', label: run.classification.replaceAll('_', ' ') };
      if (run.status !== 'completed' || !run.result) return { status: 'failed', label: run.failure ?? run.status };
      const counts = run.kind === 'container-triage' ? containerCounts(run.result) : workloadCounts(run.result);
      return { status: counts.attentionNow ? 'failed' : counts.insufficientEvidence ? 'partial' : 'ok', label: `${counts.attentionNow} attention, ${counts.historical} historical, ${counts.insufficientEvidence} unclear` };
    },
    effects: ['configured_source_reads', 'model_calls', 'local_artifacts'],
    execute: async ({ sourceId }, ctx) => {
      const entry = sourceFor(sourceId);
      const directory = join(ctx.directory, 'investigation');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let run: HomelabInvestigation;
      let names: Names = {};
      if (entry.kind === 'truenas') run = assessTrueNas(TrueNasRun.parse(await refresh(entry, join(directory, 'source'), ctx.signal)));
      else if (entry.kind === 'containers') {
        run = await investigators.containers(entry.target, { directory: join(directory, 'run'), provider: options.provider, modelId: EVALUATION_MODEL, modelFactory: model, signal: ctx.signal });
        names = await readNames(join(directory, 'run', 'source', 'containers.private.json'));
        await registry.recordLatest(entry.sourceId, 'observation', run.input);
      } else {
        run = await investigators.kubernetes(entry.target, { directory: join(directory, 'run'), provider: options.provider, modelId: EVALUATION_MODEL, modelFactory: model, signal: ctx.signal });
        names = await readNames(join(directory, 'run', 'source', 'resources.private.json'));
      }
      await registry.recordLatest(entry.sourceId, 'investigation', run);
      return { sourceId, kind: entry.kind, run, names, markdown: investigationMarkdown(sourceId, run, names) };
    },
  };

  const brief: Capability = {
    ...common, id: 'homelab.brief', timeoutMs: 900000, lane: () => 'homelab-brief',
    description: 'One page across every source: the latest observation and assessment of each. Set refresh to collect first.',
    input: z.object({ refresh: z.boolean().default(false), sourceIds: z.array(SourceId).max(50).optional() }).strict(),
    output: z.object({ brief: z.json(), markdown: z.string(), sources: z.array(SourceView) }).strict(),
    outcome: (result) => { const stale = (result.brief as { sources: { freshness: string }[] }).sources.filter((s) => s.freshness !== 'fresh').length; return { status: stale ? 'partial' : 'ok', label: stale ? `${stale} stale or unknown sources` : `${(result.brief as { sources: unknown[] }).sources.length} fresh sources` }; },
    effects: ['configured_source_reads', 'local_artifacts'],
    execute: async ({ refresh: collect, sourceIds }, ctx) => {
      const entries = registry.list().filter((entry) => !sourceIds || sourceIds.includes(entry.sourceId));
      if (!entries.length) throw new Error('no_sources');
      const observations: unknown[] = [];
      for (const entry of entries) {
        ctx.signal.throwIfAborted();
        const observation = collect ? await refresh(entry, join(ctx.directory, 'source', entry.sourceId), ctx.signal).catch(() => undefined) : await registry.latestObservation(entry.sourceId);
        if (observation) observations.push(observation);
        const investigation = await registry.latestInvestigation(entry.sourceId);
        if (investigation && investigation.kind !== 'truenas-assessment') observations.push(investigation);
      }
      if (!observations.length) throw new Error('nothing_observed_yet');
      const composed = composeHomelabBrief(observations, { maxAgeSeconds: registry.options.maxAgeSeconds });
      return { brief: composed, markdown: renderHomelabBrief(composed), sources: await Promise.all(entries.map(describe)) };
    },
  };

  return [sources, addSource, updateSource, refreshCapability, investigate, brief];
}
