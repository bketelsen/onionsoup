import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, open, link, unlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const identifier = z.string().regex(/^ses_[a-zA-Z0-9]+$/);
export const ChildIdentity = z.object({ childID: identifier, parentID: identifier, directory: z.string().startsWith('/') }).strict();
export type ChildIdentity = z.infer<typeof ChildIdentity>;
export const ChildAbandonment = ChildIdentity.extend({
  version: z.literal(1), state: z.literal('abandoned'), digest: z.string().regex(/^[a-f0-9]{64}$/),
  database: z.string().startsWith('/'), recordedBy: z.string().trim().min(1).max(200),
  approvedBy: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000), approvedAt: z.string().datetime(),
}).strict();
export type ChildAbandonment = z.infer<typeof ChildAbandonment>;
export const CHILD_RECOVERY_LIMITS = { records: 10_000, bytes: 4 * 1024 * 1024 };
export function childRecoveryDatabase() {
  return process.env.OPENCODE_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db');
}
const SessionRow = z.object({ id: identifier, parent_id: identifier, directory: z.string(), time_updated: z.number() }).passthrough();
const StoredMessage = z.object({ id: z.string(), data: z.string() }).passthrough();
const StoredPart = StoredMessage.extend({ message_id: z.string() });
const MessageInfo = z.object({ role: z.string(), parentID: z.string().optional(), finish: z.string().optional(),
  time: z.object({ completed: z.number().optional() }).passthrough().optional() }).passthrough();
function recoveryPath(state: string, id: string) {
  identifier.parse(id);
  return join(state, 'child-recovery', `${id}.json`);
}

/** Consistent, read-only snapshot. No stored format, message, ancestry or finish marker is rewritten. */
export function childRecoverySnapshot(input: ChildIdentity, database = childRecoveryDatabase()) {
  const identity = ChildIdentity.parse(input);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('BEGIN');
    const session = SessionRow.parse(db.prepare('select * from session where id = ?').get(identity.childID));
    if (session.parent_id !== identity.parentID || session.directory !== identity.directory) throw new Error('child_recovery_identity_mismatch');
    const descendants = db.prepare('select id from session where parent_id = ? limit 1').all(identity.childID);
    if (descendants.length) throw new Error('child_recovery_has_descendants');
    const messages = z.array(StoredMessage).parse(db.prepare('select * from message where session_id = ? order by time_created, id limit ?')
      .all(identity.childID, CHILD_RECOVERY_LIMITS.records + 1));
    const parts = z.array(StoredPart).parse(db.prepare('select * from part where session_id = ? order by time_created, id limit ?')
      .all(identity.childID, CHILD_RECOVERY_LIMITS.records + 1));
    const serialized = JSON.stringify({ session, messages, parts });
    if (messages.length > CHILD_RECOVERY_LIMITS.records || parts.length > CHILD_RECOVERY_LIMITS.records ||
      Buffer.byteLength(serialized) > CHILD_RECOVERY_LIMITS.bytes) throw new Error('child_recovery_snapshot_limit');
    if (!messages.length) throw new Error('child_recovery_empty_history');
    const infos = messages.map(message => MessageInfo.parse(JSON.parse(message.data)));
    const user = infos.findLastIndex(info => info.role === 'user');
    const last = infos.at(-1)!;
    if (user < 0) throw new Error('child_recovery_missing_user');
    const completed = last.role === 'assistant' && last.parentID === messages[user]!.id && last.finish === 'stop'
      && Number.isFinite(last.time?.completed);
    return { identity, digest: createHash('sha256').update(serialized).digest('hex'), serialized, messages, parts, completed };
  } finally { db.close(); }
}

