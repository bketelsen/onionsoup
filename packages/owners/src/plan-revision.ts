import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import { HumanNote, type WorkItem } from './ledger.ts';
import { NOTICE_PREFIX } from './notices.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { withRecordLock } from './record-lock.ts';
import { requestRunnerIsAlive } from './requests.ts';
import type { Runtime } from './runtime.ts';

export const PLAN_REVISION_LIMITS = { perPass: 20, textChars: 8_000 };
const Revision = z.object({
  id: z.string(), item: z.string(), owner: z.string(), expected: z.string(), plan: z.string(),
  feedback: z.string(), note: HumanNote, origin: ChatOrigin.optional(),
  status: z.enum(['prepared', 'pending', 'sending', 'delivered', 'blocked', 'suppressed']),
  reason: z.string().optional(), runner: z.number().optional(),
});
type Revision = z.infer<typeof Revision>;
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
async function apply(runtime: Runtime, record: Revision) {
  const item = await runtime.ledger.update(record.item, current => {
    if (wasApplied(current, record)) return current;
    if (expected(current) !== record.expected) throw new Error('plan_revision_superseded');
    return { ...current, status: 'planning', reason: undefined, humanNotes: [...current.humanNotes, record.note] };
  });
  await save(runtime, { ...record, status: 'pending' });
  return item;
}

/** Persist feedback delivery intent before changing the work state. Same submission is replayable. */
export async function queuePlanRevision(runtime: Runtime, itemId: string, by: string, feedback: string) {
  const noteText = z.string().trim().min(1).max(PLAN_REVISION_LIMITS.textChars).parse(feedback);
  return withRecordLock(`${path(runtime, itemId)}.lock`, async () => {
    const item = await runtime.ledger.get(itemId);
    const previous = await read(runtime, itemId);
    if (previous && previous.note.by === by && previous.feedback === noteText && plan(item) === previous.plan
      && wasApplied(item, previous) && item.status === 'planning') return item;
    if (item.status !== 'awaiting-plan-approval' || item.activeRunner) throw new Error(`not_awaiting_plan_approval: ${item.status}`);
    if (item.workflow !== OWNER_CHANGE_WORKFLOW) throw new Error('not_an_owner_plan');
    if (previous?.status === 'sending') throw new Error('plan_revision_delivery_in_progress');
    const record = Revision.parse({ id: `msg_${randomUUID().replaceAll('-', '')}`, item: itemId, owner: item.owner,
      expected: expected(item), plan: plan(item), feedback: noteText,
      note: { kind: 'plan-feedback', by, at: new Date().toISOString(), note: noteText },
      origin: item.session ?? item.origin, status: 'prepared' });
    await save(runtime, record);
    return apply(runtime, record);
  });
}

/** Small public projection exposes safe stopping reasons without copying feedback or transcript data. */
export async function planRevisionStatus(runtime: Runtime, itemId: string) {
  const record = await read(runtime, itemId);
  return record ? { status: record.status, reason: record.reason, messageID: record.id } : undefined;
}

async function change(runtime: Runtime, record: Revision, status: Revision['status'], reason?: string) {
  return withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
    const current = await read(runtime, record.item);
    if (current?.id !== record.id) return;
    if (current.status === status && current.reason === reason && !current.runner) return;
    await save(runtime, { ...current, status, reason, runner: undefined });
  });
}
function ineligible(item: WorkItem, record: Revision) {
  if (item.status === 'cancelled') return 'plan_revision_cancelled';
  if (item.status !== 'planning' || !wasApplied(item, record) || plan(item) !== record.plan) return 'plan_revision_superseded';
  return undefined;
}
async function prepareDelivery(runtime: Runtime, record: Revision) {
  if (record.status === 'prepared') {
    await withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
      const current = await read(runtime, record.item);
      if (current?.id !== record.id || current.status !== 'prepared') return;
      try { await apply(runtime, current); } catch (error) {
        if (!(error instanceof Error) || error.message !== 'plan_revision_superseded') throw error;
        await save(runtime, { ...current, status: 'suppressed', reason: 'plan_revision_superseded' });
      }
    });
  }
  const item = await runtime.ledger.get(record.item);
  const reason = ineligible(item, record);
  if (reason) { await change(runtime, record, 'suppressed', reason); return undefined; }
  const owner = runtime.declarations.owners.get(record.owner);
  const blocker = !owner ? 'plan_revision_owner_retired' : !owner.persona ? 'plan_revision_owner_has_no_persona'
    : !record.origin ? 'plan_revision_origin_missing' : undefined;
  if (blocker) { await change(runtime, record, 'blocked', blocker); return undefined; }
  return { item, agent: owner!.persona!.name, origin: record.origin! };
}
async function deliverOne(runtime: Runtime, record: Revision, client: PlanRevisionClient) {
  const prepared = await prepareDelivery(runtime, record);
  if (!prepared) return;
  const { item, agent, origin } = prepared;
  if (!await client.exists(origin)) return change(runtime, record, 'blocked', 'plan_revision_origin_unavailable');
  if ((await client.messages(origin)).includes(record.id)) return change(runtime, record, 'delivered');
  if (record.status === 'sending') {
    if (record.runner && requestRunnerIsAlive(record.runner)) return;
    return change(runtime, record, 'blocked', 'plan_revision_delivery_uncertain');
  }
  if (!await client.idle(origin)) return;
  const claimed = await withRecordLock(`${path(runtime, record.item)}.lock`, async () => {
    const current = await read(runtime, record.item);
    if (current?.id !== record.id || !['pending', 'prepared'].includes(current.status)) return false;
    if (ineligible(await runtime.ledger.get(record.item), current)) return false;
    await save(runtime, { ...current, status: 'sending', runner: process.pid });
    return true;
  });
  if (!claimed) return;
  const text = `${NOTICE_PREFIX} ${record.note.by} requests another approach for ${item.id} "${item.proposal.title}": ${record.feedback}. Keep the goal. Revise and submit again with onionsoup_submit_plan item "${item.id}". Existing approval gates still apply.`;
  try {
    await client.prompt(origin, agent, text, record.id);
    // promptAsync receipt alone is not proof that the transcript accepted the message.
    if ((await client.messages(origin)).includes(record.id)) await change(runtime, record, 'delivered');
    else await change(runtime, record, 'blocked', 'plan_revision_delivery_uncertain');
  } catch {
    await change(runtime, record, 'blocked', 'plan_revision_delivery_uncertain');
  }
}

/** Called under plugin admission. Network calls never hold record locks; uncertain sends never blindly repeat. */
export async function deliverPlanRevisions(runtime: Runtime, client: PlanRevisionClient,
  onError: (id: string, error: unknown) => void) {
  const names = await readdir(directory(runtime)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  });
  let count = 0;
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    try {
      const record = Revision.parse(JSON.parse(await readFile(join(directory(runtime), name), 'utf8')));
      if (['delivered', 'suppressed'].includes(record.status)) continue;
      if (record.status === 'blocked' && record.reason !== 'plan_revision_delivery_uncertain') {
        await prepareDelivery(runtime, record);
        continue;
      }
      if (count++ >= PLAN_REVISION_LIMITS.perPass) break;
      // Uncertain delivery may reconcile a later transcript receipt, but must never resubmit.
      const candidate = record.status === 'blocked' ? { ...record, status: 'sending' as const, runner: undefined } : record;
      await deliverOne(runtime, candidate, client);
    } catch (error) { onError(name, error); }
  }
}
