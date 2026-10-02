import { z } from 'zod';
import type { WorkPauseClient } from './work-pause.ts';

const Session = z.object({ id: z.string(), parentID: z.string().optional() });
const Statuses = z.record(z.string(), z.object({ type: z.enum(['busy', 'retry', 'idle']) }));
export interface WorkPauseTransport {
  sessions(directory: string): Promise<unknown[]>;
  statuses(directory: string): Promise<unknown>;
  abort(directory: string, sessionID: string): Promise<void>;
}

function descendants(sessions: z.infer<typeof Session>[], root: string) {
  const included = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (!session.parentID || !included.has(session.parentID) || included.has(session.id)) continue;
      included.add(session.id);
      changed = true;
    }
  }
  return [...included].reverse();
}

/** Positive server observations, including children, are required; a transport failure never means idle. */
export function workPauseClient(transport: WorkPauseTransport): WorkPauseClient {
  return {
    async stop(origin) {
      const sessions = z.array(Session).parse(await transport.sessions(origin.directory));
      if (!sessions.some(session => session.id === origin.sessionID)) throw new Error('work_pause_session_unavailable');
      const targets = descendants(sessions, origin.sessionID);
      const before = Statuses.parse(await transport.statuses(origin.directory));
      for (const sessionID of targets) {
        if (before[sessionID]?.type && before[sessionID]?.type !== 'idle') {
          await transport.abort(origin.directory, sessionID);
        }
      }
      const after = Statuses.parse(await transport.statuses(origin.directory));
      const latest = z.array(Session).parse(await transport.sessions(origin.directory));
      return descendants(latest, origin.sessionID).every(sessionID => !after[sessionID] || after[sessionID]?.type === 'idle');
    },
  };
}