export async function readChildAbandonment(state: string, id: string) {
  if (!identifier.safeParse(id).success) return undefined;
  const text = await readFile(recoveryPath(state, id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const record = ChildAbandonment.parse(JSON.parse(text));
  if (record.childID !== id) throw new Error('child_recovery_identity_mismatch');
  return record;
}

/** Approval is an immutable receipt, not proof of successful completion. Changed history invalidates it. */
export async function isAbandonedChild(state: string, input: ChildIdentity, database = childRecoveryDatabase()) {
  const parsed = ChildIdentity.safeParse(input);
  if (!parsed.success) return false;
  const identity = parsed.data;
  try {
    const record = await readChildAbandonment(state, identity.childID);
    if (!record || record.parentID !== identity.parentID || record.directory !== identity.directory) return false;
    if (record.database !== await realpath(database)) return false;
    return childRecoverySnapshot(identity, database).digest === record.digest;
  } catch {
    // Invalid or inaccessible evidence must retain admission, never count as completion.
    console.error('child_recovery_evidence_unavailable', identity.childID);
    return false;
  }
}

async function durableFile(path: string, text: string) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}

/** Caller holds admission.lock and proves live quiescence before and after reading this exact snapshot. */
export async function recordChildAbandonment(state: string, input: Omit<ChildAbandonment, 'database'>, database = childRecoveryDatabase()) {
  const record = ChildAbandonment.parse({ ...input, database: await realpath(database) });
  const identity = ChildIdentity.parse({ childID: record.childID, parentID: record.parentID, directory: record.directory });
  const snapshot = childRecoverySnapshot(identity, database);
  if (snapshot.completed) throw new Error('child_recovery_already_completed');
  if (snapshot.digest !== record.digest) throw new Error('child_recovery_evidence_changed');
  const existing = await readChildAbandonment(state, record.childID);
  if (existing) {
    if (existing.database !== record.database || existing.digest !== record.digest || existing.parentID !== record.parentID || existing.directory !== record.directory) throw new Error('child_recovery_conflict');
    return existing;
  }
  const directory = join(state, 'child-recovery');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // The original rows are recoverable even if the upstream store later changes.
  const backup = join(directory, `${record.childID}.${record.digest}.backup.json`);
  await durableFile(backup, snapshot.serialized).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(backup, 'utf8') !== snapshot.serialized) throw new Error('child_recovery_backup_conflict');
  });
  const temporary = join(directory, `${record.childID}.${randomUUID()}.tmp`);
  await durableFile(temporary, JSON.stringify(record) + '\n');
  try {
    // Exclusive publication cannot overwrite another approval, even outside the caller's lock.
    await link(temporary, recoveryPath(state, record.childID));
  } finally { await unlink(temporary); }
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  return record;
}

export async function listChildAbandonments(state: string, parentID: string, directory: string) {
  const names = await readdir(join(state, 'child-recovery')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const records = await Promise.all(names.filter(name => /^ses_[a-zA-Z0-9]+\.json$/.test(name))
    .map(name => readChildAbandonment(state, name.slice(0, -5)).catch(() => {
      console.error('child_recovery_receipt_unavailable', name);
      return undefined;
    })));
  return records.filter((record): record is ChildAbandonment => !!record && record.parentID === parentID && record.directory === directory);
}

/** Only explicitly recovered, unchanged children get this format-compatibility read projection. */
export async function abandonedChildMessages(state: string, childID: string, parentID: string, directory: string, database = childRecoveryDatabase()) {
  const identity = { childID, parentID, directory };
  if (!await isAbandonedChild(state, identity, database)) return undefined;
  try {
    const snapshot = childRecoverySnapshot(identity, database);
    const receipt = await readChildAbandonment(state, childID);
    if (snapshot.digest !== receipt?.digest) return undefined;
    const byMessage = new Map<string, typeof snapshot.parts>();
    for (const part of snapshot.parts) {
      const group = byMessage.get(part.message_id) ?? [];
      group.push(part);
      byMessage.set(part.message_id, group);
    }
    return snapshot.messages.map(message => {
      const info = MessageInfo.parse(JSON.parse(message.data));
      delete info.format;
      return { info: { ...info, id: message.id, sessionID: childID }, parts: (byMessage.get(message.id) ?? [])
        .map(part => ({ ...JSON.parse(part.data), id: part.id, messageID: message.id, sessionID: childID })) };
    });
  } catch {
    console.error('child_recovery_evidence_unavailable', childID);
    return undefined;
  }
}
