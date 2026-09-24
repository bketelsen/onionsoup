import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJournalRecord, type JournalRecord } from './journal-record.ts';
import type { Runtime } from './runtime.ts';

export const CHAT_CONTEXT_DEFAULTS = {
  ageHours: 48, maxEntries: 32, maxChars: 8_000, entryChars: 2_000,
  scanBytes: 131_072, noticeChars: 12_000, noticeSessions: 30,
};
export const ChatContextPolicy = z.object({
  ageHours: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.ageHours),
  maxEntries: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.maxEntries),
  maxChars: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.maxChars),
  entryChars: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.entryChars),
  scanBytes: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.scanBytes),
  noticeChars: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.noticeChars),
  noticeSessions: z.number().int().positive().default(CHAT_CONTEXT_DEFAULTS.noticeSessions),
});
export type ChatContextPolicy = z.infer<typeof ChatContextPolicy>;

const ACTIVITY = new Set(['asked', 'answered', 'work-status', 'ci-triage', 'attention',
  'owner-created', 'owner-updated', 'owner-retired', 'chat-decision', 'retracted']);

export function clipped(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

async function journalTail(path: string, budget: number) {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, budget);
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const complete = buffer.subarray(0, bytesRead);
    const firstNewline = complete.indexOf(10);
    const start = offset ? (firstNewline < 0 ? bytesRead : firstNewline + 1) : 0;
    const end = complete.lastIndexOf(10);
    const lines = end < start ? [] : complete.subarray(start, end).toString('utf8').split('\n');
    return { bytes: bytesRead, lines };
  } finally {
    await handle.close();
  }
}

/** Recent append-only journal tails have bounded I/O, and malformed/truncated records are ignored. */
export async function recentJournal(runtime: Runtime, ownerId: string, now = Date.now()) {
  const policy = runtime.owner(ownerId).chatContext;
  const cutoff = new Date(now - policy.ageHours * 3_600_000).toISOString();
  const directory = join(runtime.notebook(ownerId).directory, 'journal');
  const files = (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file >= cutoff.slice(0, 10)).sort().reverse();
  const records: JournalRecord[] = [];
  let remaining = policy.scanBytes;
  for (const file of files) {
    if (remaining <= 0) break;
    const tail = await journalTail(join(directory, file), remaining);
    remaining -= tail.bytes;
    for (const line of tail.lines.reverse()) {
      const entry = parseJournalRecord(line);
      if (entry && entry.at >= cutoff && Date.parse(entry.at) <= now) records.push(entry);
    }
  }
  return records;
}

function eligibleRecords(records: JournalRecord[], kinds: ReadonlySet<string>) {
  const retracted = new Set<string | undefined>();
  return records.filter(entry => {
    if (entry.kind === 'retracted') retracted.add(entry.note);
    return kinds.has(entry.kind) && (entry.kind !== 'chat-decision' || !retracted.has(entry.note));
  });
}

function contextText(records: JournalRecord[], policy: ChatContextPolicy, kinds: ReadonlySet<string>) {
  const lines: string[] = [];
  let remaining = policy.maxChars;
  for (const entry of eligibleRecords(records, kinds).slice(0, policy.maxEntries)) {
    if (remaining <= 0) break;
    const content = JSON.stringify({ at: entry.at, kind: entry.kind, note: entry.note, outcome: entry.outcome, quote: entry.quote });
    const line = clipped(content, Math.min(policy.entryChars, remaining));
    lines.push(line);
    remaining -= line.length + 1;
  }
  return lines.reverse().join('\n');
}

/** Raw recent decisions supplement distilled memory; including already-distilled decisions avoids a lossy time cutoff. */
export async function recentChatDecisions(runtime: Runtime, ownerId: string) {
  return contextText(await recentJournal(runtime, ownerId), runtime.owner(ownerId).chatContext, new Set(['chat-decision', 'retracted']));
}

export async function recentActivityContext(runtime: Runtime, ownerId: string) {
  return contextText(await recentJournal(runtime, ownerId), runtime.owner(ownerId).chatContext, ACTIVITY);
}
