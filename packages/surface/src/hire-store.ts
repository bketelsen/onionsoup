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
    return messagesFromStore(db, sessionID);
  } finally {
    db.close();
  }
}

function messagesFromStore(db: DatabaseSync, sessionID: string) {
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
}

/**
 * Sessions whose title starts with a prefix (a work item's hires are titled "<item>: <stage>"), oldest first. Read
 * from the store because an opencode server lists a folder's sessions from what it has loaded, and hires are
 * created by the daemon's own servers after the surface's server loaded that folder.
 */
export function readSessionsTitled(prefix: string, database = opencodeDatabase()) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db.prepare("select id, title, directory, time_created, time_updated from session where substr(title, 1, ?) = ? order by time_created, id")
      .all(prefix.length, prefix) as { id: string; title: string; directory: string; time_created: number; time_updated: number }[];
    return rows.map(row => ({ id: row.id, title: row.title, directory: row.directory, time: { created: row.time_created, updated: row.time_updated } }));
  } finally {
    db.close();
  }
}

/** Archived owner transcripts require both an authorized ID and its immutable creation directory. */
export function readArchivedSessionMessages(sessionID: string, directory: string, database = opencodeDatabase()) {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    db.exec('BEGIN');
    const row = db.prepare('select directory from session where id = ?').get(sessionID) as { directory: string } | undefined;
    if (!row) throw new Error('history_transcript_unavailable');
    if (row.directory !== directory) throw new Error('history_directory_mismatch');
    return messagesFromStore(db, sessionID);
  } catch (error) {
    if (error instanceof Error && error.message === 'history_directory_mismatch') throw error;
    throw new Error('history_transcript_unavailable');
  } finally { db?.close(); }
}
