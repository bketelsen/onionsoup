import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { DirectRequestPlanReview } from './direct-request-plan-review-types.ts';
import { validateDirectRequestPlanReview } from './direct-request-plan-review.ts';
import { HumanNote, type WorkItem } from './ledger.ts';
import { NOTICE_PREFIX } from './notices.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { withRecordLock } from './record-lock.ts';
import { requestRunnerIsAlive, type ResourceRequest } from './requests.ts';
import type { Runtime } from './runtime.ts';

export const PLAN_REVISION_LIMITS = { perPass: 20, textChars: 8_000 };
export const Revision = z.object({
  id: z.string(), messageID: z.string().optional(), item: z.string(), owner: z.string(), expected: z.string(), plan: z.string(),
  feedback: z.string(), note: HumanNote, origin: ChatOrigin.optional(),
  directReview: DirectRequestPlanReview.optional(),
  status: z.enum(['prepared', 'pending', 'sending', 'delivered', 'blocked', 'suppressed']),
  reason: z.string().optional(), runner: z.number().optional(), submitted: z.boolean().default(false), journaled: z.boolean().default(false),
});
type Revision = z.infer<typeof Revision>;
// Scheduling hint only; authoritative delivery state remains on disk.
const SCAN_AFTER = new Map<string, string>();
const PRE_SEND_BLOCKERS = new Set(['plan_revision_owner_retired', 'plan_revision_owner_has_no_persona',
  'plan_revision_origin_missing', 'plan_revision_origin_unavailable']);
