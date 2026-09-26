import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AssistantMessageEvent } from './provider-health.ts';
import { withRecordLock } from './record-lock.ts';
import { secretShapesIn } from './secret-shapes.ts';
import type { Runtime } from './runtime.ts';

export const FRICTION_LIMITS = {
  prose: 800, error: 120, failures: 5, sessions: 80, list: 100, recordBytes: 8_192,
};
export const FrictionInput = z.object({
  summary: z.string().trim().min(1).max(FRICTION_LIMITS.prose),
  expected: z.string().trim().min(1).max(FRICTION_LIMITS.prose),
  actual: z.string().trim().min(1).max(FRICTION_LIMITS.prose),
  evidence: z.string().trim().max(FRICTION_LIMITS.prose).optional(),
}).strict();
export type FrictionInput = z.infer<typeof FrictionInput>;

const Failure = z.object({ tool: z.string().max(80), input: z.string().max(80), error: z.string().max(FRICTION_LIMITS.error) }).strict();
export type Failure = z.infer<typeof Failure>;
const ToolEvent = z.object({ type: z.literal('message.part.updated'), properties: z.object({
  part: z.object({ id: z.string().optional(), callID: z.string().optional(), sessionID: z.string(), type: z.literal('tool'), tool: z.string(),
    state: z.object({ status: z.literal('error'), error: z.unknown() }),
  }),
}) });
const Origin = z.object({ sessionID: z.string().min(1).max(200), directory: z.string().min(1).max(1000) }).strict();
export const FrictionRecord = z.object({
  version: z.literal(1), id: z.string().regex(/^fr_[a-f0-9]{24}$/), owner: z.string(),
  summary: z.string().max(FRICTION_LIMITS.prose), expected: z.string().max(FRICTION_LIMITS.prose),
  actual: z.string().max(FRICTION_LIMITS.prose), evidence: z.string().max(FRICTION_LIMITS.prose).optional(),
  origin: Origin, firstSeen: z.string().datetime(), lastSeen: z.string().datetime(), count: z.number().int().positive(),
  commit: z.string().regex(/^[a-f0-9]{40}(?:-dirty)?$/).or(z.literal('unavailable')),
  model: z.string().max(160).or(z.literal('unavailable')),
  failures: z.array(Failure).max(FRICTION_LIMITS.failures), failureContext: z.enum(['observed', 'unavailable']),
  provisional: z.boolean(),
}).strict();
export type FrictionRecord = z.infer<typeof FrictionRecord>;

const Wake = z.object({ id: FrictionRecord.shape.id, at: z.string().datetime(), status: z.literal('pending') });
const Submission = z.object({ id: FrictionRecord.shape.id, journaled: z.boolean(), baseline: z.number().int().nonnegative().optional() });
const FrictionIndex = z.record(FrictionRecord.shape.id, z.object({ lastSeen: z.string().datetime() }));
const exec = promisify(execFile);

/** Never take paths, command lines, patch content or argument values from tool input. */
export function safeToolInput(tool: string) {
  return ['bash', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'webfetch'].includes(tool)
    ? 'arguments withheld' : 'arguments unavailable';
}

