import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { WorkItem, isFinished } from './ledger.ts';
import { Handoff } from './ask-handoffs.ts';
import { Assignment } from './attention-assignment.ts';
import { Promotion } from './friction-promotion.ts';
import { ResourceRequest } from './requests.ts';
import { Reminder } from './reminders.ts';
import { SessionOpening, SessionOpeningStore } from './session-opening-store.ts';
import { OWNER_CHANGE_WORKFLOW } from './plan-work.ts';
import { neededSession } from './owner-sessions.ts';
import { OperatorJobLedger } from './operator-jobs-types.ts';
import { OperatorApplication } from './operator-application-types.ts';
import { OperatorHandoffExecution, operatorHandoffExecutionDigest } from './operator-handoff-execution.ts';
import { OperatorHandoffStore } from './operator-handoff-store.ts';
import { Revision } from './plan-revision.ts';
import { Wake as DirectReviewWake } from './direct-request-review-wake.ts';
import { Wakes as OperatorWakes } from './operator-job-wake.ts';
import { WorkNotice, describeChange } from './notices.ts';
import { ExchangeNotice } from './exchange-notices.ts';
import { WorkNoticeDelivery } from './work-notice-delivery.ts';

/** Request-progress notice state that older releases left behind; nothing writes it any more. */
const RequestProgressCursor = z.object({ sequence: z.number().int().nonnegative(), fingerprint: z.string(),
  pending: ExchangeNotice.optional() });
const RequestProgressBaseline = z.object({ version: z.literal(1), observedAt: z.string(),
  fingerprints: z.record(z.string(), z.string()) });

/** Only continuation stores are covered here. Configuration, processes, workspaces and
 * OpenCode transcripts must independently match the encompassing recovery proof. */
export const MAINTENANCE_RELEASE_STORES = ['items', 'requests', 'reminders', 'session-openings',
  'plan-revisions', 'direct-request-review-wakes', 'notices', 'operator-jobs', 'operator-job-wakes',
  'operator-applications', 'operator-handoffs', 'handoffs', 'attention/assignments', 'friction/promotions'] as const;
