import { clipped } from './chat-context.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isDirectReport } from './declarations.ts';
import { ExchangeNotice, queueExchangeNotice } from './exchange-notices.ts';
import { ExternalPrObservation, isPaused, type WorkItem, type WorkStatus } from './ledger.ts';
import { withRecordLock } from './record-lock.ts';
import { describeAsk, type ResourceRequest, type RequestStatus } from './requests.ts';
import type { Runtime } from './runtime.ts';
import { RequestWorkEvidence, readRequestWorkEvidence } from './request-work-evidence.ts';
import { RequestAcceptance } from './request-closure-types.ts';
import { getDirectRequestReview } from './direct-request-plan-review.ts';
import { directRequestReviewWakeStatus } from './direct-request-review-wake.ts';

export const REQUEST_STATUS_LIMITS = { staleMs: 24 * 60 * 60_000, recentMs: 7 * 24 * 60 * 60_000, noticesPerTick: 20, summaryRecords: 12, summaryChars: 12_000, fieldChars: 240 };
const RequestProgress = z.object({
  id: z.string(), from: z.string(), to: z.string(), purpose: z.string(), title: z.string(), status: z.string(),
  decision: z.string().optional(), reason: z.string().optional(), workItem: z.string().optional(),
  workStatus: z.string().optional(), workReason: z.string().optional(),
  publication: z.object({ url: z.string(), state: z.string() }).optional(),
  next: z.string(), lastRecordedAt: z.string(), observedAt: z.string(), stale: z.boolean(),
  evidence: z.enum(['recorded', 'linked_work_missing', 'linked_work_mismatch']),
  historicalMerge: ExternalPrObservation.optional(),
  acceptance: RequestAcceptance.optional(),
  hostEvidence: RequestWorkEvidence.optional(),
  hostEvidenceState: z.enum(['recorded', 'unavailable', 'superseded', 'stale']).default('unavailable'),
});
export type RequestProgress = z.infer<typeof RequestProgress>;

const REQUEST_NEXT: Record<RequestStatus, string> = {
  'pending-owner': 'Receiving owner must accept or decline.',
  declined: 'Requester can revise the approach; no work will start from this request.',
  'awaiting-create-approval': 'Wait for the configured create approval.',
  'create-approved': 'Runtime can execute the approved create step.',
  denied: 'Stopped at the person’s denial; do not reopen automatically.',
  provisioned: 'Requester follow-up or release is next.',
  'awaiting-delete-approval': 'Wait for delete approval; resource remains present.',
  'delete-approved': 'Runtime can execute the approved delete step.',
  deleted: 'Recorded resource cleanup complete.',
  published: 'Publication is recorded; consult its verification before broader health claims.',
  updated: 'Update is recorded; broader operating health is not established by this status.',
  failed: 'Requester must inspect the blocker before proposing a different approach.',
  interrupted: 'Reconcile uncertain effects before any retry.',
  'work-running': 'Receiving owner carries the linked work; inspect its recorded stage.',
  'work-paused': 'Intentionally paused; only an explicit human or configured-authority resume may continue the original work.',
  completed: 'Request completion is recorded; deployment is not implied by repository merge.',
};
const WORK_NEXT: Record<WorkStatus, string> = {
  proposed: 'Receiving owner must plan this proposal.', planning: 'Receiving owner is preparing the plan.',
  'awaiting-plan-approval': 'Wait for the person or configured manager’s plan approval.',
  working: 'Receiving owner is carrying out the approved plan.', implementing: 'Implementation is in progress.',
  pausing: 'Intentional stop is pending confirmation; active claims and uncertain receipts remain held.',
  paused: 'Intentionally paused; explicitly resume the same approved goal and plan when ready.',
  reviewing: 'Required review is in progress.', landing: 'Verified changes are being published.',
  'awaiting-push-approval': 'Wait for push approval.',
  landed: 'Inspect the PR state; landed or merged code does not establish deployment.',
  failed: 'Inspect the work blocker before proposing another approach.',
  rejected: 'The proposed method was rejected; do not restart it automatically.',
  interrupted: 'Reconcile interrupted work before any retry.', cancelled: 'Work was cancelled; no automatic continuation.',
};
const FINISHED = new Set<RequestStatus>(['declined', 'denied', 'deleted', 'published', 'updated', 'failed', 'completed']);

