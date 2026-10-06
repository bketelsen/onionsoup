import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { z } from 'zod';
import { AttentionCondition, AttentionProvenance, parseJournalRecord, type JournalRecord } from './journal-record.ts';
import { reconcileAttention } from './attention-routing.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const ATTENTION_LIMITS = { initialHistoryDays: 7, scanBytesPerFile: 1_048_576 };
export const Attention = z.object({
  id: z.string(), owner: z.string(), note: z.string(), at: z.string(),
  status: z.enum(['open', 'acknowledged', 'resolved']).default('open'),
  condition: AttentionCondition.extend({ observedAt: z.string().datetime() }).optional(),
  provenance: AttentionProvenance.optional(),
  journal: z.object({ file: z.string(), line: z.number().int().nonnegative() }).optional(),
  workItem: z.string().optional(),
  outcome: z.string().optional(),
  resolution: z.object({ code: z.string(), at: z.string().datetime() }).optional(),
  decision: z.object({ by: z.string(), reason: z.string(), at: z.string() }).optional(),
});
export type Attention = z.infer<typeof Attention>;
const Cursor = z.object({ offset: z.number(), line: z.number(), size: z.number(), complete: z.boolean() });
const AttentionIndex = z.object({
  routingVersion: z.number().int().nonnegative().default(0),
  cutoff: z.string(),
  cursors: z.record(z.string(), Cursor),
  entries: z.record(z.string(), Attention),
});
type AttentionIndex = z.infer<typeof AttentionIndex>;
const CACHE = new Map<string, { stamp: string; index: AttentionIndex }>();
const ACTORS = new WeakMap<object, { owner?: string; runtime?: Runtime }>();
export interface AttentionActor {
  readonly by: string;
}

/** Trusted surface/CLI entrypoints only; never exposed as a model tool argument. */
export function humanAttentionActor(): AttentionActor {
  const actor = Object.freeze({ by: userInfo().username });
  ACTORS.set(actor, {});
  return actor;
}

/** The plugin supplies its authenticated owner, not a tool-selected role or label. */
export function ownerAttentionActor(runtime: Runtime, owner: string): AttentionActor {
  runtime.owner(owner);
  const actor = Object.freeze({ by: `owner:${owner}` });
  ACTORS.set(actor, { owner, runtime });
  return actor;
}

function requireAttentionActor(runtime: Runtime, actor: AttentionActor, entry: Attention) {
  const binding = typeof actor === 'object' && actor !== null ? ACTORS.get(actor) : undefined;
  if (!binding) throw new Error('attention_actor_required');
  if (!binding.owner) return;
  if (binding.runtime !== runtime || binding.owner !== entry.owner) throw new Error('attention_not_yours');
  runtime.owner(binding.owner);
  if (!entry.provenance || entry.provenance.kind === 'human-decision') {
    throw new Error('attention_human_decision_required');
  }
}

function indexPath(runtime: Runtime) {
  return join(runtime.stateDirectory, 'attention', 'index.json');
}

async function fileStamp(path: string) {
  const details = await stat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  return details ? `${details.mtimeMs}:${details.size}` : '';
}

async function readIndex(runtime: Runtime) {
  const path = indexPath(runtime);
  const stamp = await fileStamp(path);
  const cached = CACHE.get(path);
  if (stamp && cached?.stamp === stamp) return cached.index;
  const content = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (content) {
    const index = AttentionIndex.parse(JSON.parse(content));
    CACHE.set(path, { stamp, index });
    return index;
  }
  const cutoff = new Date(Date.now() - ATTENTION_LIMITS.initialHistoryDays * 86_400_000).toISOString();
  const index: AttentionIndex = { routingVersion: 1, cutoff, cursors: {}, entries: {} };
  // Preserve decisions made by the earlier per-item format when first creating the index.
  const directory = join(runtime.stateDirectory, 'attention');
  for (const name of (await readdir(directory).catch(() => [])).filter(name => /^a-.*\.json$/.test(name))) {
    try {
      const entry = Attention.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
      index.entries[entry.id] = entry;
    } catch {
      console.warn(`attention_record_invalid: ${name}`);
    }
  }
  await writeIndex(runtime, index);
  return index;
}

async function writeIndex(runtime: Runtime, index: AttentionIndex) {
  const path = indexPath(runtime);
  await mkdir(join(runtime.stateDirectory, 'attention'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(index) + '\n', { mode: 0o600 });
    await rename(temporary, path);
    CACHE.set(path, { stamp: await fileStamp(path), index });
  } catch (error) {
    CACHE.delete(path);
    throw error;
  }
}

/** One generation of a host condition has one inbox identity, including a terminal tombstone. */
function ingestCondition(index: AttentionIndex, owner: string, event: JournalRecord, journal: Attention['journal']) {
  const condition = event.condition!;
  const digest = createHash('sha256').update(JSON.stringify([owner, condition.key])).digest('hex').slice(0, 24);
  const id = `a-condition-${digest}`;
  const previous = index.entries[id];
  if (previous?.condition?.state === 'resolved' || (previous?.condition && previous.condition.observedAt > event.at)) return;
  const status = condition.state === 'resolved' ? 'resolved' : previous?.status ?? 'open';
  index.entries[id] = Attention.parse({
    ...previous, id, owner, note: event.note ?? previous?.note ?? '', at: previous?.at ?? event.at,
    status, condition: { ...condition, observedAt: event.at },
    provenance: event.provenance ?? previous?.provenance, journal,
    workItem: event.workItem ?? previous?.workItem, outcome: event.outcome ?? previous?.outcome,
  });
}