export const MAINTENANCE_RELEASE_INVENTORY_LIMITS = { entries: 100_000, bytes: 128 * 1024 * 1024 };
export interface MaintenanceInventoryEntry { path: string; type: 'absent' | 'directory' | 'file'; digest: string }
export interface MaintenanceInventoryDecision {
  resource: string;
  classification: 'terminal' | 'human-gated' | 'single-use-protected' | 'time-gated' | 'blocked';
  reason: string;
  validUntil?: string;
}
export interface MaintenanceReleaseInventory {
  version: 1;
  digest: string;
  entries: MaintenanceInventoryEntry[];
  decisions: MaintenanceInventoryDecision[];
  eligible: boolean;
  validUntil?: string;
}
interface Snapshot { entries: MaintenanceInventoryEntry[]; files: Map<string, string>; bytes: number }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function decision(resource: string, safe: boolean, reason: string,
  classification: MaintenanceInventoryDecision['classification'] = 'terminal'): MaintenanceInventoryDecision {
  return { resource, classification: safe ? classification : 'blocked', reason };
}
function unchanged(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}
async function walk(state: string, path: string, snapshot: Snapshot) {
  if (snapshot.entries.length >= MAINTENANCE_RELEASE_INVENTORY_LIMITS.entries) throw new Error('maintenance_inventory_limit');
  const full = join(state, path);
  const before = await lstat(full).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!before) { snapshot.entries.push({ path, type: 'absent', digest: hash('absent') }); return; }
  if (!before.isFile() && !before.isDirectory()) throw new Error(`maintenance_inventory_unsupported_file:${path}`);
  if (before.size + snapshot.bytes > MAINTENANCE_RELEASE_INVENTORY_LIMITS.bytes) throw new Error('maintenance_inventory_limit');
  const contents = before.isDirectory() ? JSON.stringify((await readdir(full)).sort()) : await readFile(full, 'utf8');
  if (!unchanged(before, await lstat(full))) throw new Error('maintenance_inventory_changed');
  snapshot.bytes += Buffer.byteLength(contents);
  if (snapshot.bytes > MAINTENANCE_RELEASE_INVENTORY_LIMITS.bytes) throw new Error('maintenance_inventory_limit');
  snapshot.entries.push({ path, type: before.isDirectory() ? 'directory' : 'file', digest: hash(contents) });
  if (before.isFile()) { snapshot.files.set(path, contents); return; }
  for (const name of JSON.parse(contents) as string[]) await walk(state, `${path}/${name}`, snapshot);
}
async function snapshot(state: string) {
  const current: Snapshot = { entries: [], files: new Map(), bytes: 0 };
  if (!(await lstat(state)).isDirectory()) throw new Error('maintenance_inventory_state_invalid');
  for (const store of MAINTENANCE_RELEASE_STORES) {
    const components = store.split('/');
    if (components.length > 1) {
      const parent = await lstat(join(state, components[0]!)).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (parent && !parent.isDirectory()) throw new Error('maintenance_inventory_parent_invalid');
    }
    await walk(state, store, current);
  }
  return current;
}
function boundPath(actual: string, expected: string) {
  if (actual !== expected) throw new Error(`maintenance_inventory_identity:${actual}`);
}
function parsed(files: Map<string, string>, path: string) { return JSON.parse(files.get(path)!); }
function jsonFiles(files: Map<string, string>, directory: string) {
  return [...files.keys()].filter(path => path.startsWith(`${directory}/`) && path.endsWith('.json'));
}
function openingProtected(opening: SessionOpening | undefined) {
  return Boolean(opening && (opening.phase !== 'blocked'
    || opening.history.some(entry => ['creating', 'created', 'prompting', 'opened', 'uncertain'].includes(entry.phase))));
}
function classifyItems(state: string, files: Map<string, string>) {
  const store = new SessionOpeningStore(state);
  return jsonFiles(files, 'items').map(path => {
    const item = WorkItem.parse(parsed(files, path));
    boundPath(path, `items/${item.id}.json`);
    if (item.activeRunner) return decision(path, false, 'work_runner_unresolved');
    if (item.deskPublication && item.deskPublication.stage !== 'complete') return decision(path, false, 'publication_unresolved');
    const cleanup = item.status === 'cancelled' || (item.status === 'landed'
      && ['merged', 'closed'].includes(item.publication?.state ?? ''));
    if (cleanup && item.planWorktree) return decision(path, false, 'plan_cleanup_requires_separate_evidence');
    const kind = neededSession(item);
    if (kind) {
      const key = { entity: 'owner-item' as const, id: item.id, owner: item.owner, kind };
      const openingPath = store.path(key).slice(state.length + 1);
      const opening = files.has(openingPath) ? SessionOpening.parse(parsed(files, openingPath)) : undefined;
      if (opening && JSON.stringify(opening.key) !== JSON.stringify(key)) throw new Error('maintenance_inventory_opening_identity');
      return decision(path, openingProtected(opening), openingProtected(opening)
        ? 'opening_single_use_claim_retained' : 'legacy_opening_without_single_use_claim', 'single-use-protected');
    }
    const safe = isFinished(item) || ['interrupted', 'proposed', 'awaiting-plan-approval'].includes(item.status)
      || (item.workflow === OWNER_CHANGE_WORKFLOW && Boolean(item.origin || item.session));
    return decision(path, safe, safe ? 'no_automatic_work_execution' : 'work_continuation_requires_evidence');
  });
}
function classifyReminders(state: string, files: Map<string, string>, now: number) {
  const store = new SessionOpeningStore(state);
  return jsonFiles(files, 'reminders').map(path => {
    const reminder = Reminder.parse(parsed(files, path));
    boundPath(path, `reminders/${reminder.id}.json`);
    if (reminder.status !== 'pending') return decision(path, true, 'reminder_terminal');
    if (reminder.session) return decision(path, true, 'reminder_session_claim_retained', 'single-use-protected');
    const key = { entity: 'reminder' as const, id: reminder.id, owner: reminder.owner, kind: 'reminder' as const };
    const openingPath = store.path(key).slice(state.length + 1);
    const opening = files.has(openingPath) ? SessionOpening.parse(parsed(files, openingPath)) : undefined;
    if (opening && JSON.stringify(opening.key) !== JSON.stringify(key)) throw new Error('maintenance_inventory_opening_identity');
    if (!openingProtected(opening) && Date.parse(reminder.dueAt) > now) {
      return { ...decision(path, true, 'reminder_not_due', 'time-gated'), validUntil: reminder.dueAt };
    }
    return decision(path, openingProtected(opening), openingProtected(opening)
      ? 'reminder_single_use_claim_retained' : 'legacy_reminder_without_single_use_claim', 'single-use-protected');
  });
}
function classifyJobs(files: Map<string, string>) {
  const path = 'operator-jobs/jobs.json';
  if (!files.has(path)) return [];
  return OperatorJobLedger.parse(parsed(files, path)).jobs.map(job => {
    const unsafe = job.children.some(child => child.operation || child.status === 'queued'
      || child.status === 'creating' || child.uncertainty?.kind === 'creation'
      || child.attempts.some(attempt => !attempt.endedAt)
      || child.write?.operations.some(operation => operation.status === 'prepared')
      || child.write?.checks?.some(check => check.status === 'prepared'));
    const terminal = ['completed', 'cancelled', 'paused'].includes(job.status)
      || job.children.every(child => ['completed', 'cancelled', 'abandoned', 'needs-review'].includes(child.status));
    return decision(`${path}#${job.id}`, !unsafe && terminal, !unsafe && terminal
      ? 'operator_job_inert_with_settled_children' : 'operator_job_continuation_requires_evidence');
  });
}
function classifyDeliveries(files: Map<string, string>) {
  const decisions: MaintenanceInventoryDecision[] = [];
  for (const path of jsonFiles(files, 'plan-revisions')) {
    const revision = Revision.parse(parsed(files, path));
    boundPath(path, `plan-revisions/${hash(revision.item)}.json`);
    const terminal = ['delivered', 'suppressed'].includes(revision.status);
    const claimed = revision.status !== 'prepared' && (revision.submitted || revision.status === 'sending'
      || revision.reason === 'plan_revision_delivery_uncertain');
    decisions.push(decision(path, terminal || claimed, terminal ? 'revision_terminal'
      : claimed ? 'revision_submission_claim_retained' : 'revision_unsubmitted', 'single-use-protected'));
  }
  for (const path of jsonFiles(files, 'direct-request-review-wakes')) {
    const wake = DirectReviewWake.parse(parsed(files, path));
    boundPath(path, `direct-request-review-wakes/${hash(JSON.stringify([wake.request, wake.digest]))}.json`);
    decisions.push(decision(path, Boolean(wake.messageID) || ['delivered', 'superseded'].includes(wake.status),
      wake.messageID ? 'review_wake_submission_claim_retained' : 'review_wake_unsubmitted', 'single-use-protected'));
  }
  const path = 'operator-job-wakes/wakes.json';
  if (files.has(path)) for (const wake of OperatorWakes.parse(parsed(files, path))) {
    decisions.push(decision(`${path}#${wake.digest}`, Boolean(wake.messageID) || ['delivered', 'superseded'].includes(wake.status),
      wake.messageID ? 'job_wake_submission_claim_retained' : 'job_wake_unsubmitted', 'single-use-protected'));
  }
  return decisions;
}
function noticeSeenDecision(files: Map<string, string>, path: string) {
  const seen: unknown = parsed(files, path);
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)
    || Object.values(seen).some(value => typeof value !== 'string')) throw new Error('maintenance_inventory_notice_seen_invalid');
  const previous = seen as Record<string, string>;
  const candidates = jsonFiles(files, 'items').map(path => WorkItem.parse(parsed(files, path)));
  const replay = candidates.some(item => describeChange(item, previous[item.id]) !== undefined);
  return decision(path, !replay, replay ? 'work_notice_regeneration_requires_evidence' : 'work_notice_observation_current');
}

