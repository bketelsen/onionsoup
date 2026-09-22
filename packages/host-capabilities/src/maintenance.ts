import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Capability } from '@onionsoup/job-host';
import { atomicJson } from '@onionsoup/runtime/storage';
import { createInvocationBudget } from '@onionsoup/runtime/budget';
import { liveModel } from '@onionsoup/providers';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { Observation } from '@onionsoup/maintenance/issues';
import { githubSource, type Source } from '@onionsoup/maintenance/github-issues';
import { triage, LIMITS as READINESS_LIMITS } from '@onionsoup/maintenance/triage';
import { PROMPT_VERSION as READINESS_PROMPT } from '@onionsoup/maintenance/prompt';
import { validateReadinessRun } from '@onionsoup/maintenance/readiness-record';
import { locateReadyIssue, validateLocationHandoff } from '@onionsoup/maintenance/location-handoff';
import { LOCATION_LIMITS } from '@onionsoup/maintenance/location-contracts';
import { LOCATION_PROMPT_VERSION as LOCATION_PROMPT } from '@onionsoup/maintenance/location-prompt';
import { createPacket, packetMarkdown, validatePacket } from '@onionsoup/maintenance/packet';
import { createChangeProposal } from '@onionsoup/maintenance/proposal/recipe';
import { validateChangeWorkflow } from '@onionsoup/maintenance/proposal/record';
import { proposalMarkdown } from '@onionsoup/maintenance/proposal/render';

const execute = promisify(execFile);

import type { RepositoryRegistry } from './registry.ts';

/** A repository the host may read issues from, with an optional local checkout for source reads. */
export type MaintenanceRepository = { name: string; checkout?: string };

export type MaintenanceOptions = {
  provider: 'copilot' | 'codex';
  registry: RepositoryRegistry;
  modelFactory?: typeof liveModel;
  source?: Source;
  triage?: typeof triage;
  locate?: typeof locateReadyIssue;
  packet?: typeof createPacket;
  proposal?: typeof createChangeProposal;
  /** Resolves the commit a checkout is at. Defaults to `git rev-parse HEAD`. */
  head?: (checkout: string, signal: AbortSignal) => Promise<string>;
};

export const ReadinessResult = z.object({ issue: Observation, run: z.json() }).strict();
export const LocationResult = z.object({ handoff: z.json() }).strict();
export const PacketResult = z.object({ packet: z.json(), markdown: z.string() }).strict();
export const ProposalResult = z.object({ proposal: z.json(), markdown: z.string() }).strict();

/** The commit work is pinned to: the remote default branch after a fetch, falling back to the local HEAD when offline. */
export async function gitHead(checkout: string, signal: AbortSignal) {
  try {
    await execute('git', ['-C', checkout, 'fetch', '--quiet', 'origin'], { signal, timeout: 60000 });
    // Keep a clean checkout current so people and local clones see the same base.
    const { stdout: dirty } = await execute('git', ['-C', checkout, 'status', '--porcelain'], { signal, timeout: 10000 });
    if (!dirty.trim()) await execute('git', ['-C', checkout, 'merge', '--quiet', '--ff-only', 'refs/remotes/origin/HEAD'], { signal, timeout: 30000 }).catch(() => {});
  } catch {
    /* offline or no remote: the checkout's own history is still a valid pin */
  }
  for (const ref of ['refs/remotes/origin/HEAD', 'HEAD']) {
    try {
      const { stdout } = await execute('git', ['-C', checkout, 'rev-parse', '--verify', `${ref}^{commit}`], { signal, timeout: 10000 });
      const commit = stdout.trim();
      if (/^[a-f0-9]{40}$/.test(commit)) return commit;
    } catch {
      /* try the next ref */
    }
  }
  throw new Error('checkout_head_unresolved');
}

