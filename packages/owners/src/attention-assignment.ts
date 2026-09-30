import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { listAttention } from './attention.ts';
import { ProposedWork } from './artifacts.ts';
import { canChange } from './declarations.ts';
import { openOperatorWorkRequest, operatorWorkRequestId } from './delegation.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const ATTENTION_ASSIGNMENT_LIMITS = { textChars: 4_000, criteria: 12, retries: 3, perTick: 20 };
const text = z.string().trim().min(1).max(ATTENTION_ASSIGNMENT_LIMITS.textChars);
export const AttentionAssignmentInput = z.object({ owner: text, repository: text, title: text, goal: text,
  acceptance: z.array(text).min(1).max(ATTENTION_ASSIGNMENT_LIMITS.criteria) });
export type AttentionAssignmentInput = z.infer<typeof AttentionAssignmentInput>;
const Assignment = z.object({ version: z.literal(1), attention: text, sourceOwner: text, by: text, at: z.string(),
  input: AttentionAssignmentInput, proposal: ProposedWork, requestID: z.string().regex(/^r-handoff-[a-f0-9]{64}$/),
  status: z.enum(['pending', 'routed', 'blocked']), attempts: z.number().int().nonnegative(), reason: z.string().optional() });
type Assignment = z.infer<typeof Assignment>;
export interface AttentionAssignmentView { owner: string; by: string; requestID: string; status: string; reason?: string; workItem?: string }
function directory(runtime: Runtime) { return join(runtime.stateDirectory, 'attention', 'assignments'); }
function path(runtime: Runtime, id: string) { return join(directory(runtime), `${createHash('sha256').update(id).digest('hex')}.json`); }
async function read(runtime: Runtime, id: string) {
  const contents = await readFile(path(runtime, id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  return contents ? Assignment.parse(JSON.parse(contents)) : undefined;
}
async function save(runtime: Runtime, assignment: Assignment) {
  await mkdir(directory(runtime), { recursive: true });
  const temporary = `${path(runtime, assignment.attention)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(assignment) + '\n', { mode: 0o600 });
  await rename(temporary, path(runtime, assignment.attention));
}
function validateTarget(runtime: Runtime, input: AttentionAssignmentInput) {
  if (!canChange(runtime.owner(input.owner))) throw new Error(`owner_cannot_change: ${input.owner}`);
  runtime.repositoryOwner(input.owner, input.repository);
}
const INVALID = new Set(['owner_cannot_change', 'not_your_repository', 'not_a_repository_owner', 'which_repository', 'unknown owner', 'request_identity_conflict']);

async function route(runtime: Runtime, id: string) {
  return withRecordLock(`${path(runtime, id)}.lock`, async () => {
    const assignment = await read(runtime, id);
    if (!assignment) throw new Error('attention_assignment_missing');
    if (assignment.status === 'routed') return runtime.requests.get(assignment.requestID);
    if (assignment.status === 'blocked') throw new Error(assignment.reason ?? 'attention_assignment_blocked');
    try {
      const request = await openOperatorWorkRequest(runtime, { kind: 'attention', id }, assignment.by, assignment.input.owner, assignment.proposal);
      await save(runtime, { ...assignment, status: 'routed' });
      return request;
    } catch (error) {
      const reason = error instanceof Error ? error.message.split(':')[0] : 'attention_assignment_failed';
      const attempts = assignment.attempts + 1;
      await save(runtime, { ...assignment, attempts, reason,
        status: INVALID.has(reason) || attempts >= ATTENTION_ASSIGNMENT_LIMITS.retries ? 'blocked' : 'pending' });
      throw error;
    }
  });
}

/** This is a separate explicit action; seeing/resolving attention never calls it. */
export async function assignAttention(runtime: Runtime, id: string, input: AttentionAssignmentInput, by: string) {
  const parsed = AttentionAssignmentInput.parse(input);
  const actor = text.parse(by);
  await withRecordLock(`${path(runtime, id)}.lock`, async () => {
    const existing = await read(runtime, id);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(parsed)) throw new Error('attention_assignment_conflict');
      return;
    }
    const attention = (await listAttention(runtime)).find(entry => entry.id === id);
    if (!attention) throw new Error('attention_not_found');
    if (attention.status === 'resolved') throw new Error('attention_already_resolved');
    validateTarget(runtime, parsed);
    const proposal = ProposedWork.parse({ ...parsed, size: 'small', rationale: `Explicit assignment of ${id}, reported by ${attention.owner}: ${attention.note}` });
    await save(runtime, Assignment.parse({ version: 1, attention: id, sourceOwner: attention.owner, by: actor,
      at: new Date().toISOString(), input: parsed, proposal, requestID: operatorWorkRequestId({ kind: 'attention', id }),
      status: 'pending', attempts: 0 }));
  });
  return route(runtime, id);
}

export async function attentionAssignmentView(runtime: Runtime, id: string): Promise<AttentionAssignmentView | undefined> {
  const assignment = await read(runtime, id);
  if (!assignment) return undefined;
  const request = await runtime.requests.get(assignment.requestID).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  return { owner: assignment.input.owner, by: assignment.by, requestID: assignment.requestID,
    status: request?.status ?? assignment.status, reason: request?.reason ?? assignment.reason, workItem: request?.workItem };
}
export function attentionAssignmentTargets(runtime: Runtime) {
  return [...runtime.declarations.owners.values()].filter(canChange).flatMap(owner =>
    runtime.repositoryViews(owner.id).map(view => ({ owner: owner.id, repository: view.domain.name })));
}
export async function recoverAttentionAssignments(runtime: Runtime, onError: (id: string, error: unknown) => void) {
  const names = await readdir(directory(runtime)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  });
  let attempts = 0;
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    try {
      const assignment = Assignment.parse(JSON.parse(await readFile(join(directory(runtime), name), 'utf8')));
      if (assignment.status !== 'pending') continue;
      if (attempts++ >= ATTENTION_ASSIGNMENT_LIMITS.perTick) break;
      await route(runtime, assignment.attention);
    } catch (error) { onError(name, error); }
  }
}
