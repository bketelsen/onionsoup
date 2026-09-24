import { withRecordLock } from './record-lock.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProposedWork } from './artifacts.ts';
import { AssignmentRef } from './initiatives.ts';

export const REQUEST_LIMITS = { decisionAttempts: 3, retryBaseMs: 60_000, retryMaxMs: 15 * 60_000, reconcileMs: 5 * 60_000 };

export function requestRunnerIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Owners talk through requests. A resource request moves through a fixed lifecycle, and the two
 * steps that create or destroy something in the world wait for a person:
 *
 *   pending-owner → (owner accepts) awaiting-create-approval → (person) create-approved
 *                 → (runtime creates) provisioned → (requester's follow-up runs, then releases)
 *                 → awaiting-delete-approval → (person) delete-approved → (runtime deletes) deleted
 *   pending-owner → declined            awaiting-create-approval → denied
 *
 * People only record decisions; the runtime acts on them, so approvals never race the daemon.
 * A create approval may also approve the matching delete (a lease), so a throwaway instance
 * cleans itself up on release without a second prompt.
 */
export const RequestStatus = z.enum([
  'pending-owner',
  'declined',
  'awaiting-create-approval',
  'create-approved',
  'denied',
  'provisioned',
  'awaiting-delete-approval',
  'delete-approved',
  'deleted',
  'published',
  'updated',
  'failed',
  'interrupted',
  'work-running',
  'completed',
]);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const InstanceAsk = z.object({
  kind: z.literal('instance'),
  image: z.string().describe('An incus image such as images:debian/13'),
  purpose: z.string(),
  expectedMinutes: z.number().int().positive(),
});
export type InstanceAsk = z.infer<typeof InstanceAsk>;

/** Publish a site the receiving owner hosts, built from the requesting owner's repository. */
export const PublishAsk = z.object({
  kind: z.literal('publish-site'),
  site: z.string(),
  purpose: z.string(),
});
export type PublishAsk = z.infer<typeof PublishAsk>;

/** Update an app on the owner's own NAS, decided by the owner after reading its release notes. */
export const UpdateAppAsk = z.object({
  kind: z.literal('update-app'),
  app: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  imageUpdates: z.boolean().optional(),
  purpose: z.string(),
  notesRead: z.array(z.string()).default([]),
});
export type UpdateAppAsk = z.infer<typeof UpdateAppAsk>;

export const WorkAsk = z.object({
  kind: z.literal('work'), purpose: z.string(), proposal: ProposedWork,
  /** Set when the work carries out an initiative's assignment. */
  assignment: AssignmentRef.optional(),
});
export type WorkAsk = z.infer<typeof WorkAsk>;

export const ResourceAsk = z.discriminatedUnion('kind', [InstanceAsk, PublishAsk, UpdateAppAsk, WorkAsk]);
export type ResourceAsk = z.infer<typeof ResourceAsk>;

export function describeAsk(ask: ResourceAsk) {
  const descriptions: Record<ResourceAsk['kind'], () => string> = {
    work: () => `work: ${(ask as WorkAsk).proposal.title}`,
    instance: () => (ask as InstanceAsk).image,
    'publish-site': () => `publish ${(ask as PublishAsk).site}`,
    'update-app': () => `update ${(ask as UpdateAppAsk).app} ${(ask as UpdateAppAsk).fromVersion} → ${(ask as UpdateAppAsk).toVersion}`,
  };
  return descriptions[ask.kind]();
}

export const PublishDecision = z.object({
  decision: z.enum(['accept', 'decline']),
  reply: z.string().describe('What you tell the requesting owner, including why if you decline'),
});
export type PublishDecision = z.infer<typeof PublishDecision>;

export const OwnerDecision = z.object({
  decision: z.enum(['accept', 'decline']),
  reply: z.string().describe('What you tell the requesting owner, including why if you decline'),
  remote: z.string().describe('The remote to create on, when accepting'),
  image: z.string().describe('The image to use, when accepting; may differ from the ask if you have a reason'),
  nameSuffix: z.string().describe('Lowercase letters, digits and dashes; the runtime adds the onionsoup- prefix'),
});
export type OwnerDecision = z.infer<typeof OwnerDecision>;

export const RequestCheckpoint = z.object({
  jobId: z.number().optional(),
  instance: z.object({ remote: z.string(), name: z.string(), image: z.string() }).optional(),
  publication: z.object({ commit: z.string(), previous: z.string(), digest: z.string(), verifiedAt: z.string().optional() }).optional(),
});
export type RequestCheckpoint = z.infer<typeof RequestCheckpoint>;

export const ResourceRequest = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  ask: ResourceAsk,
  status: RequestStatus,
  reason: z.string().optional(),
  workItem: z.string().optional(),
  reconcileAfter: z.string().optional(),
  retry: z.object({ attempts: z.number().int().nonnegative(), nextAt: z.string() }).optional(),
  operation: z.object({
    id: z.string(), stage: RequestStatus, startedAt: z.string(), runner: z.number().optional(),
    checkpoint: RequestCheckpoint.optional(),
  }).optional(),
  recovery: z.array(z.object({ by: z.string(), action: z.string(), reason: z.string(), at: z.string() })).default([]),
  decision: OwnerDecision.optional(),
  publishDecision: PublishDecision.optional(),
  published: z.object({ commit: z.string(), previous: z.string(), at: z.string() }).optional(),
  instance: z.object({ remote: z.string(), name: z.string() }).optional(),
  leaseIncludesDelete: z.boolean().default(false),
  /** What the requesting owner does with the instance once it exists; see FOLLOW_UPS. */
  followUp: z.string(),
  followUpResult: z.object({ ok: z.boolean(), summary: z.string(), at: z.string() }).optional(),
  approvals: z.array(z.object({ step: z.enum(['create', 'delete']), by: z.string(), at: z.string() })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResourceRequest = z.infer<typeof ResourceRequest>;

export class Requests {
  constructor(readonly directory: string) {}

  async open(from: string, to: string, ask: ResourceAsk, followUp: string) {
    const now = new Date().toISOString();
    const request = ResourceRequest.parse({ id: `r-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`, from, to, ask, followUp, status: 'pending-owner', createdAt: now, updatedAt: now });
    return this.save(request);
  }

  async get(id: string) {
    return ResourceRequest.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
  }

  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const records = await Promise.allSettled(names.map(name => this.get(name.slice(0, -'.json'.length))));
    const requests: ResourceRequest[] = [];
    for (const [index, record] of records.entries()) {
      if (record.status === 'fulfilled') requests.push(record.value);
      else console.warn(`request_record_unreadable: ${names[index]}`);
    }
    return requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async withStatus(status: RequestStatus) {
    return (await this.list()).filter(request => request.status === status);
  }

  async save(request: ResourceRequest) {
    return withRecordLock(`${this.path(request.id)}.lock`, () => this.write(request));
  }

  async update(id: string, change: (current: ResourceRequest) => ResourceRequest) {
    return withRecordLock(`${this.path(id)}.lock`, async () => this.write(ResourceRequest.parse(change(await this.get(id)))));
  }

  private async write(request: ResourceRequest) {
    await mkdir(this.directory, { recursive: true });
    const updated = { ...request, updatedAt: new Date().toISOString() };
    const temporary = `${this.path(request.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path(request.id));
    return updated;
  }

  async checkpoint(id: string, checkpoint: RequestCheckpoint) {
    return this.update(id, request => {
      if (!request.operation) throw new Error(`request_operation_missing: ${id}`);
      return { ...request, operation: {
        ...request.operation, checkpoint: { ...request.operation.checkpoint, ...checkpoint },
      } };
    });
  }

  async markInterrupted() {
    const active = (await this.list()).filter(request => request.operation?.runner !== undefined && !requestRunnerIsAlive(request.operation.runner));
    for (const request of active) {
      await this.update(request.id, current => {
        if (current.operation?.runner === undefined || requestRunnerIsAlive(current.operation.runner)) return current;
        const operation = { ...current.operation, runner: undefined };
        // The step saved its next gate/result before its process died: preserve that durable transition.
        if (current.status !== operation.stage) return { ...current, operation };
        return { ...current, status: 'interrupted', reason: `request_interrupted: ${operation.stage}`, operation };
      });
    }
    return active.length;
  }

  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
}

export function requireStatus(request: ResourceRequest, status: RequestStatus) {
  if (request.status !== status) throw new Error(`request_not_${status}: ${request.id} is ${request.status}`);
}