/** Hash only bounded, masked lexical structure; never persist arbitrary error or argument text. */
export function safeToolError(error: unknown) {
  if (typeof error !== 'string' || !error.trim()) return 'error details unavailable';
  if (/^tool error \(class [a-f0-9]{24}\)$/.test(error)) return error;
  const code = /\b(?:permission denied|not found|timeout|timed out|rate limit|unauthorized|forbidden|invalid argument|exit code [0-9]{1,3})\b/i.exec(error)?.[0];
  if (code) return code.toLowerCase();
  const shape = error.slice(0, FRICTION_LIMITS.error * 8)
    .replace(/(?:Bearer\s+\S+|\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi, ' masked ')
    .replace(/(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\/\S+|\b[\w.-]+@[\w.-]+\b)/g, ' masked ')
    .replace(/\b(?:[a-f0-9]{8,}|\d+|[a-z0-9_-]{21,})\b/gi, ' masked ')
    .toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(word => word.length >= 2).slice(0, 16).join(' ');
  return shape.replace(/masked/g, '').trim() ? `tool error (class ${digest(shape)})` : 'error details unavailable';
}

/** Session-local observed errors only; a missing event is not reconstructed from model prose. */
export class FrictionEvents {
  private readonly sessions = new Map<string, { failures: { key?: string; failure: Failure }[]; model: string }>();

  observe(event: unknown) {
    const model = AssistantMessageEvent.safeParse(event);
    if (model.success) {
      const { sessionID, providerID, modelID } = model.data.properties.info;
      if (!providerID || !modelID) return;
      const existing = this.session(sessionID);
      existing.model = `${providerID}/${modelID}`.slice(0, 160);
      return;
    }
    const tool = ToolEvent.safeParse(event);
    if (!tool.success) return;
    const part = tool.data.properties.part;
    const existing = this.session(part.sessionID);
    const key = part.id ?? part.callID;
    if (key) existing.failures = existing.failures.filter(failure => failure.key !== key);
    existing.failures.push({ key, failure: Failure.parse({
      tool: /^[a-z0-9_-]{1,80}$/.test(part.tool) ? part.tool : 'unknown',
      input: safeToolInput(part.tool), error: safeToolError(part.state.error),
    }) });
    existing.failures = existing.failures.slice(-FRICTION_LIMITS.failures);
  }

  context(sessionID: string) {
    const existing = this.sessions.get(sessionID);
    return { model: existing?.model ?? 'unavailable', failures: existing?.failures.map(entry => entry.failure) ?? [] };
  }

  private session(sessionID: string) {
    let existing = this.sessions.get(sessionID);
    if (existing) return existing;
    if (this.sessions.size >= FRICTION_LIMITS.sessions) this.sessions.delete(this.sessions.keys().next().value!);
    existing = { failures: [], model: 'unavailable' };
    this.sessions.set(sessionID, existing);
    return existing;
  }
}

/** Prose is untrusted: retain the context of a failure, not credential values or patch bodies. */
export function safeProse(value: string) {
  if (secretShapesIn(value, ['privateKeyBlock']).length
    || /(?:^|\n)\s*(?:diff --git|@@ -\d|[+-]{3} [ab]\/)/.test(value)) throw new Error('friction_unsafe_text');
  return value.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|password|secret|api[_-]?key|authorization|cookie)\s*([:=])\s*\S+/gi, '$1$2[redacted]')
    .replace(/\b([A-Za-z_][A-Za-z_0-9]*)=(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/g, '$1=[redacted]')
    .replace(/(?:^|[\s/])\.env(?:\.[^\s]*)?/gi, ' [env file]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export async function engineCommit() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    const modulePath = fileURLToPath(import.meta.url).replace(/\/dist\/friction\.js$/, '/src/friction.ts');
    const { stdout } = await exec('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 2000 });
    await exec('git', ['-C', root, 'ls-files', '--error-unmatch', modulePath], { timeout: 2000 });
    const status = await exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { timeout: 2000 });
    return /^[a-f0-9]{40}$/.test(stdout.trim()) ? `${stdout.trim()}${status.stdout.trim() ? '-dirty' : ''}` : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function paths(runtime: Runtime) {
  const root = join(runtime.stateDirectory, 'friction');
  return { root, lock: join(root, 'records.lock'), records: join(root, 'records'),
    index: join(root, 'index.json'), submissions: join(root, 'submissions'), wakes: join(root, 'wakes'), pending: join(root, 'pending') };
}

async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

async function load(path: string) {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

function signature(owner: string, input: FrictionInput, failures: Failure[]) {
  const last = failures.at(-1);
  if (last) return { key: digest(JSON.stringify(['v1', owner, last.tool, last.error])), provisional: false };
  const normalized = [input.summary, input.expected, input.actual].map(text => text.toLowerCase()
    .replace(/\b(?:[a-f0-9]{8,}|\d+|ses_[\w-]+|[\w.-]+@[\w.-]+)\b/g, '#')
    .replace(/[^\p{L}# ]/gu, ' ').replace(/\s+/g, ' ').trim()).join('|');
  const meaningful = normalized.replace(/[|# ]/g, '').length >= 12;
  return { key: digest(JSON.stringify(['v1-no-failure-event', owner, meaningful ? normalized : randomUUID()])), provisional: true };
}

export interface FrictionSubmission {
  owner: string;
  origin: z.infer<typeof Origin>;
  model: string;
  commit: string;
  failures: Failure[];
  input: FrictionInput;
  submissionID: string;
}

async function recordIndex(location: ReturnType<typeof paths>) {
  const saved = await load(location.index);
  if (saved) return FrictionIndex.parse(JSON.parse(saved));
  const index: z.infer<typeof FrictionIndex> = {};
  const files = await readdir(location.records).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files.filter(file => /^fr_[a-f0-9]{24}\.json$/.test(file))) {
    const contents = await load(join(location.records, file));
    if (!contents || Buffer.byteLength(contents) > FRICTION_LIMITS.recordBytes) continue;
    try {
      const record = FrictionRecord.parse(JSON.parse(contents));
      if (`${record.id}.json` === file) index[record.id] = { lastSeen: record.lastSeen };
    } catch { /* Ignore malformed legacy records. */ }
  }
  await save(location.index, index);
  return index;
}

/** Record, wake and submission are serialized; notebook I/O never holds the record lock. */
export async function reportFriction(runtime: Runtime, submission: FrictionSubmission) {
  if (!runtime.declarations.owners.has(submission.owner)) throw new Error('friction_unknown_owner');
  const input = FrictionInput.parse(submission.input);
  const origin = Origin.parse(submission.origin);
  if (!submission.submissionID || submission.submissionID.length > 200) throw new Error('friction_invalid_submission');
  const cleaned = FrictionInput.parse(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, safeProse(value)])));
  const failures = z.array(Failure).max(FRICTION_LIMITS.failures).parse(submission.failures)
    .map(failure => Failure.parse({ tool: /^[a-z0-9_-]{1,80}$/.test(failure.tool) ? failure.tool : 'unknown',
      input: safeToolInput(failure.tool), error: safeToolError(failure.error) }));
  const { key, provisional } = signature(submission.owner, cleaned, failures);
  const id = `fr_${key}`;
  const location = paths(runtime);
  const { record, submissionPath } = await withRecordLock(location.lock, async () => {
    const submissionPath = join(location.submissions, `${digest(submission.submissionID)}.json`);
    const priorSubmission = await load(submissionPath);
    const prior = priorSubmission ? Submission.parse(JSON.parse(priorSubmission)) : undefined;
    const recordPath = join(location.records, `${prior?.id ?? id}.json`);
    const old = await load(recordPath);
    const previous = old ? FrictionRecord.parse(JSON.parse(old)) : undefined;
    if (prior && prior.id !== id) throw new Error('friction_submission_conflict');
    if (prior && !previous && (prior.journaled || prior.baseline !== 0)) throw new Error('friction_missing_record');
    const pendingPath = join(location.pending, `${id}.json`);
    const pendingID = await load(pendingPath);
    if (pendingID && JSON.parse(pendingID) !== digest(submission.submissionID)) throw new Error('friction_pending_submission');
    const now = new Date().toISOString();
    const wasApplied = prior && previous && (prior.baseline === undefined || previous.count > prior.baseline);
    const record = wasApplied ? previous : FrictionRecord.parse(previous
      ? { ...previous, count: previous.count + 1, lastSeen: now }
      : { version: 1, id, owner: submission.owner, ...cleaned, origin, firstSeen: now, lastSeen: now,
        count: 1, commit: submission.commit, model: /^[a-z0-9_.:/-]{1,160}$/i.test(submission.model) ? submission.model : 'unavailable',
        failures, failureContext: failures.length ? 'observed' : 'unavailable', provisional });
    if (Buffer.byteLength(JSON.stringify(record)) > FRICTION_LIMITS.recordBytes) throw new Error('friction_record_too_large');
    if (!prior) {
      await save(pendingPath, digest(submission.submissionID));
      await save(submissionPath, { id: record.id, journaled: false, baseline: previous?.count ?? 0 });
    }
    if (!wasApplied) {
      await save(recordPath, record);
    }
    const index = await recordIndex(location);
    if (index[record.id]?.lastSeen !== record.lastSeen) {
      index[record.id] = { lastSeen: record.lastSeen };
      await save(location.index, index);
    }
    if (pendingID || !prior) await unlink(pendingPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    // Repair an interrupted first submission without producing a second wake for an existing intent.
    const wakePath = join(location.wakes, `${record.id}.json`);
    if (!(await load(wakePath))) {
      await save(wakePath, Wake.parse({ id: record.id, at: record.firstSeen, status: 'pending' }));
    }
    return { record, submissionPath };
  });
  await withRecordLock(`${submissionPath}.lock`, async () => {
    const marker = Submission.parse(JSON.parse((await load(submissionPath))!));
    if (marker.journaled) return;
    const notebook = runtime.notebook(submission.owner);
    await notebook.journal({ kind: 'friction', note: `${record.id} (${record.count}): ${record.summary.slice(0, 160)}`, session: origin.sessionID });
    await save(submissionPath, { ...marker, journaled: true });
    await notebook.commit('friction').catch(() => undefined);
  });
  return record;
}

export async function listFriction(runtime: Runtime) {
  const location = paths(runtime);
  return withRecordLock(location.lock, async () => {
    const index = await recordIndex(location);
    const ids = Object.entries(index).sort((left, right) => right[1].lastSeen.localeCompare(left[1].lastSeen))
      .slice(0, FRICTION_LIMITS.list).map(([id]) => id);
    const records: FrictionRecord[] = [];
    for (const id of ids) {
      const contents = await load(join(location.records, `${id}.json`));
      if (!contents || Buffer.byteLength(contents) > FRICTION_LIMITS.recordBytes) continue;
      let parsed;
      try { parsed = FrictionRecord.safeParse(JSON.parse(contents)); } catch { continue; }
      if (parsed.success && parsed.data.id === id) records.push(parsed.data);
    }
    return records.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen)).slice(0, FRICTION_LIMITS.list);
  });
}

export async function frictionDetail(runtime: Runtime, id: string) {
  if (!FrictionRecord.shape.id.safeParse(id).success) throw new Error('friction_invalid_id');
  const location = paths(runtime);
  return withRecordLock(location.lock, async () => {
    const contents = await load(join(location.records, `${id}.json`));
    if (!contents || Buffer.byteLength(contents) > FRICTION_LIMITS.recordBytes) throw new Error('friction_not_found');
    let parsed;
    try { parsed = FrictionRecord.safeParse(JSON.parse(contents)); } catch { throw new Error('friction_invalid_record'); }
    if (!parsed.success || parsed.data.id !== id) throw new Error('friction_invalid_record');
    return parsed.data;
  });
}