export function requestVisibleTo(runtime: Runtime, owner: string, request: ResourceRequest) {
  return request.from === owner || request.to === owner || isDirectReport(runtime.declarations, owner, request.to);
}

/** A fresh read of durable records, not a live probe of repositories, hosts, or deployments. */
export function requestProgress(request: ResourceRequest, item: WorkItem | undefined, now = new Date()): RequestProgress {
  const matches = item?.owner === request.to && item.request === request.id && item.id === request.workItem;
  const linked = matches ? item : undefined;
  const status = linked && isPaused(linked) && ['work-running', 'work-paused'].includes(request.status)
    ? 'work-paused' : request.status;
  const lastRecordedAt = linked && linked.updatedAt > request.updatedAt ? linked.updatedAt : request.updatedAt;
  const evidence = request.workItem && !linked ? (item ? 'linked_work_mismatch' : 'linked_work_missing') : 'recorded';
  const next = evidence !== 'recorded' ? 'Linked work is unavailable or inconsistent; inspect before claiming progress.'
    : linked?.requestAcceptance ? 'Original goal explicitly accepted against recorded follow-up evidence; deployment is not implied.'
      : ['work-running', 'work-paused'].includes(status) && linked ? WORK_NEXT[linked.status] : REQUEST_NEXT[status];
  return RequestProgress.parse({
    id: request.id, from: request.from, to: request.to, purpose: request.ask.purpose, title: describeAsk(request.ask), status,
    decision: request.publishDecision?.reply ?? request.decision?.reply, reason: request.reason,
    workItem: request.workItem, workStatus: linked?.status, workReason: linked?.reason,
    publication: linked?.publication ? { url: linked.publication.url, state: linked.publication.state } : undefined,
    ...(linked?.externalPrObservations?.length ? { historicalMerge: linked.externalPrObservations.at(-1) } : {}),
    ...(linked?.requestAcceptance ? { acceptance: linked.requestAcceptance } : {}),
    next, lastRecordedAt, observedAt: now.toISOString(),
    stale: !Number.isFinite(Date.parse(lastRecordedAt)) || now.getTime() - Date.parse(lastRecordedAt) > REQUEST_STATUS_LIMITS.staleMs,
    evidence,
  });
}

