import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AttentionIndex } from './attention.ts';
import { Assignment } from './attention-assignment.ts';
import { Handoff } from './ask-handoffs.ts';
import { AdmissionRecord, DeploymentIntent } from './deployment-admission.ts';
import { FRICTION_LIMITS, FrictionIndex, FrictionRecord, Wake } from './friction.ts';
import { FrictionTriagePolicy, Triage } from './friction-work.ts';
import { Promotion } from './friction-promotion.ts';
import { WorkItem } from './ledger.ts';

export const CONTINUITY_PREVIEW_LIMITS = { files: 200, fileBytes: 1_048_576 };
const Limits = z.object({ files: z.number().int().min(1).max(1_000), fileBytes: z.number().int().min(1).max(8_388_608) });
type Issue = { section: string; id?: string; reason: 'missing' | 'unreadable' | 'too_large' | 'truncated' };
type Scope = { availability: 'present' | 'absent' | 'unavailable'; visited: number; examined: number; valid: number; truncated: boolean; complete: boolean };
type SummaryEntry = { id: string; status: string };
function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

const frictionName = /^fr_[a-f0-9]{24}\.json$/;

class Reader {
  readonly issues: Issue[] = [];
  constructor(readonly limits: z.infer<typeof Limits>) {}

  async json<T>(path: string, schema: z.ZodType<T>, section: string, id?: string, optional = false): Promise<T | undefined> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) {
          this.issues.push({ section, id, reason: 'unreadable' });
          return undefined;
        }
        const buffer = Buffer.alloc(this.limits.fileBytes + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > this.limits.fileBytes) {
          this.issues.push({ section, id, reason: 'too_large' });
          return undefined;
        }
        return schema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing || !optional) this.issues.push({ section, id, reason: missing ? 'missing' : 'unreadable' });
      return undefined;
    }
  }

  async scan<T>(directory: string, names: RegExp, schema: z.ZodType<T>, section: string,
    select: (entry: T, name: string) => SummaryEntry | undefined) {
    const entries: SummaryEntry[] = [];
    const scope: Scope = { availability: 'unavailable', visited: 0, examined: 0, valid: 0, truncated: false, complete: true };
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error('preview_directory_not_regular');
      scope.availability = 'present';
      for await (const file of await opendir(directory)) {
        if (scope.visited >= this.limits.files) {
          scope.truncated = true;
          this.issues.push({ section, reason: 'truncated' });
          break;
        }
        scope.visited++;
        if (!names.test(file.name)) {
          if (file.name.endsWith('.json')) {
            this.issues.push({ section, reason: 'unreadable' });
            scope.complete = false;
          }
          continue;
        }
        scope.examined++;
        const record = await this.json(join(directory, file.name), schema, section, file.name);
        if (!record) { scope.complete = false; continue; }
        scope.valid++;
        const entry = select(record, file.name);
        if (entry) entries.push(entry);
      }
    } catch (error) {
      scope.complete = false;
      scope.availability = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable';
      if (scope.availability === 'unavailable') this.issues.push({ section, reason: 'unreadable' });
    }
    scope.complete = scope.complete && !scope.truncated;
    return { scope, entries: entries.sort((left, right) => compare(left.id, right.id)), counts: counts(entries) };
  }
}

function counts(entries: SummaryEntry[]) {
  const totals: Record<string, number> = {};
  for (const entry of entries) totals[entry.status] = (totals[entry.status] ?? 0) + 1;
  return Object.fromEntries(Object.entries(totals).sort(([left], [right]) => compare(left, right)));
}

async function frictionPreview(reader: Reader, state: string, policy: z.infer<typeof FrictionTriagePolicy> | undefined) {
  const index = await reader.json(join(state, 'friction/index.json'), FrictionIndex, 'friction-index');
  const ordered = Object.entries(index ?? {}).sort((left, right) => compare(right[1].lastSeen, left[1].lastSeen) || compare(left[0], right[0]));
  const selected = ordered.slice(0, Math.min(FRICTION_LIMITS.list, reader.limits.files));
  const entries: SummaryEntry[] = [];
  for (const [id] of selected) {
    const report = await reader.json(join(state, 'friction/records', `${id}.json`), FrictionRecord, 'friction-record', id);
    if (!report || report.id !== id) { entries.push({ id, status: 'unknown-record' }); continue; }
    if (!policy) { entries.push({ id, status: 'excluded-policy-unavailable' }); continue; }
    if (Date.parse(report.firstSeen) < Date.parse(policy.enabledSince)) { entries.push({ id, status: 'excluded-before-cutoff' }); continue; }
    const wake = await reader.json(join(state, 'friction/wakes', `${id}.json`), Wake, 'friction-wake', id);
    if (!wake || wake.id !== id || wake.at !== report.firstSeen) { entries.push({ id, status: 'unknown-wake' }); continue; }
    const before = reader.issues.length;
    const triage = await reader.json(join(state, 'friction/investigations', `${id}.json`), Triage, 'friction-triage', id, true);
    const status = reader.issues.length > before || (triage && triage.id !== id) ? 'unknown-triage'
      : triage ? `existing-${triage.state}` : 'eligible-candidate';
    entries.push({ id, status });
  }
  return { indexedCount: index ? ordered.length : null, recentWindowLimit: FRICTION_LIMITS.list,
    examined: selected.length, outsideRecentWindow: index ? Math.max(0, ordered.length - FRICTION_LIMITS.list) : null,
    truncatedWithinWindow: selected.length < Math.min(ordered.length, FRICTION_LIMITS.list),
    indexAvailable: Boolean(index), counts: counts(entries), entries,
    eligibility: 'Candidates only: authority, cadence, busy owners and current source still require runtime checks. No replay is authorized.' };
}

