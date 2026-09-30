import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkItem } from './ledger.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

/** Host-observed identity, never an authorization supplied by a chat/model. No transcript is copied. */
export const SessionHistory = z.object({
  id: z.string().min(1), owner: z.string().min(1), directory: z.string().min(1), title: z.string(),
  archived: z.boolean().optional(), parentID: z.string().optional(), item: z.string().optional(),
  time: z.object({ created: z.number(), updated: z.number() }),
});
export type SessionHistory = z.infer<typeof SessionHistory>;
function directory(runtime: Runtime) { return join(runtime.stateDirectory, 'session-history'); }
function file(runtime: Runtime, id: string) {
  return join(directory(runtime), `${createHash('sha256').update(id).digest('hex')}.json`);
}

export async function rememberSession(runtime: Runtime, input: SessionHistory) {
  const record = SessionHistory.parse(input);
  const path = file(runtime, record.id);
  await withRecordLock(`${path}.lock`, async () => {
    const existing = await rememberedSession(runtime, record.id);
    if (existing && (existing.owner !== record.owner || existing.directory !== record.directory || existing.parentID !== record.parentID)) {
      throw new Error('session_history_identity_conflict');
    }
    const saved = { ...existing, ...record, item: record.item ?? existing?.item, archived: Boolean(record.archived || existing?.archived) };
    if (JSON.stringify(existing) === JSON.stringify(saved)) return;
    await mkdir(directory(runtime), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }).catch(error => {
    if (error instanceof Error && ['session_history_identity_conflict', 'session_history_invalid'].includes(error.message)) throw error;
    throw new Error('session_history_unavailable');
  });
}

/** Exact identity lookup is fail-closed; callers must not treat malformed metadata as absence. */
export async function rememberedSession(runtime: Runtime, id: string) {
  const contents = await readFile(file(runtime, id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('session_history_unavailable');
    return undefined;
  });
  if (contents === undefined) return undefined;
  try {
    const record = SessionHistory.parse(JSON.parse(contents));
    if (record.id !== id) throw new Error('session_history_invalid');
    return record;
  } catch { throw new Error('session_history_invalid'); }
}

export async function sessionHistory(runtime: Runtime, owner: string) {
  const names = await readdir(directory(runtime)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('session_history_unavailable');
    return [];
  });
  const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
    try {
      const record = SessionHistory.parse(JSON.parse(await readFile(join(directory(runtime), name), 'utf8')));
      if (file(runtime, record.id) !== join(directory(runtime), name)) throw new Error('session_history_invalid');
      return record;
    } catch {
      console.warn('session_history_record_unreadable', name);
      return undefined;
    }
  }));
  return records.filter((record): record is SessionHistory => record !== undefined && record.owner === owner);
}

/** Explicit ledger references survive worktree deletion; no title-based owner inference. */
export function itemSessionHistory(item: WorkItem): SessionHistory[] {
  const targets = [item.origin, item.session].filter(target => target !== undefined);
  return [...new Map(targets.map(target => [target.sessionID, {
    id: target.sessionID, directory: target.directory, owner: item.owner, item: item.id,
    title: `${target === item.session ? 'Plan' : 'Planning'} ${item.id}: ${item.proposal.title}`,
    time: { created: Date.parse(item.createdAt), updated: Date.parse(item.updatedAt) },
  }])).values()];
}
