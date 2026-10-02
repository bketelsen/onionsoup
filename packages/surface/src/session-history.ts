import { existsSync } from 'node:fs';
import { z } from 'zod';
import { isRetiredSession, itemSessionHistory, rememberSession, rememberedSession, sessionHistory, SessionHistory, type Runtime } from '@onionsoup/owners';
import type { OpencodeApi } from './opencode.ts';

const ObservedSession = SessionHistory.omit({ owner: true, item: true, archived: true }).extend({ directory: z.string().optional() });
export type HistoricalSession = SessionHistory & { archived: boolean };

/** Merge explicit records only; a shared repository title or arbitrary requested ID never establishes ownership. */
export async function recordedSessions(runtime: Runtime, owner: string) {
  const items = (await runtime.ledger.list()).filter(item => item.owner === owner);
  const remembered = await sessionHistory(runtime, owner);
  const references = items.flatMap(itemSessionHistory);
  const identities = new Map(remembered.map(session => [session.id, session]));
  for (const reference of references) {
    const identity = identities.get(reference.id) ?? await rememberedSession(runtime, reference.id);
    if (identity && (identity.owner !== reference.owner || identity.directory !== reference.directory || identity.parentID)) {
      throw new Error('session_history_identity_conflict');
    }
  }
  return [...new Map([...references, ...remembered].map(record => [record.id, record])).values()]
    .map(record => ({ ...record, archived: isRetiredSession(record, items) }))
    .sort((left, right) => right.time.updated - left.time.updated || left.id.localeCompare(right.id));
}

export async function rememberObservedSessions(runtime: Runtime, owner: string, directory: string, sessions: unknown[]) {
  for (const value of sessions) {
    const parsed = ObservedSession.safeParse(value);
    if (!parsed.success) { console.warn('session_history_observation_invalid', owner); continue; }
    const record = parsed.data;
    if (record.directory && record.directory !== directory) continue;
    try { await rememberSession(runtime, { ...record, owner, directory }); }
    catch (error) {
      if (!(error instanceof Error) || !['session_history_identity_conflict', 'session_history_invalid'].includes(error.message)) throw error;
      console.warn('session_history_observation_not_recorded', owner, record.id);
    }
  }
}

export async function authorizedSession(runtime: Runtime, api: OpencodeApi, owner: string, id: string, resolveDirectory: () => Promise<string>) {
  const identity = await rememberedSession(runtime, id).catch(error => {
    if (error instanceof Error && error.message === 'session_history_unavailable') throw error;
    throw new Error('session_not_owned');
  });
  if (identity && identity.owner !== owner) throw new Error('session_not_owned');
  const recorded = (await recordedSessions(runtime, owner)).find(record => record.id === id);
  if (recorded) return recorded;
  const directory = await resolveDirectory();
  await rememberObservedSessions(runtime, owner, directory, await api.listSessions(directory));
  const discovered = (await recordedSessions(runtime, owner)).find(record => record.id === id);
  if (!discovered) throw new Error('session_not_owned');
  return discovered;
}

export function historyView(record: SessionHistory, workspaceExists: (directory: string) => boolean = existsSync): HistoricalSession {
  return { ...record, archived: Boolean(record.archived) || !workspaceExists(record.directory) };
}
