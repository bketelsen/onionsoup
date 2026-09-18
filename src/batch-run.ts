import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { triage } from './triage.ts';
import { liveModel } from './providers.ts';
import { assessmentLabel } from './assessment-view.ts';
import { assertEvaluationModels } from './evaluation-policy.ts';
import { assertFrozen, atomicJson, readManifest, readRecord, recordPath } from './batch-store.ts';

export async function runBatch(directory: string, options: {
  signal?: AbortSignal;
  modelFactory?: typeof liveModel;
  onProgress?: (message: string) => void;
} = {}) {
  const manifest = await readManifest(directory);
  if (!options.modelFactory) assertEvaluationModels(manifest.models);
  await assertFrozen(manifest);
  const lockPath = join(directory, '.run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let failed = 0;
  try {
    const adapters = new Map<string, Awaited<ReturnType<typeof liveModel>>>();
    for (const model of manifest.models) adapters.set(model, await (options.modelFactory ?? liveModel)(model, manifest.provider));
    // Alternate first model per issue. Serial calls avoid rate-limit concurrency.
    for (const [index, item] of manifest.cases.entries()) {
      const order = index % 2 ? [...manifest.models].reverse() : manifest.models;
      for (const model of order) {
        if (options.signal?.aborted) throw new Error('Batch cancelled; completed cases are preserved');
        const existing = await readRecord(directory, manifest, model, item.input.number);
        if (existing) {
          if (existing.status === 'running') throw new Error(`Interrupted record for ${model} #${item.input.number}; inspect it before creating a separate retry batch`);
          if (existing.status === 'failed') failed++;
          options.onProgress?.(`skip ${model} #${item.input.number}: ${existing.status}`);
          continue;
        }
        await assertFrozen(manifest);
        const record = await triage(item.input, { ...adapters.get(model)!, signal: options.signal,
          checkpoint: async record => { await atomicJson(recordPath(directory, model, item.input.number), record); } });
        if (record.status === 'failed') failed++;
        options.onProgress?.(`${index + 1}/${manifest.cases.length} ${model} #${item.input.number}: ${assessmentLabel(record.assessment) ?? record.failure}`);
      }
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
  return { failed };
}