function classifyNotices(files: Map<string, string>) {
  return jsonFiles(files, 'notices').map(path => {
    if (path === 'notices/seen.json') return noticeSeenDecision(files, path);
    if (path === 'notices/request-progress/baseline.json') {
      RequestProgressBaseline.parse(parsed(files, path));
      return decision(path, true, 'request_progress_baseline_retained');
    }
    if (path.startsWith('notices/request-progress/')) {
      if (!/^notices\/request-progress\/[a-f0-9]{64}\.json$/.test(path)) throw new Error('maintenance_inventory_identity');
      const cursor = RequestProgressCursor.parse(parsed(files, path));
      return decision(path, !cursor.pending, 'request_progress_cursor_pending_or_single_use', 'single-use-protected');
    }
    if (path.startsWith('notices/exchanges/')) {
      ExchangeNotice.parse(parsed(files, path));
      return decision(path, path.startsWith('notices/exchanges/delivered/')
        || path.startsWith('notices/exchanges/undeliverable/'), 'exchange_pending_requires_transcript_proof');
    }
    if (path.startsWith('notices/delivery/')) {
      WorkNoticeDelivery.parse(parsed(files, path));
      return decision(path, true, 'notice_delivery_history_not_dispatched');
    }
    WorkNotice.parse(parsed(files, path));
    return decision(path, path.startsWith('notices/delivered/'), 'notice_claim_retained_or_pending');
  });
}
function classifyRouting(files: Map<string, string>) {
  const decisions: MaintenanceInventoryDecision[] = [];
  for (const path of jsonFiles(files, 'handoffs')) {
    const handoff = Handoff.parse(parsed(files, path));
    boundPath(path, `handoffs/ask-${hash(JSON.stringify(handoff.input))}.json`);
    decisions.push(decision(path, handoff.routing.state !== 'pending' && handoff.journal.done, 'ask_handoff_routing_unresolved'));
  }
  for (const path of jsonFiles(files, 'attention/assignments')) {
    const assignment = Assignment.parse(parsed(files, path));
    boundPath(path, `attention/assignments/${hash(assignment.attention)}.json`);
    decisions.push(decision(path, assignment.status !== 'pending', 'attention_assignment_routing_unresolved'));
  }
  for (const path of jsonFiles(files, 'friction/promotions')) {
    const promotion = Promotion.parse(parsed(files, path));
    boundPath(path, `friction/promotions/${promotion.id}.json`);
    decisions.push(decision(path, promotion.state !== 'pending', 'friction_promotion_routing_unresolved'));
  }
  return decisions;
}