async function attentionPreview(reader: Reader, state: string) {
  const index = await reader.json(join(state, 'attention/index.json'), AttentionIndex, 'attention-index');
  const acknowledged = Object.values(index?.entries ?? {}).filter(entry => entry.status === 'acknowledged').sort((left, right) => compare(left.id, right.id));
  const selected = acknowledged.slice(0, reader.limits.files);
  const entries: SummaryEntry[] = [];
  for (const entry of selected) {
    const key = createHash('sha256').update(entry.id).digest('hex');
    const before = reader.issues.length;
    const assignment = await reader.json(join(state, 'attention/assignments', `${key}.json`), Assignment, 'attention-assignment', entry.id, true);
    entries.push({ id: entry.id, status: reader.issues.length > before ? 'unknown-assignment'
      : assignment ? 'has-assignment' : 'acknowledged-without-assignment' });
  }
  return { cachedIndexOnly: true, indexAvailable: Boolean(index), cutoff: index?.cutoff,
    acknowledgedCount: index ? acknowledged.length : null, examined: selected.length, truncated: selected.length < acknowledged.length,
    automaticallyEligible: false, counts: counts(entries), entries };
}

async function directoryAvailability(path: string) {
  try {
    return (await lstat(path)).isDirectory() ? 'present' : 'unavailable';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable';
  }
}

/** Read-only, non-atomic metadata snapshot. No Runtime.open, locks, index discovery, hires or network calls. */
export async function continuityPreview(paths: { state: string; declarations: string }, overrides: Partial<z.infer<typeof Limits>> = {}) {
  const reader = new Reader(Limits.parse({ ...CONTINUITY_PREVIEW_LIMITS, ...overrides }));
  const policy = await reader.json(join(paths.declarations, 'friction-triage.json'), FrictionTriagePolicy, 'policy', undefined, true);
  const policyInvalid = reader.issues.some(issue => issue.section === 'policy');
  const friction = await frictionPreview(reader, paths.state, policy);
  const attention = await attentionPreview(reader, paths.state);
  const handoffs = await reader.scan(join(paths.state, 'handoffs'), /^ask-[a-f0-9]{64}\.json$/, Handoff, 'handoffs', (entry, name) => ({ id: name.slice(0, -5), status: entry.routing.state }));
  const assignments = await reader.scan(join(paths.state, 'attention/assignments'), /^[a-f0-9]{64}\.json$/, Assignment, 'assignments', entry => ({ id: entry.attention, status: entry.status }));
  const promotions = await reader.scan(join(paths.state, 'friction/promotions'), frictionName, Promotion, 'promotions', entry => ({ id: entry.id, status: entry.state }));
  const investigations = await reader.scan(join(paths.state, 'friction/investigations'), frictionName, Triage, 'investigations', entry => ({ id: entry.id, status: entry.state }));
  const admissions = await reader.scan(join(paths.state, 'deploy/leases'), /^[a-f0-9-]{36}\.json$/, AdmissionRecord, 'admissions', entry => ({ id: entry.id, status: 'persisted-lease-liveness-unknown' }));
  const work = await reader.scan(join(paths.state, 'items'), /^w-[a-zA-Z0-9-]+\.json$/, WorkItem, 'work', entry =>
    entry.activeRunner !== undefined ? { id: entry.id, status: 'persisted-runner-liveness-unknown' } : undefined);
  const intent = await reader.json(join(paths.state, 'deploy/pending.json'), DeploymentIntent, 'deployment-intent', undefined, true);
  const selection = { stateDirectory: await directoryAvailability(paths.state), policy: policy ? { state: 'configured', ...policy } : { state: policyInvalid ? 'invalid' : 'disabled' },
    friction, attention, handoffs, assignments, promotions, investigations, deployment: { intent: intent?.status,
      admissions, work, readiness: 'not-certified', note: 'Persisted leases/runners may be stale; live chats and deployment admission must be checked separately.' },
    limits: reader.limits, issues: reader.issues.sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))) };
  return { version: 1, sampledAt: new Date().toISOString(), selectionDigest: createHash('sha256').update(JSON.stringify(selection)).digest('hex'),
    warning: 'Read-only preview. This digest is not approval, a backfill manifest, a deployment clearance or authorization to replay anything.',
    consistency: 'Best-effort non-atomic snapshot; repeat before any reviewed action. Counts apply only to the stated cached/bounded scopes.', ...selection };
}
