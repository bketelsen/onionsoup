import { store, type Job } from './store.svelte.ts';
import { hasFailed, hasNextSteps, isTaken, nextStepsFor, subjectOf } from './jobs.ts';
import { summarizeError } from './reasons.ts';

/** How far back the inbox looks, and when a homelab source counts as stale. */
export const INBOX_LIMITS = { days: 14, staleHours: 24 };

export type InboxKind = 'next' | 'failed' | 'attention' | 'stale';
export type InboxItem = { key: string; kind: InboxKind; title: string; detail: string; at: string; href: string; action?: { label: string; href: string } };

const DISMISSED_KEY = 'onionsoup.inbox.dismissed';

/** Dismissals are a per-browser convenience; losing them only brings items back. */
function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export const inboxState = $state({ dismissed: readDismissed() });

export function dismiss(key: string) {
  inboxState.dismissed = new Set([...inboxState.dismissed, key]);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...inboxState.dismissed]));
  } catch { /* storage may be unavailable; the dismissal lasts for this page */ }
}

const isRecent = (iso: string) => store.now - Date.parse(iso) < INBOX_LIMITS.days * 86400000;
const recentJobs = () => store.jobList.filter((job) => isRecent(job.createdAt));

/** Completed jobs that might offer a next step but whose result is not loaded yet. */
export const jobsNeedingResults = () => recentJobs().filter((job) => job.status === 'completed' && hasNextSteps(job.capability) && job.result === undefined);

function nextItems(): InboxItem[] {
  return recentJobs().flatMap((job) => nextStepsFor(job).filter((next) => !isTaken(job, next)).map((next) => ({
    key: `next:${job.jobId}:${next.capability}`,
    kind: 'next' as const,
    title: `${next.label}: ${subjectOf(job) || job.capability}`,
    detail: `${job.capability} ${job.outcome ? `· ${job.outcome.label}` : ''}`,
    at: job.createdAt,
    href: `#/jobs/${job.jobId}`,
    action: { label: next.label, href: next.href },
  })));
}

/** A later job of the same capability and subject that went well supersedes a failure. */
const isSuperseded = (failed: Job) => store.jobList.some((job) => job.createdAt > failed.createdAt && job.capability === failed.capability
  && subjectOf(job) === subjectOf(failed) && job.status === 'completed' && !hasFailed(job));

function failedItems(): InboxItem[] {
  return recentJobs().filter((job) => hasFailed(job) && !job.parentJobId && !isSuperseded(job)).map((job) => ({
    key: `failed:${job.jobId}`,
    kind: 'failed' as const,
    title: `${job.capability} failed${subjectOf(job) ? `: ${subjectOf(job)}` : ''}`,
    detail: job.error ? summarizeError(job.error) : job.outcome?.label ?? job.status,
    at: job.createdAt,
    href: `#/jobs/${job.jobId}`,
  }));
}

const latestInvestigationJob = (sourceId: string) => store.jobList.find((job) => job.capability === 'homelab.investigate' && (job.input as { sourceId?: string }).sourceId === sourceId);

function attentionItems(): InboxItem[] {
  return store.sources.filter((source) => source.latestInvestigation?.attention).map((source) => {
    const job = latestInvestigationJob(source.sourceId);
    return {
      key: `attention:${source.sourceId}:${source.latestInvestigation!.at}`,
      kind: 'attention' as const,
      title: `${source.sourceId} needs attention`,
      detail: source.latestInvestigation!.summary,
      at: source.latestInvestigation!.at,
      href: job ? `#/jobs/${job.jobId}` : '#/homelab',
    };
  });
}

const isStale = (at: string | undefined) => !at || store.now - Date.parse(at) > INBOX_LIMITS.staleHours * 3600000;

function staleItems(): InboxItem[] {
  return store.sources.filter((source) => isStale(source.latestObservation?.at)).map((source) => ({
    key: `stale:${source.sourceId}:${source.latestObservation?.at ?? 'never'}`,
    kind: 'stale' as const,
    title: `${source.sourceId} ${source.latestObservation ? 'has not been observed recently' : 'has never been observed'}`,
    detail: source.detail,
    at: source.latestObservation?.at ?? new Date(store.now).toISOString(),
    href: '#/homelab',
    action: { label: 'Open homelab', href: '#/homelab' },
  }));
}

/** Each kind of item, in the order the inbox shows them. */
const RULES: Record<InboxKind, () => InboxItem[]> = { next: nextItems, attention: attentionItems, failed: failedItems, stale: staleItems };

export const INBOX_KINDS = Object.keys(RULES) as InboxKind[];

export function inboxItems(): InboxItem[] {
  return INBOX_KINDS.flatMap((kind) => RULES[kind]()).filter((item) => !inboxState.dismissed.has(item.key));
}