/** These states have no automatic request step. Historical operation receipts are not running work.
 * Interrupted operations are intentionally excluded: ordinary recovery can resume their saved stage. */
const INERT_REQUEST_STATUSES = new Set<ResourceRequest['status']>(['declined', 'denied', 'deleted', 'published',
  'updated', 'failed', 'completed', 'awaiting-create-approval', 'awaiting-delete-approval']);

function classifyRequest(path: string, request: ResourceRequest) {
  if (request.operation?.runner !== undefined) return decision(path, false, 'request_runner_unresolved');
  if (['awaiting-create-approval', 'awaiting-delete-approval'].includes(request.status)) {
    return decision(path, true, 'request_human_gate_retained', 'human-gated');
  }
  if (INERT_REQUEST_STATUSES.has(request.status)) {
    return decision(path, true, request.operation ? 'request_historical_operation_retained' : 'request_no_automatic_step');
  }
  return decision(path, request.status === 'interrupted' && !request.operation, 'request_continuation_gate');
}

async function classify(state: string, files: Map<string, string>, now: number) {
  const decisions = [...classifyItems(state, files), ...classifyReminders(state, files, now), ...classifyJobs(files),
    ...classifyDeliveries(files), ...classifyNotices(files)];
  for (const path of jsonFiles(files, 'requests')) {
    const request = ResourceRequest.parse(parsed(files, path));
    boundPath(path, `requests/${request.id}.json`);
    decisions.push(classifyRequest(path, request));
  }
  for (const path of jsonFiles(files, 'session-openings')) {
    const opening = SessionOpening.parse(parsed(files, path));
    if (new SessionOpeningStore(state).path(opening.key) !== join(state, path)) throw new Error('maintenance_inventory_opening_identity');
    decisions.push(decision(path, openingProtected(opening), 'opening_single_use_gate', 'single-use-protected'));
  }
  for (const path of jsonFiles(files, 'operator-applications')) {
    const application = OperatorApplication.parse(parsed(files, path));
    boundPath(path, `operator-applications/${application.scope.artifact.jobID}.json`);
    decisions.push(decision(path, application.status === 'applied' && Boolean(application.claimReleasedAt)
      && application.workers.every(worker => Boolean(worker.endedAt)), 'application_terminal_proof_required'));
  }
  if (files.has('operator-handoffs/records.json')) {
    const handoffs = await new OperatorHandoffStore(state).read();
    for (const record of handoffs.records) decisions.push(decision(`operator-handoffs/records.json#${record.artifact.jobID}`,
      record.checks.every(check => check.status === 'completed'), 'handoff_checks_terminal_proof_required'));
  }
  for (const path of jsonFiles(files, 'operator-handoffs/executions')) {
    const execution = OperatorHandoffExecution.parse(parsed(files, path));
    boundPath(path, `operator-handoffs/executions/${execution.binding.receiptID}.json`);
    const { digest, ...body } = execution;
    if (digest !== operatorHandoffExecutionDigest(body)) throw new Error('maintenance_inventory_handoff_integrity');
    const handoffs = await new OperatorHandoffStore(state).read();
    const bound = handoffs.records.some(record => record.executions?.some(binding =>
      JSON.stringify(binding) === JSON.stringify(execution.binding))
      && record.checks.some(check => check.id === execution.binding.receiptID && check.status === 'completed'));
    decisions.push(decision(path, bound && Boolean(execution.outcome), 'handoff_execution_terminal_binding_required'));
  }
  decisions.push(...classifyRouting(files));
  const classified = new Set(decisions.map(entry => entry.resource.split('#')[0]!));
  for (const path of files.keys()) {
    if (path.endsWith('.lock') && files.get(path) === '') {
      decisions.push(decision(path, true, 'inert_lock_inode_process_proof_separate'));
      continue;
    }
    if (!classified.has(path) && !['operator-jobs/jobs.json', 'operator-job-wakes/wakes.json', 'operator-handoffs/records.json'].includes(path)) {
      decisions.push(decision(path, false, 'unrecognized_continuation_file'));
    }
  }
  return decisions.sort((left, right) => left.resource.localeCompare(right.resource));
}