function ingestLine(index: AttentionIndex, owner: string, file: string, number: number, line: string) {
  if (!line.trim()) return;
  try {
    const event = parseJournalRecord(line);
    if (!event) throw new Error('journal_record_invalid');
    if (event.at < index.cutoff) return;
    const journal = { file, line: number };
    if (event.kind === 'attention-condition' && event.condition) return ingestCondition(index, owner, event, journal);
    if (event.kind !== 'attention') return;
    const digest = createHash('sha256').update(`${owner}/${file}/${number}/${line}`).digest('hex').slice(0, 24);
    const id = `a-${digest}`;
    index.entries[id] = Attention.parse({
      ...index.entries[id], id, owner,
      note: index.entries[id]?.note ?? event.note ?? '', at: index.entries[id]?.at ?? event.at,
      journal, provenance: event.provenance ?? index.entries[id]?.provenance,
      workItem: event.workItem, outcome: event.outcome,
    });
  } catch {
    // Log only the location, never potentially sensitive journal contents.
    console.warn(`attention_journal_invalid: ${owner}/${file}:${number + 1}`);
  }
}

async function scanFile(runtime: Runtime, index: AttentionIndex, owner: string, file: string) {
  const key = `${owner}/${file}`;
  const cursor = index.cursors[key] ?? { offset: 0, line: 0, size: -1, complete: false };
  const isPast = file.slice(0, 10) < new Date().toISOString().slice(0, 10);
  if (isPast && cursor.complete) return false; // Journals append to today's file only.
  const path = join(runtime.notebook(owner).directory, 'journal', file);
  const size = (await stat(path)).size;
  if (size === cursor.size && !(isPast && !cursor.complete)) return false;
  if (size < cursor.offset) Object.assign(cursor, { offset: 0, line: 0 });
  const handle = await open(path, 'r');
  try {
    const start = cursor.offset;
    const buffer = Buffer.alloc(Math.min(size - cursor.offset, ATTENTION_LIMITS.scanBytesPerFile));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
    const consumed = lastNewline + 1;
    for (const line of buffer.subarray(0, consumed).toString('utf8').split('\n').slice(0, -1)) {
      ingestLine(index, owner, file, cursor.line++, line);
    }
    cursor.offset += consumed;
    if (bytesRead && !consumed && (isPast || bytesRead === ATTENTION_LIMITS.scanBytesPerFile)) {
      console.warn(`attention_journal_incomplete: ${key}:${cursor.line + 1}`);
      cursor.offset += bytesRead;
      cursor.line++;
    }
    cursor.size = start + bytesRead < size || (isPast && cursor.offset < size) ? -1 : size;
    cursor.complete = isPast && cursor.offset >= size;
    index.cursors[key] = cursor;
    return true;
  } finally {
    await handle.close();
  }
}

async function discover(runtime: Runtime, index: AttentionIndex) {
  let changed = false;
  for (const owner of runtime.declarations.owners.values()) {
    const directory = join(runtime.notebook(owner.id).directory, 'journal');
    const files = (await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }))
      .filter(name => name.endsWith('.jsonl') && name.slice(0, 10) >= index.cutoff.slice(0, 10)).sort();
    for (const file of files) changed = await scanFile(runtime, index, owner.id, file) || changed;
  }
  return changed;
}

/** Incremental journal discovery: only appended bytes are parsed; malformed lines do not break the surface. */
export async function listAttention(runtime: Runtime): Promise<Attention[]> {
  return withRecordLock(`${indexPath(runtime)}.lock`, async () => {
    const index = structuredClone(await readIndex(runtime));
    // Replay original journal identities once to enrich old indexes without changing human decisions.
    const needsMigration = index.routingVersion < 1;
    if (needsMigration) index.cursors = {};
    const discovered = await discover(runtime, index);
    const reconciled = await reconcileAttention(runtime, Object.values(index.entries));
    index.routingVersion = 1;
    if (needsMigration || discovered || reconciled) await writeIndex(runtime, index);
    return Object.values(index.entries).filter(entry => runtime.declarations.owners.has(entry.owner));
  });
}

export async function changeAttention(runtime: Runtime, id: string, status: Attention['status'], actor: AttentionActor, reason: string) {
  if (!reason.trim()) throw new Error('attention_reason_required');
  await listAttention(runtime);
  const updated = await withRecordLock(`${indexPath(runtime)}.lock`, async () => {
    const index = await readIndex(runtime);
    const entry = index.entries[id];
    if (!entry) throw new Error(`attention_not_found: ${id}`);
    requireAttentionActor(runtime, actor, entry);
    const changed: Attention = { ...entry, status, decision: { by: actor.by, reason, at: new Date().toISOString() } };
    index.entries[id] = changed;
    await writeIndex(runtime, index);
    return changed;
  });
  const notebook = runtime.notebook(updated.owner);
  await notebook.journal({ kind: 'attention-decision', note: `${id}: ${status} by ${actor.by}: ${reason}` });
  await notebook.commit(`attention ${status}`);
  return updated;
}
