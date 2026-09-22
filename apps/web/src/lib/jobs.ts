import { store, type Job } from './store.svelte.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Jobs this one builds on: IDs inside its input (readinessJobId, packetJobId, …) and its recipe parent. */
export function referencesOf(job: Job): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string' && UUID.test(value) && store.jobs[value]) found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(job.input);
  if (job.parentJobId) found.push(job.parentJobId);
  return [...new Set(found)];
}

/** Jobs that build on this one, newest first. */
export const childrenOf = (jobId: string) => store.jobList.filter((job) => job.jobId !== jobId && referencesOf(job).includes(jobId));

type Input = Record<string, unknown>;
/** Ways to name what a job was about, from its input. The first that applies wins. */
const SUBJECTS: ((input: Input) => string | undefined)[] = [
  (input) => (typeof input.repository === 'string' && typeof input.issue === 'number' ? `${input.repository} #${input.issue}` : undefined),
  (input) => (typeof input.repository === 'string' && typeof input.title === 'string' ? `${input.repository} · ${input.title}` : undefined),
  (input) => (typeof input.repository === 'string' && typeof input.query === 'string' ? `${input.repository} · “${input.query}”` : undefined),
  (input) => (typeof input.repository === 'string' ? input.repository : undefined),
  (input) => (typeof input.sourceId === 'string' ? input.sourceId : undefined),
  (input) => (typeof input.agent === 'string' ? input.agent : undefined),
];
const MAX_SUBJECT_DEPTH = 6;

/** A short name for what the job was about; jobs that build on another job inherit its subject. */
export function subjectOf(job: Job, depth = 0): string {
  const input = (job.input ?? {}) as Input;
  const own = SUBJECTS.map((rule) => rule(input)).find(Boolean);
  if (own || depth >= MAX_SUBJECT_DEPTH) return own ?? '';
  const parent = referencesOf(job).map((id) => store.jobs[id]).find((j) => j && j.jobId !== job.parentJobId);
  return parent ? subjectOf(parent, depth + 1) : '';
}

export type NextStep = { label: string; capability: string; href: string; input: Record<string, string> };
type NextRule = (job: Job) => NextStep[];

const step = (label: string, capability: string, field: string, job: Job): NextStep[] =>
  store.capability(capability) ? [{ label, capability, input: { [field]: job.jobId }, href: `#/run/${capability}?${field}=${job.jobId}` }] : [];
const isReadyBug = (job: Job) => {
  const result = job.result as { run?: { assessment?: { kind?: string; bug_readiness?: string } } } | undefined;
  return result?.run?.assessment?.kind === 'bug_report' && result.run.assessment.bug_readiness === 'ready';
};
const isVerified = (job: Job) => (job.result as { outcome?: string } | undefined)?.outcome === 'candidate_verified';

/** What a person can do with a completed job, keyed by the capability that produced it. */
const NEXT: Record<string, NextRule> = {
  'issue.readiness': (job) => (isReadyBug(job) ? step('Locate code', 'code.location', 'readinessJobId', job) : []),
  'investigation.packet': (job) => step('Draft proposal', 'change.proposal', 'packetJobId', job),
  'change.proposal': (job) => step('Approve for implementation', 'change.approve', 'proposalJobId', job),
  'change.approve': (job) => step('Implement', 'change.implement', 'approvalJobId', job),
  'change.request': (job) => step('Implement', 'change.implement', 'approvalJobId', job),
  'change.implement': (job) => (isVerified(job) ? step('Publish draft PR', 'change.publish', 'implementJobId', job) : []),
};

/** Capabilities whose completed jobs can lead somewhere; the inbox reads their results to decide. */
export const hasNextSteps = (capability: string) => capability in NEXT;

export function nextStepsFor(job: Job): NextStep[] {
  const rule = NEXT[job.capability];
  return job.status === 'completed' && job.result !== undefined && rule ? rule(job) : [];
}

const isSettledBadly = (job: Job) => job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted';

/** A next step is taken once a job of that capability builds on this one and did not fail. */
export const isTaken = (job: Job, next: NextStep) => childrenOf(job.jobId).some((child) => child.capability === next.capability && !isSettledBadly(child));

/** A job needs a look when it failed, or completed with a failed outcome. */
export const hasFailed = (job: Job) => job.status === 'failed' || job.status === 'interrupted' || job.outcome?.status === 'failed';
