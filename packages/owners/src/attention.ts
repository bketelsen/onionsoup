import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJournalRecord } from './journal-record.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

export const ATTENTION_LIMITS = { initialHistoryDays: 7, scanBytesPerFile: 1_048_576 };
export const Attention = z.object({
  id: z.string(), owner: z.string(), note: z.string(), at: z.string(),
  status: z.enum(['open', 'acknowledged', 'resolved']).default('open'),
  decision: z.object({ by: z.string(), reason: z.string(), at: z.string() }).optional(),
});
export type Attention = z.infer<typeof Attention>;
const Cursor = z.object({ offset: z.number(), line: z.number(), size: z.number(), complete: z.boolean() });
const AttentionIndex = z.object({
  cutoff: z.string(),
  cursors: z.record(z.string(), Cursor),
  entries: z.record(z.string(), Attention),
});
type AttentionIndex = z.infer<typeof AttentionIndex>;
const CACHE = new Map<string, { stamp: string; index: AttentionIndex }>();

function indexPath(runtime: Runtime) {
  return join(runtime.stateDirectory, 'attention', 'index.json');
}

async function fileStamp(path: string) {
  const details = await stat(path).catch(() => undefined);
  return details ? `${details.mtimeMs}:${details.size}` : '';
}

async function readIndex(runtime: Runtime) {
  const path = indexPath(runtime);
  const stamp = await fileStamp(path);
  const cached = CACHE.get(path);
  if (stamp && cached?.stamp === stamp) return cached.index;
  const content = await readFile(path, 'utf8').catch(() => undefined);
  if (content) {
    const index = AttentionIndex.parse(JSON.parse(content));
    CACHE.set(path, { stamp, index });
    return index;
  }
  const cutoff = new Date(Date.now() - ATTENTION_LIMITS.initialHistoryDays * 86_400_000).toISOString();
  const index: AttentionIndex = { cutoff, cursors: {}, entries: {} };
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

function ingestLine(index: AttentionIndex, owner: string, file: string, number: number, line: string) {
  if (!line.trim()) return;
  try {
    const event = parseJournalRecord(line);
    if (!event) throw new Error('journal_record_invalid');
    if (event.kind !== 'attention' || event.at < index.cutoff) return;
    const digest = createHash('sha256').update(`${owner}/${file}/${number}/${line}`).digest('hex').slice(0, 24);
    const id = `a-${digest}`;
    index.entries[id] ??= Attention.parse({ id, owner, note: event.note ?? '', at: event.at });
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
  if (size === cursor.size) return false;
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
    cursor.complete = cursor.offset >= size;
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
    const files = (await readdir(directory).catch(() => []))
      .filter(name => name.endsWith('.jsonl') && name.slice(0, 10) >= index.cutoff.slice(0, 10)).sort();
    for (const file of files) changed = await scanFile(runtime, index, owner.id, file) || changed;
  }
  if (changed) await writeIndex(runtime, index);
}

/** Incremental journal discovery: only appended bytes are parsed; malformed lines do not break the surface. */
export async function listAttention(runtime: Runtime): Promise<Attention[]> {
  return withRecordLock(`${indexPath(runtime)}.lock`, async () => {
    const index = await readIndex(runtime);
    await discover(runtime, index);
    return Object.values(index.entries).filter(entry => runtime.declarations.owners.has(entry.owner));
  });
}

export async function changeAttention(runtime: Runtime, id: string, status: Attention['status'], by: string, reason: string) {
  if (!reason.trim()) throw new Error('attention_reason_required');
  await listAttention(runtime);
  const updated = await withRecordLock(`${indexPath(runtime)}.lock`, async () => {
    const index = await readIndex(runtime);
    const entry = index.entries[id];
    if (!entry) throw new Error(`attention_not_found: ${id}`);
    const changed: Attention = { ...entry, status, decision: { by, reason, at: new Date().toISOString() } };
    index.entries[id] = changed;
    await writeIndex(runtime, index);
    return changed;
  });
  const notebook = runtime.notebook(updated.owner);
  await notebook.journal({ kind: 'attention-decision', note: `${id}: ${status} by ${by}: ${reason}` });
  await notebook.commit(`attention ${status}`);
  return updated;
}