function hostEvidenceText(progress: RequestProgress, compact = false) {
  const evidence = progress.hostEvidence;
  if (!evidence) return 'Host tests/review: unavailable; no readable, matching request-scoped host evidence. Model claims do not establish verification.';
  const checks = evidence.verification;
  const review = evidence.review;
  if (evidence.operational) {
    const completion = evidence.operational;
    return [
      `Operational goal evidence: ${progress.hostEvidenceState}; recorded ${completion.completedAt}. No PR required.`,
      `Exact original work ${completion.item}, request ${completion.request}, execution session ${completion.execution.sessionID}.`,
      `Configured host checks: ${completion.verification.checks.map(check => `${check.command} exit=${check.exitCode}`).join(', ')}.`,
      `Independent goal review by ${review?.reviewer ?? 'unavailable'}: ${review?.verdict.decision ?? 'unavailable'}.`,
      ...completion.effects.map(effect => `Request ${effect.request}: ${effect.remote}:${effect.name}; ${effect.postcondition} observed ${effect.observedAt}; create/delete approvals recorded.`),
      evidence.abbreviated ? 'Evidence abbreviated; inspect the original request checkpoint for complete host records.' : '',
      'Evidence is bound to the recorded original scope. Completion requires the request projection; arbitrary current deployment claims remain unverified.',
    ].join('\n');
  }
  return [
    `Host attempt: ${evidence.stage}; ${progress.hostEvidenceState}; recorded ${evidence.observedAt}.`,
    checks ? `Host checks (${checks.verifier}) at ${checks.observedAt}, tree ${checks.tree}: ${checks.checks.length
      ? compact ? `${checks.checks.length} configured results, ${checks.checks.filter(check => check.exitCode !== 0).length} failed (details on request)`
        : checks.checks.map(check => `#${check.configurationIndex} ${check.command} exit=${check.exitCode}`).join(', ')
      : 'none configured; no host checks ran'}.` : 'Host checks: unknown; no completed results recorded for this attempt.',
    review ? `Review by ${review.reviewer}: ${review.verdict.decision}; ${review.verdict.summary}\n${(compact ? review.verdict.findings.slice(0, 1) : review.verdict.findings)
      .map(finding => `[${finding.severity}] ${finding.file}: ${finding.issue}; ${finding.suggestion}`).join('\n')}`
      : 'Review: unknown; no completed review recorded for this attempt.',
    evidence.blocker && `Host blocker: ${evidence.blocker}.`,
    evidence.abbreviated && 'Host evidence abbreviated; additional findings/checks may be omitted. Inspect the receiving owner’s review record before deciding.',
    compact ? 'Attempt evidence only; current workspace/deployment unknown. Read request detail for full recorded findings.'
      : 'Evidence describes that attempt only; current workspace, deployment and goal completion are unknown. Superseded evidence does not verify the current plan.',
  ].filter(Boolean).join('\n');
}

function historicalFollowUpText(progress: RequestProgress, compact: boolean) {
  const observation = progress.historicalMerge;
  const evidence = observation?.followUpEvidence;
  const review = evidence?.review;
  if (!observation || !evidence || !review) return '';
  return [
    `Review at historical observation: ${review.reviewer}; ${review.verdict.decision}; tree ${observation.tree}; recorded ${evidence.observedAt}. ${progress.acceptance
      ? 'Historical verdict retained; current acceptance is recorded separately below.' : 'Findings remain follow-up, not historical approval.'}`,
    compact ? clipped(review.verdict.summary, REQUEST_STATUS_LIMITS.fieldChars) : review.verdict.summary,
    ...(compact ? review.verdict.findings.slice(0, 1) : review.verdict.findings)
      .map(finding => `[${finding.severity}] ${finding.file}: ${finding.issue}; ${finding.suggestion}`),
    evidence.blocker && `Blocker at observation: ${evidence.blocker}.`,
    evidence.abbreviated && 'Historical evidence was abbreviated; inspect the original review record for complete findings.',
    'Snapshot of that attempt only; later review and acceptance are separate. No follow-up work was dispatched.',
  ].filter(Boolean).join('\n');
}

function acceptanceText(progress: RequestProgress, compact: boolean) {
  const receipt = progress.acceptance;
  if (!receipt) return '';
  const candidate = receipt.candidate;
  const note = compact ? clipped(receipt.note, REQUEST_STATUS_LIMITS.fieldChars) : receipt.note;
  return [
    `Goal accepted by ${receipt.by} at ${receipt.acceptedAt}: ${note}`,
    `Closure ${candidate.digest}; integrated commit ${candidate.head}; tree ${candidate.tree}.`,
    compact ? `${candidate.followUps.length} verified follow-up merges; see request detail.`
      : `Follow-up merges: ${candidate.followUps.map(merge => `${merge.url} (${merge.mergeCommit})`).join(', ')}.`,
    `Closure host checks: ${candidate.verification.checks.length}; independent review by ${candidate.review.reviewer}: ${candidate.review.verdict.decision}.`,
    compact ? `${candidate.review.resolutions.length} historical findings explicitly assessed; see request detail.`
      : candidate.review.resolutions.map(resolution => `${resolution.finding}: ${resolution.disposition}; ${resolution.evidence}`).join('\n'),
    'Acceptance records the original goal against this evidence; it does not rewrite the historical review or establish deployment.',
  ].join('\n');
}

export function requestProgressText(progress: RequestProgress, compact = false) {
  return [
    `${progress.id}: ${progress.from} → ${progress.to}; ${progress.title}; request ${progress.status}`,
    `Goal: ${progress.purpose}`,
    progress.decision && `Receiver decision: ${progress.decision}`,
    progress.reason && `Request reason: ${progress.reason}`,
    progress.workItem && `Linked work ${progress.workItem}: ${progress.workStatus ?? 'unknown'}${progress.workReason ? `; ${progress.workReason}` : ''}`,
    progress.publication && `PR ${progress.publication.url}: ${progress.publication.state} (recorded; deployment unknown).`,
    progress.historicalMerge && `Historical PR ${progress.historicalMerge.url}: merged ${progress.historicalMerge.mergeCommit}; acceptance was pending at observation ${progress.historicalMerge.observedAt}. This observation does not complete the request or establish deployment.`,
    historicalFollowUpText(progress, compact),
    hostEvidenceText(progress, compact),
    acceptanceText(progress, compact),
    `Next: ${progress.next}`,
    `Records read at ${progress.observedAt}; last recorded change ${progress.lastRecordedAt}${progress.stale ? ' (stale)' : ''}; ${progress.evidence}. Live state not probed.`,
  ].filter(Boolean).join('\n');
}

function compactProgress(progress: RequestProgress) {
  const maximum = REQUEST_STATUS_LIMITS.fieldChars;
  const hasAbbreviation = [hostEvidenceText(progress), progress.purpose, progress.title, progress.reason, progress.workReason, progress.decision, progress.publication?.url]
    .some(value => value && value.length > maximum);
  const compact = { ...progress, purpose: clipped(progress.purpose, maximum), title: clipped(progress.title, maximum),
    reason: progress.reason ? clipped(progress.reason, maximum) : undefined,
    workReason: progress.workReason ? clipped(progress.workReason, maximum) : undefined,
    decision: progress.decision ? clipped(progress.decision, maximum) : undefined,
    publication: progress.publication ? { ...progress.publication, url: clipped(progress.publication.url, maximum) } : undefined };
  const note = hasAbbreviation ? `\nDetails abbreviated (including any long blocker); use onionsoup_status request=${progress.id}.` : '';
  return requestProgressText(compact, true) + note;
}

/** Exact linked identities only; unavailable/corrupt sidecars cannot widen request access. */
async function recordedProgress(runtime: Runtime, request: ResourceRequest, item: WorkItem | undefined, now = new Date()) {
  const progress = requestProgress(request, item, now);
  if (!item || item.owner !== request.to || item.request !== request.id || item.id !== request.workItem) return progress;
  const evidence = await readRequestWorkEvidence(runtime, item).catch(() => undefined);
  if (!evidence) return progress;
  progress.hostEvidence = evidence;
  progress.hostEvidenceState = evidence.planDigest !== item.planDocument?.digest ? 'superseded'
    : now.getTime() - Date.parse(evidence.observedAt) > REQUEST_STATUS_LIMITS.staleMs ? 'stale' : 'recorded';
  if (evidence.operational && request.status === 'completed') {
    progress.next = 'Original operational goal verified by host checks, postconditions and independent review; no PR required.';
  }
  if (evidence.observedAt > progress.lastRecordedAt) {
    progress.lastRecordedAt = evidence.observedAt;
    progress.stale = now.getTime() - Date.parse(evidence.observedAt) > REQUEST_STATUS_LIMITS.staleMs;
  }
  return progress;
}

/** Exact request lookup uses the same visibility boundary as summaries. */
export async function requestProgressDetail(runtime: Runtime, owner: string, id: string) {
  if (!/^r-[a-zA-Z0-9-]+$/.test(id)) return 'request_id_invalid';
  const request = await runtime.requests.get(id).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!request || !requestVisibleTo(runtime, owner, request)) return 'No visible request with that ID.';
  const item = request.workItem ? await runtime.ledger.get(request.workItem).catch(() => undefined) : undefined;
  const progress = requestProgressText(await recordedProgress(runtime, request, item));
  return progress + await directPlanReviewDetail(runtime, request, item);
}

async function directPlanReviewDetail(runtime: Runtime, request: ResourceRequest, item: WorkItem | undefined) {
  if (request.ask.kind !== 'work' || request.ask.assignment || !item || item.request !== request.id || item.owner !== request.to) return '';
  const receipts = item.directRequestPlanReviews.map(review => `${review.decision}; scope ${review.scope}; ${review.reviewer} at ${review.at}; binding ${review.digest}: ${review.note}`);
  const history = receipts.length ? `\nDirect-request plan reviews:\n${receipts.join('\n')}` : '';
  if (item.status !== 'awaiting-plan-approval') return history;
  try {
    const review = await getDirectRequestReview(runtime, request.id);
    const wake = await directRequestReviewWakeStatus(runtime, request.id, review.digest);
    return history + [
      '', `Direct-request plan review: ${review.reviewed ? 'decision recorded; see above' : `eligible requester ${review.reviewer} under existing approve-plans grant`}.`,
      `Exact binding: request=${request.id}; item=${item.id}; digest=${review.digest}.`,
      `Review continuation: ${wake ? `${wake.status}${wake.reason ? ` (${wake.reason})` : ''}` : 'not queued yet'}. Informational progress notices do not start review.`,
      `Original request purpose: ${review.request.ask.purpose}`,
      `Original requested scope: ${JSON.stringify(review.request.ask)}`,
      `Submitted proposal: ${JSON.stringify(review.item.proposal)}`,
      `Submitted plan:\n${review.item.planDocument!.markdown}`,
      'Compare all constraints and assumptions before onionsoup_review_request_plan. Extra or uncertain scope requires needs-human; the person may approve or revise in the inbox. Merge/draft boundaries are unchanged.',
    ].join('\n');
  } catch (error) {
    if (!(error instanceof Error) || !/^(direct_plan_review_|not_awaiting_plan_approval:)/.test(error.message)) throw error;
    return history + `\nDirect-request plan review unavailable: ${error.message}. The person can decide in the inbox; do not promise automatic approval.`;
  }
}

export async function requestProgressSummary(runtime: Runtime, owner: string, now = new Date(), offset = 0) {
  const requests = (await runtime.requests.list()).filter(request => requestVisibleTo(runtime, owner, request))
    .filter(request => !FINISHED.has(request.status) || now.getTime() - Date.parse(request.updatedAt) <= REQUEST_STATUS_LIMITS.recentMs)
    .sort((left, right) => Number(FINISHED.has(left.status)) - Number(FINISHED.has(right.status))
      || right.updatedAt.localeCompare(left.updatedAt));
  if (!requests.length) return '';
  const items = new Map((await runtime.ledger.list()).map(item => [item.id, item]));
  const sections = [`Cross-owner progress (records read ${now.toISOString()}):`];
  let count = 0;
  for (const request of requests.slice(offset, offset + REQUEST_STATUS_LIMITS.summaryRecords)) {
    const entry = compactProgress(await recordedProgress(runtime, request, request.workItem ? items.get(request.workItem) : undefined, now));
    if (sections.join('\n\n').length + entry.length + REQUEST_STATUS_LIMITS.fieldChars > REQUEST_STATUS_LIMITS.summaryChars) break;
    sections.push(entry);
    count++;
  }
  const omitted = requests.length - offset - count;
  if (omitted > 0) sections.push(`${omitted} additional requests omitted; blockers may be among them. Read onionsoup_status offset=${offset + count} for the next page; use request=<id> for full details.`);
  if (!count) sections.push('No requests on this page.');
  return sections.join('\n\n');
}

export const Cursor = z.object({ sequence: z.number().int().nonnegative(), fingerprint: z.string(), pending: ExchangeNotice.optional() });
type Cursor = z.infer<typeof Cursor>;
function fingerprint(progress: RequestProgress) {
  const { observedAt: _observedAt, lastRecordedAt: _lastRecordedAt, stale: _stale, hostEvidence, hostEvidenceState, ...significant } = progress;
  // Preserve pre-evidence fingerprints: upgrading must not replay every historical request.
  const evidenceState = hostEvidenceState === 'stale' ? 'recorded' : hostEvidenceState;
  const current = hostEvidence ? { ...significant, hostEvidence, hostEvidenceState: evidenceState } : significant;
  return createHash('sha256').update(JSON.stringify(current)).digest('hex');
}
async function saveCursor(path: string, cursor: Cursor) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(cursor) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
async function enqueuePending(runtime: Runtime, path: string, cursor: Cursor) {
  if (!cursor.pending) return cursor;
  await queueExchangeNotice(runtime, cursor.pending.owner, cursor.pending.text, cursor.pending);
  const queued = { ...cursor, pending: undefined };
  await saveCursor(path, queued);
  return queued;
}

export const Baseline = z.object({ version: z.literal(1), observedAt: z.string(),
  fingerprints: z.record(z.string(), z.string()) });

/** Persist the entire first snapshot before queueing anything; an interrupted bootstrap has no partial effects. */
async function noticeBaseline(runtime: Runtime, progress: readonly RequestProgress[]) {
  const directory = join(runtime.stateDirectory, 'notices', 'request-progress');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'baseline.json');
  return withRecordLock(`${path}.lock`, async () => {
    const previous = await readFile(path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (previous) return Baseline.parse(JSON.parse(previous));
    const baseline = Baseline.parse({ version: 1, observedAt: new Date().toISOString(),
      fingerprints: Object.fromEntries(progress.map(entry => [entry.id, fingerprint(entry)])) });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(baseline) + '\n', { mode: 0o600 });
    await rename(temporary, path);
    return baseline;
  });
}

async function noticeRequest(runtime: Runtime, request: ResourceRequest, progress: RequestProgress, baselineFingerprint = '', pendingOnly = false) {
  if (!request.origin) return false;
  const directory = join(runtime.stateDirectory, 'notices', 'request-progress');
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(request.id).digest('hex');
  const path = join(directory, `${key}.json`);
  return withRecordLock(`${path}.lock`, async () => {
    const contents = await readFile(path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    let cursor = contents ? Cursor.parse(JSON.parse(contents)) : { sequence: 0, fingerprint: baselineFingerprint };
    const hadPending = Boolean(cursor.pending);
    cursor = await enqueuePending(runtime, path, cursor);
    if (pendingOnly || !runtime.declarations.owners.has(request.from)) return hadPending;
    const nextFingerprint = fingerprint(progress);
    if (cursor.fingerprint === nextFingerprint) return hadPending;
    const sequence = cursor.sequence + 1;
    // Existing delivery sorts message IDs: preserve transition order within each request.
    const id = `msg_${key.slice(0, 16)}${sequence.toString(16).padStart(16, '0')}`;
    const pending = ExchangeNotice.parse({ id, owner: request.from, target: request.origin,
      text: `Request progress (informational; no new authorization):\n${compactProgress(progress)}`,
      at: progress.observedAt });
    const next = { sequence, fingerprint: nextFingerprint, pending };
    await saveCursor(path, next);
    await enqueuePending(runtime, path, next);
    return true;
  });
}

/** Queue informational updates only; never hire a model, approve, retry or dispatch work. */
export async function noticeRequestProgress(runtime: Runtime, onError: (id: string, error: unknown) => void) {
  const items = new Map((await runtime.ledger.list()).map(item => [item.id, item]));
  const cutoff = Date.now() - REQUEST_STATUS_LIMITS.recentMs;
  const requests = (await runtime.requests.list()).filter(request => request.origin);
  const eligible = new Set(requests.filter(request => !FINISHED.has(request.status) || Date.parse(request.updatedAt) >= cutoff
    || Date.parse(request.workItem ? items.get(request.workItem)?.updatedAt ?? '' : '') >= cutoff).map(request => request.id));
  const projections = new Map(await Promise.all(requests.map(async request => {
    const item = request.workItem ? items.get(request.workItem) : undefined;
    return [request.id, eligible.has(request.id) ? await recordedProgress(runtime, request, item) : requestProgress(request, item)] as const;
  })));
  const baseline = await noticeBaseline(runtime, [...projections.values()]);
  let processed = 0;
  for (const request of requests) {
    try {
      if (processed >= REQUEST_STATUS_LIMITS.noticesPerTick) break;
      if (await noticeRequest(runtime, request, projections.get(request.id)!, baseline.fingerprints[request.id], !eligible.has(request.id))) processed++;
    } catch (error) { onError(request.id, error); }
  }
  return processed;
}
