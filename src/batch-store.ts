import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatchManifest, Feedback, CostDecision } from './batch-contracts.ts';
import { inputHash } from './triage.ts';
import type { StoredRunRecord } from './assessment-view.ts';
import { validateLegacyAssessment } from './legacy-contracts.ts';
import { validateAssessment } from './contracts.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeFiles = ['packages/maintenance/src/prompt.ts', 'packages/maintenance/src/contracts.ts', 'packages/maintenance/src/triage.ts', 'packages/providers/src/index.ts', 'packages/providers/src/evaluation-policy.ts',
  'src/batch-run.ts', 'package-lock.json'];
export async function freezeRuntime() {
  const entries = await Promise.all(runtimeFiles.map(async file => [file,
    createHash('sha256').update(await readFile(join(projectRoot, file))).digest('hex')]));
  return { promptVersion: PROMPT_VERSION, promptText: SYSTEM_PROMPT, files: Object.fromEntries(entries) as Record<string, string> };
}
export async function assertFrozen(manifest: BatchManifest) {
  if (JSON.stringify(await freezeRuntime()) !== JSON.stringify(manifest.frozen))
    throw new Error('Frozen runtime changed. Start a separate development batch; do not retune this held-out batch.');
}
export { readJson, optionalJson, atomicJson } from '@onionsoup/runtime/storage';
import { readJson, optionalJson } from '@onionsoup/runtime/storage';
export async function readManifest(directory: string): Promise<BatchManifest> {
  const manifest = BatchManifest.parse(await readJson(join(directory, 'manifest.json')));
  if (new Set(manifest.models).size !== manifest.models.length ||
      new Set(manifest.cases.map(c => c.input.number)).size !== manifest.cases.length ||
      manifest.cases.length !== manifest.selection.requestedCount)
    throw new Error('Duplicate models/issues or inconsistent batch size');
  for (const item of manifest.cases) {
    if (item.input.repository !== manifest.repository || inputHash(item.input) !== item.inputHash ||
      item.url !== `https://github.com/${manifest.repository}/issues/${item.input.number}`)
      throw new Error('Snapshot identity/hash does not match manifest');
  }
  return manifest;
}
export function recordPath(directory: string, model: string, issue: number) {
  return join(directory, 'records', model, `${issue}.json`);
}
export async function readRecord(directory: string, manifest: BatchManifest, model: string, issue: number): Promise<StoredRunRecord | undefined> {
  const raw = await optionalJson(recordPath(directory, model, issue));
  if (raw === undefined) return undefined;
  const record = raw as StoredRunRecord;
  const item = manifest.cases.find(c => c.input.number === issue);
  if (!item || !manifest.models.includes(model) || !record.input ||
      ![1, 2].includes(record.schemaVersion) ||
      record.model !== model || record.provider !== manifest.provider ||
      record.inputHash !== item.inputHash || inputHash(record.input) !== item.inputHash ||
      record.promptVersion !== manifest.frozen.promptVersion || !record.runId ||
      !['running', 'completed', 'failed'].includes(record.status))
    throw new Error('Run does not belong to the frozen batch');
  if (record.status === 'completed') {
    if (record.schemaVersion === 1) validateLegacyAssessment(record.assessment, record.input);
    else validateAssessment(record.assessment, record.input);
  }
  else if (record.assessment) throw new Error('Non-completed run contains an assessment');
  return record;
}
export type ReviewLedger = { schemaVersion: 1; reviews: Array<Feedback & { recordedAt: string }> };
export async function readReviews(directory: string): Promise<ReviewLedger> {
  const raw = await optionalJson(join(directory, 'feedback.json')) as ReviewLedger | undefined;
  if (raw === undefined) return { schemaVersion: 1, reviews: [] };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.reviews)) throw new Error('Invalid feedback ledger');
  return { schemaVersion: 1, reviews: raw.reviews.map(row => {
    const { recordedAt, ...review } = row;
    if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('Feedback timestamp is invalid');
    return { ...Feedback.parse(review), recordedAt };
  }) };
}
export async function readCosts(directory: string): Promise<Record<string, CostDecision>> {
  const raw = await optionalJson(join(directory, 'cost-decisions.json')) ?? {};
  return Object.fromEntries(Object.entries(raw).map(([model, decision]) => [model, CostDecision.parse(decision)]));
}
