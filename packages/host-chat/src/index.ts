import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ChatAnswer, ChatProfile, ProfileContext } from '@onionsoup/chat';

export const HOST_CHAT_VERSION = 'host-chat-v1';

/** Session-wide and per-turn allowances. Configuration with defaults, not contracts. */
export const HOST_CHAT_LIMITS = {
  sessionAdmissions: 200,
  runsPerTurn: 6,
  polls: 3600,
  pollMs: 1000,
  summaryChars: 6000,
  listJobs: 20,
} as const;

const Id = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const RememberedJob = z.object({ id: z.uuid(), capability: Id, admittedAt: z.iso.datetime() }).strict();
export const HostChatMemory = z.object({
  schemaVersion: z.literal(1),
  profileVersion: z.literal(HOST_CHAT_VERSION),
  admissions: z.number().int().min(0),
  jobs: z.array(RememberedJob).max(HOST_CHAT_LIMITS.sessionAdmissions),
}).strict();
export type HostChatMemory = z.infer<typeof HostChatMemory>;

/** What the chat needs from the job host, already bound to the session's principal. */
export type HostCaller = {
  discover(): { capabilities: { id: string; description: string; inputSchema: unknown; effects: string[]; interactive?: boolean }[] };
  submit(request: { capability: string; input: unknown; idempotencyKey: string }): Promise<{ jobId: string }>;
  inspect(jobId: string): Promise<{ jobId: string; capability: string; status: string; createdAt: string; error?: string; outcome?: { status: string; label: string }; result?: unknown }>;
  list(): { jobId: string; capability: string; status: string; createdAt: string }[];
  cancel(jobId: string): Promise<unknown>;
};

/** A bounded projection of a result for the model: rendered Markdown when present, otherwise truncated JSON. */
export function summarize(result: unknown, limit: number = HOST_CHAT_LIMITS.summaryChars): { summary: string; truncated: boolean } {
  const record = result as Record<string, unknown> | null;
  const text = record && typeof record.markdown === 'string' ? record.markdown : JSON.stringify(result, null, 1) ?? 'null';
  return { summary: text.slice(0, limit), truncated: text.length > limit };
}

const settled = (status: string) => status !== 'queued' && status !== 'running';