function submissionAttempted(record: Revision) {
  return record.submitted || record.status === 'sending' || record.reason === 'plan_revision_delivery_uncertain';
}
function receiptId(record: Revision) {
  // Already-submitted sidecars from the first format retain their original receipt identity.
  return record.messageID ?? (submissionAttempted(record) ? record.id : undefined);
}
/** Native ascending format: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/id/id.ts */
export function nextMessageId(observed: readonly string[]) {
  let timestamp = (BigInt(Date.now()) * 0x1000n) & 0xffffffffffffn;
  for (const id of observed) {
    const match = /^msg_([a-f0-9]{12})[a-zA-Z0-9]{14}$/.exec(id);
    if (match) {
      const previous = BigInt(`0x${match[1]}`);
      if (previous >= timestamp) timestamp = previous + 1n;
    }
  }
  if (timestamp > 0xffffffffffffn) throw new Error('plan_revision_message_id_exhausted');
  return `msg_${timestamp.toString(16).padStart(12, '0')}${randomBytes(7).toString('hex')}`;
}
export interface PlanRevisionClient {
  exists(origin: ChatOrigin): Promise<boolean>;
  messages(origin: ChatOrigin): Promise<readonly string[]>;
  idle(origin: ChatOrigin): Promise<boolean>;
  prompt(origin: ChatOrigin, agent: string, text: string, messageID: string): Promise<void>;
}
function directory(runtime: Runtime) { return join(runtime.stateDirectory, 'plan-revisions'); }
function path(runtime: Runtime, item: string) { return join(directory(runtime), `${createHash('sha256').update(item).digest('hex')}.json`); }
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function plan(item: WorkItem) { return digest([item.proposal, item.planDocument, item.plan]); }
function expected(item: WorkItem) { return digest([item.owner, item.status, plan(item), item.humanNotes, item.activeRunner]); }
function wasApplied(item: WorkItem, record: Revision) {
  return item.humanNotes.some(note => JSON.stringify(note) === JSON.stringify(record.note));
}
async function read(runtime: Runtime, item: string) {
  const contents = await readFile(path(runtime, item), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  return contents ? Revision.parse(JSON.parse(contents)) : undefined;
}
async function save(runtime: Runtime, record: Revision) {
  await mkdir(directory(runtime), { recursive: true });
  const temporary = `${path(runtime, record.item)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  await rename(temporary, path(runtime, record.item));
}
function directReviewDenied(error: unknown) {
  return error instanceof Error && (error.message.startsWith('direct_plan_review_') || error.message.startsWith('not_awaiting_plan_approval'));
}

async function applyRevision(runtime: Runtime, record: Revision, request?: ResourceRequest) {
  return runtime.ledger.updateIfChanged(record.item, async current => {
    if (wasApplied(current, record)) return undefined;
    if (expected(current) !== record.expected) throw new Error('plan_revision_superseded');
    let directReview = record.directReview;
    if (directReview) {
      if (!request) throw new Error('direct_plan_review_binding_mismatch');
      const binding = await validateDirectRequestPlanReview(runtime, request, current, directReview);
      directReview = { ...directReview, grantTarget: binding.grant.target };
    }
    const directRequestPlanReviews = directReview
      ? [...current.directRequestPlanReviews, directReview] : current.directRequestPlanReviews;
    return { ...current, status: 'planning', reason: undefined, directRequestPlanReviews,
      humanNotes: [...current.humanNotes, record.note] };
  });
}

async function apply(runtime: Runtime, record: Revision) {
  const item = record.directReview
    ? await runtime.requests.inspectLocked(record.directReview.request, request => applyRevision(runtime, record, request))
    : await applyRevision(runtime, record);
  await save(runtime, { ...record, status: 'pending' });
  return item;
}

/** Persist feedback delivery intent before changing the work state. Same submission is replayable. */
export async function queuePlanRevision(runtime: Runtime, itemId: string, by: string, feedback: string, directReview?: DirectRequestPlanReview) {
  const noteText = z.string().trim().min(1).max(PLAN_REVISION_LIMITS.textChars).parse(feedback);
  return withRecordLock(`${path(runtime, itemId)}.lock`, async () => {
    const item = await runtime.ledger.get(itemId);
    const previous = await read(runtime, itemId);
    if (previous && previous.note.by === by && previous.feedback === noteText && plan(item) === previous.plan
      && wasApplied(item, previous) && item.status === 'planning'
      && (!directReview || item.directRequestPlanReviews.some(review => review.digest === directReview.digest))) return item;
    if (item.status !== 'awaiting-plan-approval' || item.activeRunner) throw new Error(`not_awaiting_plan_approval: ${item.status}`);
    if (item.workflow !== OWNER_CHANGE_WORKFLOW) throw new Error('not_an_owner_plan');
    if (previous?.status === 'sending') throw new Error('plan_revision_delivery_in_progress');
    const record = Revision.parse({ id: `msg_${randomUUID().replaceAll('-', '')}`, item: itemId, owner: item.owner,
      expected: expected(item), plan: plan(item), feedback: noteText,
      note: { kind: 'plan-feedback', by, at: new Date().toISOString(), note: noteText },
      origin: item.session ?? item.origin, status: 'prepared', directReview });
    await save(runtime, record);
    try {
      return await apply(runtime, record);
    } catch (error) {
      if (directReview && directReviewDenied(error)) await save(runtime, { ...record, status: 'suppressed', reason: String(error) });
      throw error;
    }
  });
}

/** Small public projection exposes safe stopping reasons without copying feedback or transcript data. */
export async function planRevisionStatus(runtime: Runtime, itemId: string) {
  const record = await read(runtime, itemId);
  return record ? { status: record.status, reason: record.reason, messageID: receiptId(record) } : undefined;
}

async function change(runtime: Runtime, record: Revision, status: Revision['status'], reason?: string) {
  return withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
    const current = await read(runtime, record.item);
    if (current?.id !== record.id || ['delivered', 'suppressed'].includes(current.status)) return;
    if (current.status === status && current.reason === reason && !current.runner) return;
    await save(runtime, { ...current, status, reason, runner: undefined, submitted: submissionAttempted(current) || submissionAttempted(record) });
  });
}
function ineligible(item: WorkItem, record: Revision) {
  if (item.status === 'cancelled') return 'plan_revision_cancelled';
  if (item.owner !== record.owner || item.status !== 'planning' || !wasApplied(item, record) || plan(item) !== record.plan) return 'plan_revision_superseded';
  return undefined;
}
async function prepareDelivery(runtime: Runtime, record: Revision) {
  if (record.status === 'prepared') {
    await withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
      const current = await read(runtime, record.item);
      if (current?.id !== record.id || current.status !== 'prepared') return;
      try { await apply(runtime, current); } catch (error) {
        const superseded = error instanceof Error && error.message === 'plan_revision_superseded';
        if (!superseded && !(current.directReview && directReviewDenied(error))) throw error;
        await save(runtime, { ...current, status: 'suppressed', reason: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  const item = await runtime.ledger.get(record.item);
  const reason = ineligible(item, record);
  if (reason) { await change(runtime, record, 'suppressed', reason); return undefined; }
  const owner = runtime.declarations.owners.get(record.owner);
  const origin = record.origin ?? (!submissionAttempted(record) ? item.session ?? item.origin : undefined);
  const blocker = !owner ? 'plan_revision_owner_retired' : !owner.persona ? 'plan_revision_owner_has_no_persona'
    : !origin ? 'plan_revision_origin_missing' : undefined;
  if (blocker) { await change(runtime, record, 'blocked', blocker); return undefined; }
  return { item, agent: owner!.persona!.name, origin: origin! };
}
/** Only prerequisites that failed before any submission may resume automatically. */
async function readyAfterBlock(runtime: Runtime, record: Revision, origin: ChatOrigin) {
  await withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
    const current = await read(runtime, record.item);
    if (current?.id !== record.id || submissionAttempted(current)) return;
    const mayResume = current.status === 'blocked' && PRE_SEND_BLOCKERS.has(current.reason ?? '');
    if (!mayResume && !['pending', 'prepared'].includes(current.status)) return;
    if (current.origin && !mayResume) return;
    await save(runtime, { ...current, origin, status: 'pending', reason: undefined });
  });
}

async function deliverOne(runtime: Runtime, record: Revision, client: PlanRevisionClient) {
  const prepared = await prepareDelivery(runtime, record);
  if (!prepared) return;
  const { item, agent, origin } = prepared;
  if (!await client.exists(origin)) return change(runtime, record, 'blocked',
    submissionAttempted(record) ? 'plan_revision_delivery_uncertain' : 'plan_revision_origin_unavailable');
  const observed = await client.messages(origin);
  const receipt = receiptId(record);
  if (receipt && observed.includes(receipt)) return change(runtime, record, 'delivered');
  if (submissionAttempted(record)) {
    if (record.runner && requestRunnerIsAlive(record.runner)) return;
    return change(runtime, record, 'blocked', 'plan_revision_delivery_uncertain');
  }
  await readyAfterBlock(runtime, record, origin);
  if (!await client.idle(origin)) return;
  const claimed = await withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
    const current = await read(runtime, record.item);
    if (current?.id !== record.id || submissionAttempted(current) || !['pending', 'prepared'].includes(current.status)) return undefined;
    if (ineligible(await runtime.ledger.get(record.item), current)) return undefined;
    const claimed = { ...current, status: 'sending' as const, runner: process.pid, submitted: true,
      messageID: current.messageID ?? nextMessageId(observed) };
    await save(runtime, claimed);
    return claimed;
  });
  if (!claimed) return;
  const text = `${NOTICE_PREFIX} ${record.note.by} requests another approach for ${item.id} "${item.proposal.title}": ${record.feedback}. Keep the goal. Revise and submit again with onionsoup_submit_plan item "${item.id}". Existing approval gates still apply.`;
  try {
    await client.prompt(origin, agent, text, claimed.messageID);
    // promptAsync receipt alone is not proof that the transcript accepted the message.
    if ((await client.messages(origin)).includes(claimed.messageID)) await change(runtime, claimed, 'delivered');
    else await change(runtime, record, 'blocked', 'plan_revision_delivery_uncertain');
  } catch {
    await change(runtime, record, 'blocked', 'plan_revision_delivery_uncertain');
  }
}

/** Journal failure never strands delivery; terminal records remain eligible for journal repair. */
async function journalFeedback(runtime: Runtime, record: Revision) {
  if (record.journaled) return;
  const applied = wasApplied(await runtime.ledger.get(record.item), record);
  if (applied) await runtime.notebook(record.owner).journalOnce({ kind: 'plan-feedback', workItem: record.item,
    note: `${record.note.by}: ${record.feedback}`, source: `plan-revision:${digest([record.item, record.note])}` }, record.note.at);
  await withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
    const current = await read(runtime, record.item);
    if (current?.id === record.id) await save(runtime, { ...current, journaled: true });
  });
}

/** Called under plugin admission. Network calls never hold record locks; uncertain sends never blindly repeat. */
export async function deliverPlanRevisions(runtime: Runtime, client: PlanRevisionClient,
  onError: (id: string, error: unknown) => void) {
  const names = await readdir(directory(runtime)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError('plan-revisions', error);
    return [];
  });
  const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  const boundary = files.findIndex(name => name > (SCAN_AFTER.get(runtime.stateDirectory) ?? ''));
  const start = boundary < 0 ? 0 : boundary;
  const ordered = [...files.slice(start), ...files.slice(0, start)];
  let count = 0;
  for (const name of ordered) {
    try {
      const record = Revision.parse(JSON.parse(await readFile(join(directory(runtime), name), 'utf8')));
      const terminal = ['delivered', 'suppressed'].includes(record.status);
      if (terminal && record.journaled) continue;
      if (count++ >= PLAN_REVISION_LIMITS.perPass) break;
      SCAN_AFTER.set(runtime.stateDirectory, name);
      if (!terminal) await deliverOne(runtime, record, client);
      await journalFeedback(runtime, record);
    } catch (error) { onError(name, error); }
  }
}