export function maintenanceCapabilities(options: MaintenanceOptions): Capability[] {
  const { registry } = options;
  const source = options.source ?? githubSource;
  const modelFactory = options.modelFactory ?? liveModel;
  const head = options.head ?? gitHead;
  const adapter = async () => {
    const a = await modelFactory(EVALUATION_MODEL, options.provider);
    if (a.provider !== options.provider || a.modelId !== EVALUATION_MODEL) throw new Error('Provider/model mismatch');
    return a;
  };
  const checkoutFor = (repository: string) => {
    const configured = registry.get(repository)?.checkout;
    if (!configured) throw new Error(`no_checkout_configured:${repository}`);
    return configured;
  };
  const common = { version: 'v1', timeoutMs: 1200000 };
  const metadata = {
    provider: options.provider,
    model: EVALUATION_MODEL,
    get repositories() { return registry.list().map((r) => ({ name: r.name, sourceReads: Boolean(r.checkout) })); },
  };

  const readiness: Capability = {
    ...common,
    id: 'issue.readiness',
    lane: (input) => `repository:${input.repository}`,
    description: 'Fetch one issue and assess whether it is a bug report ready to investigate. Classification, not acceptance.',
    get input() { return z.object({ repository: registry.schema(), issue: z.number().int().positive() }).strict(); },
    output: ReadinessResult,
    outcome: (result) => { const a = result.run?.assessment; return a ? { status: 'ok', label: `${String(a.kind).replaceAll('_', ' ')} · ${String(a.bug_readiness).replaceAll('_', ' ')}` } : { status: 'failed', label: result.run?.failure ?? 'no assessment' }; },
    validateOutput: (raw) => { const r = ReadinessResult.parse(raw); validateReadinessRun(r.run); return r; },
    metadata: { ...metadata, promptVersion: READINESS_PROMPT, limits: READINESS_LIMITS },
    effects: ['github_reads', 'model_calls', 'local_artifacts'],
    execute: async ({ repository, issue }, ctx) => {
      const observation = await source.get(repository, issue, ctx.signal);
      if (!observation.snapshot) throw new Error(`issue_${observation.rejection ?? 'unusable'}`);
      const run = await (options.triage ?? triage)(observation.snapshot, {
        ...(await adapter()),
        signal: ctx.signal,
        checkpoint: (record) => atomicJson(join(ctx.directory, 'readiness.json'), record),
      });
      return { issue: observation, run };
    },
  };

  const location: Capability = {
    ...common,
    id: 'code.location',
    description: 'For a completed ready bug assessment, suggest code and test starting points in the configured checkout. No diagnosis.',
    input: z.object({ readinessJobId: z.uuid() }).strict(),
    output: LocationResult,
    outcome: (result) => ({ status: result.handoff.disposition === 'located' ? 'ok' : result.handoff.disposition === 'not_located' ? 'partial' : 'failed', label: String(result.handoff.disposition).replaceAll('_', ' ') }),
    validateOutput: (raw) => { const r = LocationResult.parse(raw); validateLocationHandoff(r.handoff); return r; },
    metadata: { ...metadata, promptVersion: LOCATION_PROMPT, limits: LOCATION_LIMITS },
    effects: ['local_source_reads', 'model_calls', 'local_artifacts'],
    execute: async ({ readinessJobId }, ctx) => {
      const parent = await ctx.dependency(readinessJobId);
      if (parent.capability !== 'issue.readiness') throw new Error('dependency_not_readiness');
      const run = validateReadinessRun(ReadinessResult.parse(parent.result).run);
      const assessment = run.assessment as { kind?: string; bug_readiness?: string } | undefined;
      const eligible = run.schemaVersion === 2 && run.status === 'completed' && assessment?.kind === 'bug_report' && assessment.bug_readiness === 'ready';
      if (!eligible) throw new Error('readiness_not_eligible');
      const checkout = checkoutFor(run.input.repository);
      const commit = await head(checkout, ctx.signal);
      const handoff = await (options.locate ?? locateReadyIssue)(run, {
        source: { checkout, repository: { name: run.input.repository, commit } },
        budget: createInvocationBudget(1),
        signal: ctx.signal,
        model: adapter,
        checkpoint: (record) => atomicJson(join(ctx.directory, 'location.json'), record),
      });
      return { handoff };
    },
  };

  const packet: Capability = {
    ...common,
    id: 'investigation.packet',
    lane: (input) => `repository:${input.repository}`,
    description: 'Readiness plus code location for one issue in a single run, rendered as an investigation packet.',
    get input() { return z.object({ repository: registry.schema(), issue: z.number().int().positive() }).strict(); },
    output: PacketResult,
    outcome: (result) => ({ status: result.packet.status === 'completed' ? 'ok' : result.packet.status === 'partial' ? 'partial' : 'failed', label: `${result.packet.status} · location ${String(result.packet.locationDisposition).replaceAll('_', ' ')}` }),
    validateOutput: (raw) => { const r = PacketResult.parse(raw); validatePacket(r.packet); return r; },
    metadata,
    effects: ['github_reads', 'local_source_reads', 'model_calls', 'local_artifacts'],
    execute: async ({ repository, issue }, ctx) => {
      const observation = await source.get(repository, issue, ctx.signal);
      if (!observation.snapshot) throw new Error(`issue_${observation.rejection ?? 'unusable'}`);
      const checkout = checkoutFor(repository);
      const commit = await head(checkout, ctx.signal);
      const result = await (options.packet ?? createPacket)(observation.snapshot, {
        directory: join(ctx.directory, 'packet'), checkout, commit, provider: options.provider, signal: ctx.signal, modelFactory,
      });
      return { packet: result, markdown: packetMarkdown(result) };
    },
  };

  const proposal: Capability = {
    ...common,
    id: 'change.proposal',
    description: 'Draft a read-only change proposal from a completed packet. Features need a literal source search query.',
    input: z.object({ packetJobId: z.uuid(), query: z.string().min(1).max(160).optional() }).strict(),
    output: ProposalResult,
    outcome: (result) => { const stage = result.proposal.stages?.at(-1)?.run?.result; const status = stage?.status ?? result.proposal.status; return { status: status === 'proposal_ready' ? 'ok' : status === 'needs_information' ? 'partial' : 'failed', label: String(status).replaceAll('_', ' ') }; },
    validateOutput: (raw) => { const r = ProposalResult.parse(raw); validateChangeWorkflow(r.proposal); return r; },
    metadata,
    effects: ['local_source_reads', 'model_calls', 'local_artifacts'],
    execute: async ({ packetJobId, query }, ctx) => {
      const parent = await ctx.dependency(packetJobId);
      if (parent.capability !== 'investigation.packet') throw new Error('dependency_not_packet');
      const p = validatePacket(PacketResult.parse(parent.result).packet);
      const workflow = await (options.proposal ?? createChangeProposal)(p, {
        directory: join(ctx.directory, 'proposal'), provider: options.provider, checkout: registry.get(p.repository.name)?.checkout,
        query, signal: ctx.signal, modelFactory,
      });
      return { proposal: workflow, markdown: proposalMarkdown(workflow) };
    },
  };

  const SEARCH_LIMITS = { results: 100, textChars: 200, outputBytes: 4 * 1024 * 1024 } as const;
  const SearchResult = z.object({
    repository: z.string(), commit: z.string(), query: z.string(),
    matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }).strict()),
    truncated: z.boolean(),
  }).strict();
  const search: Capability = {
    ...common,
    timeoutMs: 60000,
    id: 'repository.search',
    description: 'Find where a literal phrase appears in a configured checkout at its current base commit. Paths and matching lines only; no model.',
    get input() { return z.object({
      repository: registry.schema(),
      query: z.string().min(1).max(200),
      maxResults: z.number().int().min(1).max(SEARCH_LIMITS.results).default(40),
    }).strict(); },
    output: SearchResult,
    outcome: (result) => ({ status: result.matches.length ? 'ok' : 'partial', label: `${result.matches.length} match(es)${result.truncated ? ', truncated' : ''}` }),
    metadata,
    effects: ['local_source_reads'],
    execute: async ({ repository, query, maxResults }, ctx) => {
      const checkout = checkoutFor(repository);
      const commit = await head(checkout, ctx.signal);
      let stdout = '';
      try {
        ({ stdout } = await execute('git', ['-C', checkout, 'grep', '-n', '-I', '-i', '-F', '-e', query, commit, '--', '.'], { signal: ctx.signal, timeout: 30000, maxBuffer: SEARCH_LIMITS.outputBytes }));
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw new Error('search_failed');
      }
      const lines = stdout.split('\n').filter(Boolean);
      const matches = lines.slice(0, maxResults).map((line) => {
        const [, path, lineNumber, text] = /^[a-f0-9]{40}:([^:]+):(\d+):(.*)$/.exec(line) ?? [];
        return { path: path ?? '', line: Number(lineNumber ?? 0), text: (text ?? '').slice(0, SEARCH_LIMITS.textChars) };
      }).filter((match) => match.path && match.line > 0);
      return { repository, commit, query, matches, truncated: lines.length > maxResults };
    },
  };

  return [readiness, location, packet, proposal, search];
}