/** Read twice: a valid classification over torn or changed input is not release evidence. */
export async function inspectMaintenanceReleaseInventory(stateDirectory: string,
  effects: { afterSnapshot?: () => Promise<void>; now?: () => number } = {}): Promise<MaintenanceReleaseInventory> {
  const state = resolve(stateDirectory);
  const now = effects.now ?? Date.now;
  const first = await snapshot(state);
  const decisions = await classify(state, first.files, now());
  await effects.afterSnapshot?.();
  const second = await snapshot(state);
  if (JSON.stringify(first.entries) !== JSON.stringify(second.entries)) throw new Error('maintenance_inventory_changed');
  const validUntil = decisions.flatMap(entry => entry.validUntil ? [entry.validUntil] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const digest = hash(JSON.stringify({ version: 1, state, entries: first.entries, decisions, validUntil }));
  const inventory = { version: 1 as const, digest, entries: first.entries, decisions, validUntil,
    eligible: decisions.every(entry => entry.classification !== 'blocked') };
  assertMaintenanceReleaseInventoryFresh(inventory, now());
  return inventory;
}
/** File bytes can stay identical while a future reminder becomes runnable. Check again at gate commit. */
export function assertMaintenanceReleaseInventoryFresh(inventory: Pick<MaintenanceReleaseInventory, 'validUntil'>,
  now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('maintenance_inventory_clock_invalid');
  if (inventory.validUntil !== undefined
    && (!Number.isFinite(Date.parse(inventory.validUntil)) || now >= Date.parse(inventory.validUntil))) {
    throw new Error('maintenance_inventory_expired');
  }
}
export async function assertMaintenanceReleaseInventoryUnchanged(stateDirectory: string, expectedDigest: string,
  effects: { now?: () => number } = {}) {
  const current = await inspectMaintenanceReleaseInventory(stateDirectory, effects);
  if (current.digest !== expectedDigest) throw new Error('maintenance_inventory_changed');
  return current;
}
