import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Hire sessions read straight from opencode's store (read-only). opencode 1.18.32 cannot send back the messages of
 * a session whose prompt asked for structured output, and every hire does, so the HTTP API is no use for them.
 * Rows hold each message's and part's JSON; ids live in their own columns.
 */
export function opencodeDatabase() {
  return process.env.OPENCODE_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db');
}

export function readSessionMessages(sessionID: string, database = opencodeDatabase()) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const messages = db.prepare('select id, data from message where session_id = ? order by time_created, id').all(sessionID) as { id: string; data: string }[];
    const parts = db.prepare('select id, message_id, data from part where session_id = ? order by time_created, id').all(sessionID) as { id: string; message_id: string; data: string }[];
    const byMessage = new Map<string, unknown[]>();
    for (const part of parts) {
      const list = byMessage.get(part.message_id) ?? [];
      list.push({ ...(JSON.parse(part.data) as object), id: part.id, messageID: part.message_id, sessionID });
      byMessage.set(part.message_id, list);
    }
    return messages.map(message => {
      const info = JSON.parse(message.data) as Record<string, unknown>;
      // The brief's structured-output schema is noise to a reader.
      delete info.format;
      return { info: { ...info, id: message.id, sessionID }, parts: byMessage.get(message.id) ?? [] };
    });
  } finally {
    db.close();
  }
}
