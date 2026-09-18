import { join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { FeedbackFile, CostDecision, type BatchManifest, type Feedback } from './batch-contracts.ts';
import { readManifest, readRecord, readReviews, readCosts, atomicJson, type ReviewLedger } from './batch-store.ts';
import { readiness as assessmentReadiness, requestKind, type StoredRunRecord } from './assessment-view.ts';

export async function assertFeedback(directory: string, manifest: BatchManifest, review: Feedback) {
  if (review.batchId !== manifest.batchId || !manifest.models.includes(review.model) ||
      !manifest.cases.some(c => c.input.number === review.issue)) throw new Error('Feedback belongs to a different batch or issue');
  const run = await readRecord(directory, manifest, review.model, review.issue);
  if (!run || run.runId !== review.runId || run.status === 'running') throw new Error('Feedback does not match a finished run');
  if (run.status !== 'completed' && review.verdict !== 'reject') throw new Error('A failed run can only be rejected');
  if (review.falseReady && assessmentReadiness(run.assessment) !== 'ready') throw new Error('False-ready flag requires a ready assessment');
}

export async function withFeedbackLock<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const file = join(directory, '.feedback.lock');
  const lock = await open(file, 'wx', 0o600);
  try { return await task(); } finally { await lock.close(); await unlink(file); }
}

export async function importFeedback(directory: string, raw: unknown) {
  const incoming = FeedbackFile.parse(raw);
  const keys = incoming.reviews.map(r => `${r.model}:${r.issue}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate case in feedback import');
  const manifest = await readManifest(directory);
  // Validate the entire import before touching the ledger.
  for (const review of incoming.reviews) await assertFeedback(directory, manifest, review);
  return withFeedbackLock(directory, async () => {
    const ledger = await readReviews(directory);
    for (const review of incoming.reviews) {
      const previous = ledger.reviews.filter(r => r.model === review.model && r.issue === review.issue).at(-1);
      if (previous) {
        const { recordedAt: _, ...content } = previous;
        if (JSON.stringify(content) === JSON.stringify(review)) continue;
      }
      ledger.reviews.push({ ...review, recordedAt: new Date().toISOString() });
    }
    await atomicJson(join(directory, 'feedback.json'), ledger);
    return incoming.reviews.length;
  });
}

export async function recordCostDecision(directory: string, model: string, raw: unknown) {
  const manifest = await readManifest(directory);
  if (!manifest.models.includes(model)) throw new Error('Model is not in this batch');
  const decision = CostDecision.parse(raw);
  return withFeedbackLock(directory, async () => {
    const costs = await readCosts(directory);
    costs[model] = decision;
    await atomicJson(join(directory, 'cost-decisions.json'), costs);
  });
}

export type ReviewedCase = { model: string; issue: number; run?: StoredRunRecord; review?: Feedback };
export async function loadReviewedCases(directory: string) {
  const manifest = await readManifest(directory);
  const ledger = await readReviews(directory);
  for (const review of ledger.reviews) await assertFeedback(directory, manifest, review);
  const cases: ReviewedCase[] = [];
  for (const item of manifest.cases) for (const model of manifest.models) {
    const run = await readRecord(directory, manifest, model, item.input.number);
    const review = ledger.reviews.filter(r => r.model === model && r.issue === item.input.number).at(-1);
    cases.push({ model, issue: item.input.number, run, review });
  }
  return { manifest, cases, ledger, costs: await readCosts(directory) };
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarizeModel(manifest: BatchManifest, model: string, cases: ReviewedCase[], cost?: CostDecision) {
  const rows = cases.filter(c => c.model === model);
  const finished = rows.filter(c => c.run && c.run.status !== 'running');
  const completed = finished.filter(c => c.run?.status === 'completed');
  const reviewed = rows.filter(c => c.review);
  const accepted = reviewed.filter(c => c.review?.verdict === 'accept').length;
  const falseReady = reviewed.filter(c => c.review?.falseReady).length;
  const count = manifest.cases.length;
  const acceptanceRate = reviewed.length === count ? accepted / count : null;
  const qualityGate = count < manifest.criteria.minimumCases ? 'insufficient_sample' :
    reviewed.length !== count ? 'pending_review' :
    completed.length === count && acceptanceRate! >= manifest.criteria.acceptanceRate && falseReady === 0 ? 'met' : 'not_met';
  const readiness = qualityGate !== 'met' ? qualityGate : cost === undefined ? 'pending_cost_review' : cost.acceptable ? 'supervised_pilot_eligible' : 'cost_not_accepted';
  const sumUsage = (key: 'inputTokens' | 'outputTokens') => finished.every(c => c.run?.tokenUsage?.totals[key] !== undefined)
    && finished.length ? finished.reduce((sum, c) => sum + c.run!.tokenUsage!.totals[key], 0) : null;
  return {
    model, assigned: count, finished: finished.length, completed: completed.length,
    failed: finished.length - completed.length, pending: count - finished.length,
    kinds: Object.fromEntries(['bug_report', 'feature_request', 'support_question', 'other', 'unclear', 'unclassified_legacy']
      .map(kind => [kind, completed.filter(c => requestKind(c.run?.assessment) === kind).length])),
    bugReadiness: Object.fromEntries(['ready', 'needs_information', 'not_applicable', 'out_of_scope']
      .map(value => [value, completed.filter(c => assessmentReadiness(c.run?.assessment) === value).length])),
    reviewed: reviewed.length, accepted, revised: reviewed.filter(c => c.review?.verdict === 'revise').length,
    rejected: reviewed.filter(c => c.review?.verdict === 'reject').length,
    acceptanceRate, falseReady: reviewed.length ? falseReady : null,
    qualityGate, costDecision: cost ?? null, readiness,
    medianSeconds: median(finished.flatMap(c => c.run?.finishedAt ?
      [(Date.parse(c.run.finishedAt) - Date.parse(c.run.startedAt)) / 1000] : [])),
    steps: finished.reduce((sum, c) => sum + c.run!.events.filter(e => e.type === 'stepStart').length, 0),
    inputTokensReported: sumUsage('inputTokens'), outputTokensReported: sumUsage('outputTokens'),
    quotaConsumed: null, billedCost: null,
  };
}
