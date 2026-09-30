import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AskWorkProposal } from './ask-handoffs.ts';
import { canChange } from './declarations.ts';
import { openOperatorWorkRequest, operatorWorkRequestId } from './delegation.ts';
import { FrictionRecord } from './friction.ts';
import { readFrictionTriage, type FrictionTriage } from './friction-work.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const FRICTION_PROMOTION_LIMITS = { retries: 3, perTick: 20, actorChars: 200 };
export const FrictionProposalDigest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.string().trim().min(1).max(FRICTION_PROMOTION_LIMITS.actorChars);
const Promotion = z.object({ version: z.literal(1), id: FrictionRecord.shape.id, digest: FrictionProposalDigest,
  by: actor, at: z.string().datetime(), owner: z.string().min(1), proposal: AskWorkProposal,
  requestID: z.string().regex(/^r-handoff-[a-f0-9]{64}$/),
  retry: z.object({ by: actor, at: z.string().datetime() }).optional(),
  state: z.enum(['pending', 'routed', 'blocked']), attempts: z.number().int().nonnegative(), reason: z.string().optional(),
}).strict();
type Promotion = z.infer<typeof Promotion>;
export interface FrictionPromotionView {
  owner: string; by: string; at: string; digest: string; requestID: string; status: string; reason?: string; workItem?: string;
}
function directory(runtime: Runtime) { return join(runtime.stateDirectory, 'friction', 'promotions'); }
function path(runtime: Runtime, id: string) {
  FrictionRecord.shape.id.parse(id);
  return join(directory(runtime), `${id}.json`);
}
async function read(runtime: Runtime, id: string) {
  const contents = await readFile(path(runtime, id), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!contents) return undefined;
  const promotion = Promotion.parse(JSON.parse(contents));
  if (promotion.id !== id) throw new Error('friction_promotion_identity_mismatch');
  return promotion;
}
async function save(runtime: Runtime, promotion: Promotion) {
  await mkdir(directory(runtime), { recursive: true });
  const temporary = `${path(runtime, promotion.id)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(Promotion.parse(promotion)) + '\n', { mode: 0o600 });
  await rename(temporary, path(runtime, promotion.id));
}

/** Binds a human decision to exactly the displayed investigation and its configured recipient. */
export function frictionProposalDigest(triage: FrictionTriage) {
  if (triage.state !== 'investigated' || triage.investigation?.disposition !== 'propose-fix'
    || !triage.investigation.proposedWork) return undefined;
  return createHash('sha256').update(JSON.stringify({ id: triage.id, owner: triage.policy.owner,
    repository: triage.policy.repository, sourceCommit: triage.sourceCommit, investigation: triage.investigation })).digest('hex');
}

const INVALID = new Set(['owner_cannot_change', 'not_your_repository', 'not_a_repository_owner', 'which_repository',
  'unknown owner', 'request_identity_conflict']);
async function route(runtime: Runtime, id: string) {
  return withRecordLock(`${path(runtime, id)}.lock`, async () => {
    const promotion = await read(runtime, id);
    if (!promotion) throw new Error('friction_promotion_missing');
    const existing = await runtime.requests.get(promotion.requestID).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!existing && promotion.state === 'routed') throw new Error('friction_promotion_request_missing');
    if (!existing && promotion.state === 'blocked') throw new Error(promotion.reason ?? 'friction_promotion_blocked');
    try {
      const request = await openOperatorWorkRequest(runtime, { kind: 'friction', id }, promotion.by, promotion.owner, promotion.proposal);
      await save(runtime, { ...promotion, state: 'routed', reason: undefined });
      return request;
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : '';
      const reason = INVALID.has(code) ? code : 'friction_promotion_routing_failed';
      const attempts = promotion.attempts + 1;
      await save(runtime, { ...promotion, attempts, reason,
        state: INVALID.has(code) || attempts >= FRICTION_PROMOTION_LIMITS.retries ? 'blocked' : 'pending' });
      throw new Error(reason);
    }
  });
}

/** Only an explicit human action calls this. Reading or investigating friction never promotes it. */
export async function promoteFriction(runtime: Runtime, id: string, expectedDigest: string, by: string) {
  const digest = FrictionProposalDigest.parse(expectedDigest);
  const person = actor.parse(by);
  await withRecordLock(`${path(runtime, id)}.lock`, async () => {
    const previous = await read(runtime, id);
    if (previous) {
      if (previous.digest !== digest) throw new Error('friction_promotion_conflict');
      return;
    }
    const triage = await readFrictionTriage(runtime, id);
    if (!triage || !frictionProposalDigest(triage)) throw new Error('friction_proposal_unavailable');
    if (frictionProposalDigest(triage) !== digest) throw new Error('friction_proposal_stale');
    const proposal = AskWorkProposal.parse(triage.investigation!.proposedWork);
    if (proposal.repository !== triage.policy.repository) throw new Error('friction_triage_wrong_repository');
    if (!canChange(runtime.owner(triage.policy.owner))) throw new Error('owner_cannot_change');
    runtime.repositoryOwner(triage.policy.owner, proposal.repository);
    await save(runtime, { version: 1, id, digest, by: person, at: new Date().toISOString(), owner: triage.policy.owner,
      proposal, requestID: operatorWorkRequestId({ kind: 'friction', id }), state: 'pending', attempts: 0 });
  });
  return route(runtime, id);
}

/** Explicit human retry replenishes only routing attempts, never the request or its execution state. */
export async function retryFrictionPromotion(runtime: Runtime, id: string, expectedDigest: string, by: string) {
  const digest = FrictionProposalDigest.parse(expectedDigest);
  const person = actor.parse(by);
  await withRecordLock(`${path(runtime, id)}.lock`, async () => {
    const promotion = await read(runtime, id);
    if (!promotion) throw new Error('friction_promotion_missing');
    if (promotion.digest !== digest) throw new Error('friction_promotion_conflict');
    const existing = await runtime.requests.get(promotion.requestID).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing || promotion.state !== 'blocked') return;
    if (!canChange(runtime.owner(promotion.owner))) throw new Error('owner_cannot_change');
    runtime.repositoryOwner(promotion.owner, promotion.proposal.repository);
    await save(runtime, { ...promotion, state: 'pending', attempts: 0, reason: undefined,
      retry: { by: person, at: new Date().toISOString() } });
  });
  return route(runtime, id);
}

export async function frictionPromotionView(runtime: Runtime, id: string): Promise<FrictionPromotionView | undefined> {
  const promotion = await read(runtime, id);
  if (!promotion) return undefined;
  const request = await runtime.requests.get(promotion.requestID).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  const missing = !request && promotion.state === 'routed';
  return { owner: promotion.owner, by: promotion.by, at: promotion.at, digest: promotion.digest, requestID: promotion.requestID,
    status: missing ? 'blocked' : request?.status ?? promotion.state,
    reason: missing ? 'friction_promotion_request_missing' : request?.reason ?? promotion.reason, workItem: request?.workItem };
}

/** Recover only explicit saved intents; never scan investigations for inferred consent. */
export async function recoverFrictionPromotions(runtime: Runtime, onError: (id: string, error: unknown) => void) {
  const names = await readdir(directory(runtime)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  let attempts = 0;
  for (const name of names.filter(name => /^fr_[a-f0-9]{24}\.json$/.test(name))) {
    const id = name.slice(0, -5);
    try {
      const promotion = await read(runtime, id);
      if (promotion?.state !== 'pending') continue;
      if (attempts++ >= FRICTION_PROMOTION_LIMITS.perTick) break;
      await route(runtime, id);
    } catch (error) { onError(id, error); }
  }
}