export function createHostChatProfile(options: { bindingHash: string; host: HostCaller; pollMs?: number; allowInteractive?: boolean }): ChatProfile {
  const { host } = options;
  const allowInteractive = options.allowInteractive ?? true;
  const pollMs = options.pollMs ?? HOST_CHAT_LIMITS.pollMs;
  return {
    id: 'host',
    bindingHash: options.bindingHash,
    initialMemory: () => ({ schemaVersion: 1, profileVersion: HOST_CHAT_VERSION, admissions: 0, jobs: [] }),
    parseMemory: (memory) => HostChatMemory.parse(memory),
    system: [
      'You operate a catalog of reviewed capabilities and saved recipes for the person you are talking to.',
      'Discover the catalog before running anything. Run only what the request needs: briefs are for repository overviews, not for finding files.',
      'To find where something lives in a repository, run repository.search with a literal phrase; it returns matching paths and lines.',
      'To make a code change the person describes: repository.search for the file, then change.request with the exact files, then change.implement with the approval job ID, then change.publish with the implement job ID and the person\'s words as the reason. Each step waits for the previous one; report each job ID.',
      allowInteractive ? 'Interactive capabilities (request, approve, publish) run only when the person explicitly asked for that effect in this message.' : 'Capabilities marked interactive need a person to submit them from the job page; say so.',
      'If change.implement fails with project_proposal_needs_information, restate the request answering that question and run change.request and change.implement once more; if you cannot answer it, ask the person.',
      'A completed job can still report a failed outcome; read the outcome and error fields before claiming success.',
      'Every factual answer cites job IDs you inspected in this turn. Never invent results, paths or credentials.',
    ].join(' '),
    turn(context: ProfileContext) {
      const memory = HostChatMemory.parse(context.memory);
      const seen = new Map<string, Record<string, unknown>>();
      const active = new Set<string>();
      let runs = 0;
      let catalog: ReturnType<HostCaller['discover']>['capabilities'] | undefined;
      const checkpoint = (details: Record<string, unknown>) => context.checkpoint(memory, details);

      async function inspect(jobId: string) {
        const job = await host.inspect(jobId);
        if (settled(job.status)) active.delete(jobId);
        const projection = job.status === 'completed' ? summarize(job.result) : { summary: job.error ?? job.status, truncated: false };
        const evidence = { jobId, capability: job.capability, status: job.status, createdAt: job.createdAt, ...(job.error ? { error: job.error } : {}), ...(job.outcome ? { outcome: job.outcome } : {}) };
        seen.set(jobId, evidence);
        return { ...evidence, ...projection };
      }
      async function wait(jobId: string) {
        for (let n = 0; n < HOST_CHAT_LIMITS.polls; n++) {
          const current = await inspect(jobId);
          if (settled(current.status)) return current;
          await delay(pollMs, undefined, { signal: context.signal });
        }
        throw new Error('POLL_LIMIT');
      }

      return {
        context: { profileVersion: HOST_CHAT_VERSION, jobs: memory.jobs, remainingAdmissions: HOST_CHAT_LIMITS.sessionAdmissions - memory.admissions, limits: HOST_CHAT_LIMITS },
        tools: [
          {
            name: 'discover_capabilities',
            description: 'List the capabilities and recipes you may run, with their input schemas. Interactive ones are listed for reference only.',
            input: z.object({}).strict(),
            execute: async () => {
              catalog = host.discover().capabilities;
              return { capabilities: catalog.map((c) => ({ id: c.id, description: c.description, inputSchema: c.inputSchema, effects: c.effects, interactive: Boolean(c.interactive) })) };
            },
          },
          {
            name: 'list_jobs',
            description: 'Recent jobs on the host, newest first. Inspect one to cite it.',
            input: z.object({ capability: Id.optional() }).strict(),
            execute: async (raw) => {
              const { capability } = raw as { capability?: string };
              const jobs = host.list().filter((job) => !capability || job.capability === capability).slice(0, HOST_CHAT_LIMITS.listJobs);
              return { jobs };
            },
          },
          {
            name: 'run_capability',
            description: 'Submit one capability or recipe with an input that matches its schema, then wait for it. At most two per turn.',
            input: z.object({ capability: Id, input: z.json() }).strict(),
            execute: async (raw) => {
              const { capability, input } = raw as { capability: string; input: unknown };
              if (!catalog) throw new Error('DISCOVER_FIRST');
              const definition = catalog.find((c) => c.id === capability);
              if (!definition) throw new Error('CAPABILITY_NOT_AVAILABLE');
              if (definition.interactive && !allowInteractive) throw new Error('INTERACTIVE_CAPABILITY');
              if (runs >= HOST_CHAT_LIMITS.runsPerTurn) throw new Error('TURN_RUN_LIMIT');
              if (memory.admissions >= HOST_CHAT_LIMITS.sessionAdmissions) throw new Error('SESSION_ADMISSION_LIMIT');
              runs++;
              memory.admissions++;
              await checkpoint({ kind: 'admission_reserved', total: memory.admissions });
              const { jobId } = await host.submit({ capability, input, idempotencyKey: randomUUID() });
              memory.jobs.push({ id: jobId, capability, admittedAt: new Date().toISOString() });
              active.add(jobId);
              await checkpoint({ kind: 'job_admitted', jobId });
              return wait(jobId);
            },
          },
          {
            name: 'inspect_job',
            description: 'Read a job by ID: status, error, and a bounded view of its result. Required before citing it.',
            input: z.object({ jobId: z.uuid() }).strict(),
            execute: async (raw) => inspect((raw as { jobId: string }).jobId),
          },
        ],
        async validateAnswer(answer: ChatAnswer) {
          if (answer.kind !== 'answer') return { kind: answer.kind, remainingAdmissions: HOST_CHAT_LIMITS.sessionAdmissions - memory.admissions };
          if (!answer.references.length || answer.basis === 'none') throw new Error('EVIDENCE_REQUIRED');
          const evidence = answer.references.map((reference) => {
            const item = seen.get(reference.id);
            if (!item) throw new Error('INSPECT_FIRST');
            return item;
          });
          return { basis: answer.basis, evidence, remainingAdmissions: HOST_CHAT_LIMITS.sessionAdmissions - memory.admissions };
        },
        async cleanup() {
          for (const jobId of active) {
            try { await host.cancel(jobId); } catch { /* the job stays inspectable; it is never replayed */ }
          }
        },
      };
    },
  };
}
