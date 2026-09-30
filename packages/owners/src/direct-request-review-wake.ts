import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { getDirectRequestReview } from './direct-request-plan-review.ts';
import { NOTICE_PREFIX } from './notices.ts';
import { nextMessageId, type PlanRevisionClient } from './plan-revision.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const DIRECT_REVIEW_WAKE_LIMITS = { perPass: 20 };
const Wake = z.object({
  request: z.string(), item: z.string(), reviewer: z.string(), digest: z.string(), origin: ChatOrigin.optional(),
  status: z.enum(['pending', 'sending', 'delivered', 'blocked', 'superseded']),
  reason: z.string().optional(), messageID: z.string().optional(),
});
type Wake = z.infer<typeof Wake>;
type Review = Awaited<ReturnType<typeof getDirectRequestReview>>;
const SCAN_AFTER = new Map<string, string>();
function wakePath(runtime: Runtime, request: string, digest: string) {
  const key = createHash('sha256').update(JSON.stringify([request, digest])).digest('hex');
  return join(runtime.stateDirectory, 'direct-request-review-wakes', `${key}.json`);
}
async function read(runtime: Runtime, request: string, digest: string) {
  const text = await readFile(wakePath(runtime, request, digest), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  return text ? Wake.parse(JSON.parse(text)) : undefined;
}
async function save(runtime: Runtime, wake: Wake) {
  const path = wakePath(runtime, wake.request, wake.digest);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(wake) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
async function prepare(runtime: Runtime, review: Review) {
  const path = wakePath(runtime, review.request.id, review.digest);
  return withRecordLock(`${path}.lock`, async () => {
    const existing = await read(runtime, review.request.id, review.digest);
    if (existing) return existing;
    const wake = Wake.parse({ request: review.request.id, item: review.item.id, reviewer: review.reviewer,
      digest: review.digest, origin: review.request.origin, status: 'pending' });
    await save(runtime, wake);
    return wake;
  });
}
async function change(runtime: Runtime, wake: Wake, status: Wake['status'], reason?: string) {
  return withRecordLock(`${wakePath(runtime, wake.request, wake.digest)}.lock`, async () => {
    const current = await read(runtime, wake.request, wake.digest);
    if (!current || ['delivered', 'superseded'].includes(current.status)) return;
    await save(runtime, { ...current, status, reason });
  });
}
function reviewPrompt(wake: Wake) {
  return `${NOTICE_PREFIX} Direct-request plan review for ${wake.request}, item ${wake.item}, binding ${wake.digest}. `
    + 'Read onionsoup_status request for the original request, constraints, current plan and exact binding before deciding. '
    + 'Use onionsoup_review_request_plan with that request, item and digest. This continuation requests a review, not an approval. '
    + 'Approval requires your existing applicable approve-plans grant and an explicit scope=matched assessment with a factual note. '
    + 'If the plan introduces extra work, unresolved assumptions or scope uncertainty, use decision=needs-human, scope=needs-human '
    + 'and explain the precise decision to the person; do not reinterpret uncertainty as authorization. '
    + 'Use revise for a smaller approach within the original request. Preserve the original goal and draft/merge boundaries. '
    + 'Human approval remains available in the inbox. An earlier informational notice or conversational promise is not authority.';
}
async function currentReview(runtime: Runtime, wake: Wake) {
  const review = await getDirectRequestReview(runtime, wake.request);
  if (review.digest !== wake.digest || review.item.id !== wake.item || review.reviewer !== wake.reviewer || review.reviewed) {
    throw new Error('direct_review_wake_superseded');
  }
  return review;
}
async function claim(runtime: Runtime, wake: Wake, observed: readonly string[]) {
  return withRecordLock(`${wakePath(runtime, wake.request, wake.digest)}.lock`, async () => {
    const current = await read(runtime, wake.request, wake.digest);
    if (!current || current.messageID || ['delivered', 'superseded'].includes(current.status)) return;
    await currentReview(runtime, current);
    const claimed = { ...current, status: 'sending' as const, reason: undefined, messageID: nextMessageId(observed) };
    await save(runtime, claimed);
    return claimed;
  });
}
async function deliver(runtime: Runtime, wake: Wake, client: PlanRevisionClient) {
  if (['delivered', 'superseded'].includes(wake.status)) return;
  const owner = runtime.declarations.owners.get(wake.reviewer);
  if (!wake.origin || !owner?.persona) return change(runtime, wake, 'blocked', 'direct_review_wake_origin_or_persona_missing');
  if (!await client.exists(wake.origin)) return change(runtime, wake, 'blocked', 'direct_review_wake_origin_unavailable');
  const observed = await client.messages(wake.origin);
  if (wake.messageID && observed.includes(wake.messageID)) return change(runtime, wake, 'delivered');
  // A missing transcript receipt after an attempted send cannot prove that retrying is safe.
  if (wake.messageID) return change(runtime, wake, 'blocked', 'direct_review_wake_delivery_uncertain');
  if (!await client.idle(wake.origin)) return;
  const claimed = await claim(runtime, wake, observed);
  if (!claimed) return;
  try {
    await currentReview(runtime, claimed);
  } catch {
    return change(runtime, claimed, 'superseded', 'direct_review_wake_no_longer_eligible');
  }
  try {
    await client.prompt(wake.origin, owner.persona.name, reviewPrompt(claimed), claimed.messageID);
    if ((await client.messages(wake.origin)).includes(claimed.messageID)) await change(runtime, claimed, 'delivered');
    else await change(runtime, claimed, 'blocked', 'direct_review_wake_delivery_uncertain');
  } catch {
    await change(runtime, claimed, 'blocked', 'direct_review_wake_delivery_uncertain');
  }
}

/** One continuation per exact request/plan generation; no informational notice becomes a model turn. */
export async function deliverDirectRequestReviews(runtime: Runtime, client: PlanRevisionClient,
  onError: (request: string, error: unknown) => void) {
  const requests = (await runtime.requests.list()).filter(request => request.ask.kind === 'work'
    && !request.ask.assignment && request.workItem && request.status === 'work-running').sort((left, right) => left.id.localeCompare(right.id));
  const boundary = requests.findIndex(request => request.id > (SCAN_AFTER.get(runtime.stateDirectory) ?? ''));
  const start = boundary < 0 ? 0 : boundary;
  const ordered = [...requests.slice(start), ...requests.slice(0, start)];
  for (const request of ordered.slice(0, DIRECT_REVIEW_WAKE_LIMITS.perPass)) {
    SCAN_AFTER.set(runtime.stateDirectory, request.id);
    try {
      const review = await getDirectRequestReview(runtime, request.id);
      if (review.reviewed) continue;
      await deliver(runtime, await prepare(runtime, review), client);
    } catch (error) {
      // Ordinary gates are visible through the status tool, not noisy retries or widened grants.
      if (error instanceof Error && /^(direct_plan_review_|not_awaiting_plan_approval:)/.test(error.message)) continue;
      onError(request.id, error);
    }
  }
}

export async function directRequestReviewWakeStatus(runtime: Runtime, request: string, digest: string) {
  const wake = await read(runtime, request, digest);
  return wake ? { status: wake.status, reason: wake.reason, messageID: wake.messageID } : undefined;
}
