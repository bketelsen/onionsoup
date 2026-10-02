import type { WorkItem } from './ledger.ts';
import type { SessionHistory } from './session-history.ts';

const TERMINAL = new Set<WorkItem['status']>(['landed', 'cancelled', 'rejected']);

/** An explicit terminal execution reference is history after its retained workspace has retired. */
export function isRetiredSession(session: SessionHistory, items: readonly WorkItem[]) {
  if (session.archived) return true;
  return items.some(item => item.owner === session.owner && item.session?.sessionID === session.id
    && item.session.directory === session.directory && !item.planWorktree && item.activeRunner === undefined && TERMINAL.has(item.status));
}

export interface WorkSessionDirectory { directory: string; required: boolean; retired: boolean }

/** Retained plan workspaces remain live for rollouts; historical ledger session addresses do not. */
export function workSessionDirectories(items: readonly WorkItem[], history: readonly SessionHistory[] = []): WorkSessionDirectory[] {
  const places = new Map<string, WorkSessionDirectory>();
  for (const item of items) {
    const required = item.activeRunner !== undefined || !TERMINAL.has(item.status);
    const directory = item.planWorktree ?? (required ? item.session?.directory : undefined);
    if (!directory) continue;
    const retired = history.some(session => session.owner === item.owner && session.directory === directory && session.archived
      && (item.session ? session.id === item.session.sessionID : session.item === item.id));
    if (retired && !required) continue;
    places.set(directory, { directory, required: required || Boolean(places.get(directory)?.required), retired });
  }
  return [...places.values()];
}
