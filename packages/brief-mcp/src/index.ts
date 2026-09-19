import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BriefRequest, RepoAgentId, repositoryCapabilityManifest, hash } from '@onionsoup/repository-analysis';
import { createRepositoryBrief, validateRepositoryBrief, repositoryBriefMarkdown, workflowEvents } from '@onionsoup/repository-brief';
import { atomicJson, optionalJson } from '@onionsoup/runtime/storage';

const Job = z.object({ schemaVersion: z.literal(1), kind: z.literal('brief-mcp-job'), jobId: z.uuid(),
  request: BriefRequest, provider: z.enum(['copilot', 'codex']), createdAt: z.iso.datetime(),
  status: z.enum(['admitted', 'settled', 'execution_failed']), finishedAt: z.iso.datetime().optional() }).strict();
type Job = z.infer<typeof Job>;
export type BriefMcpOptions = {
  runsDirectory: string;
  repositories: string[];
  provider: 'copilot' | 'codex';
  maxJobs?: number;
  reader?: Parameters<typeof createRepositoryBrief>[1]['reader'];
  modelFactory?: Parameters<typeof createRepositoryBrief>[1]['modelFactory'];
};
const reply = (body: Record<string, unknown>, isError = false) => ({ isError,
  content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body });

// One host process owns this directory. A durable admission precedes all API/model work.
// Saved jobs are inspectable after restart; an interrupted attempt is never replayed.
export function createBriefMcpServer(options: BriefMcpOptions) {
  const provider = z.enum(['copilot', 'codex']).parse(options.provider);
  const repositories = new Set(z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1).max(100)
    .parse(options.repositories).map(repository => repository.toLowerCase()));
  const limit = z.number().int().min(1).max(10).parse(options.maxJobs ?? 1);
  const root = resolve(options.runsDirectory);
  let admitted = 0, active = false, stopped = false;
  const pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const server = new McpServer({ name: 'onionsoup-repository-brief', version: '0.1.0' });
  const allowed = (request: BriefRequest) => repositories.has(request.repository.toLowerCase());
  const directory = (id: string) => join(root, z.uuid().parse(id));
  const readJob = async (id: string) => {
    const raw = await optionalJson(join(directory(id), 'job.json'));
    if (!raw) return undefined;
    const job = Job.parse(raw);
    if (job.jobId !== id || !allowed(job.request) || job.provider !== provider) return undefined;
    return job;
  };
  server.registerTool('discover_repository_brief', {
    description: 'Describe this host, its allowed repositories and bounded repository-brief capabilities. Discovery grants no new authority.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => reply({ schemaVersion: 1, repositories: [...repositories], maxJobs: limit, admitted, active,
    invocable: ['repository-brief'], agents: RepoAgentId.options.map(repositoryCapabilityManifest),
    lifecycle: { protocol: 'application-job-v1', durableInspection: true, automaticResume: false,
      concurrentJobs: 1, maxModelCallsPerJob: 4, maxDurationMs: 600000 },
    effects: { githubReads: true, githubWrites: false, localArtifacts: true, email: false, targetCodeExecution: false } }));
  server.registerTool('submit_repository_brief', {
    description: 'Admit one brief for an allowed repository. Returns a jobId immediately; inspect that ID for results. A repeated submit is a new attempt and consumes another admission.',
    inputSchema: z.object({ request: BriefRequest }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ request }) => {
    if (!allowed(request)) return reply({ error: 'repository_not_allowed' }, true);
    if (Date.parse(request.until) > Date.now()) return reply({ error: 'future_window' }, true);
    if (stopped) return reply({ error: 'host_stopping' }, true);
    if (active) return reply({ error: 'busy' }, true);
    if (admitted >= limit) return reply({ error: 'job_limit' }, true);
    // Synchronous reservation closes concurrent admission races, including storage awaits.
    active = true; admitted++;
    const job: Job = { schemaVersion: 1, kind: 'brief-mcp-job', jobId: randomUUID(), request, provider,
      createdAt: new Date().toISOString(), status: 'admitted' };
    const home = directory(job.jobId);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(home, { mode: 0o700 });
      await atomicJson(join(home, 'job.json'), job);
    } catch { active = false; return reply({ error: 'admission_storage_failed' }, true); }
    const controller = new AbortController();
    if (stopped) controller.abort();
    // Start on a subsequent microtask so pending is installed before execution settles.
    const promise = Promise.resolve().then(async () => {
      try {
        await createRepositoryBrief(request, { directory: join(home, 'analysis'), provider,
          reader: options.reader, modelFactory: options.modelFactory, signal: controller.signal });
        job.status = 'settled';
      } catch { job.status = 'execution_failed'; }
      job.finishedAt = new Date().toISOString();
      try { await atomicJson(join(home, 'job.json'), job); }
      catch { /* Admission and saved recipe remain inspectable as an unfinished attempt. */ }
    }).finally(() => { pending.delete(job.jobId); active = false; });
    pending.set(job.jobId, { controller, promise });
    return reply({ schemaVersion: 1, jobId: job.jobId, status: 'admitted' });
  });
  server.registerTool('inspect_repository_brief', {
    description: 'Inspect an admitted job and saved brief, including after restart. Returns rendered evidence and events, never raw model state or host paths. Unfinished work is not resumed.',
    inputSchema: z.object({ jobId: z.uuid() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    try {
      const job = await readJob(jobId);
      if (!job) return reply({ error: 'job_not_found' }, true);
      const raw = await optionalJson(join(directory(jobId), 'analysis', 'repository-brief.json'));
      const brief = raw ? validateRepositoryBrief(raw) : undefined;
      if (brief && (hash(brief.request) !== hash(job.request) || brief.execution.provider !== job.provider))
        return reply({ error: 'artifact_mismatch' }, true);
      const status = pending.has(jobId) ? 'running' : job.status === 'admitted' ? 'unfinished' : job.status;
      return reply({ schemaVersion: 1, jobId, status, ...(brief ? { workflowId: brief.workflowId,
        resultStatus: brief.status, budget: brief.budget, markdown: repositoryBriefMarkdown(brief), events: workflowEvents(brief) } : {}) });
    } catch { return reply({ error: 'inspection_failed' }, true); }
  });
  server.registerTool('cancel_repository_brief', {
    description: 'Request cooperative cancellation of an active job in this host. Cancellation does not erase evidence or replenish admission.',
    inputSchema: z.object({ jobId: z.uuid() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    const running = pending.get(jobId);
    if (!running) return reply({ error: 'job_not_active' }, true);
    running.controller.abort(); return reply({ jobId, status: 'cancellation_requested' });
  });
  return { server, async shutdown() {
    stopped = true;
    for (const job of pending.values()) job.controller.abort();
    await Promise.allSettled([...pending.values()].map(job => job.promise));
    await server.close();
  } };
}
