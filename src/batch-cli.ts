import { parseArgs } from 'node:util';
import { collectBatch } from './batch-collect.ts';
import { runBatch } from './batch-run.ts';
import { renderBatchReport } from './batch-report.ts';
import { importFeedback, recordCostDecision } from './batch-review.ts';
import { readJson } from './batch-store.ts';
import { providerName } from './providers.ts';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    count: { type: 'string', default: '40' }, before: { type: 'string' }, seed: { type: 'string', default: 'onionsoup-heldout-1' },
    provider: { type: 'string', default: 'copilot' },
    acceptable: { type: 'string' }, reviewer: { type: 'string' }, note: { type: 'string' },
  } });
  const [command, first, second] = positionals;
  if (command === 'collect' && first && second) {
    const result = await collectBatch(first, second, { count: Number(values.count),
      before: values.before ? Number(values.before) : undefined, seed: values.seed,
      provider: providerName(values.provider) });
    await renderBatchReport(second);
    console.log(`Frozen ${result.cases.length} snapshots in ${second}; models: ${result.models.join(', ')}`);
  } else if (command === 'run' && first) {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const result = await runBatch(first, { signal: controller.signal, onProgress: console.log });
    await renderBatchReport(first);
    if (result.failed) process.exitCode = 1;
  } else if (command === 'report' && first) {
    await renderBatchReport(first);
  } else if (command === 'import-feedback' && first && second) {
    console.log(`Imported ${await importFeedback(first, await readJson(second))} reviews`);
    await renderBatchReport(first);
  } else if (command === 'cost' && first && second && ['yes', 'no'].includes(values.acceptable ?? '')) {
    await recordCostDecision(first, second, { acceptable: values.acceptable === 'yes', reviewer: values.reviewer,
      note: values.note, recordedAt: new Date().toISOString() });
    await renderBatchReport(first);
  } else {
    throw new Error('Usage: batch collect <owner/repo> <new-directory> [--count 40 --before N] (Terra only)\n' +
      'batch run <directory> | report <directory> | import-feedback <directory> <feedback.json>\n' +
      'batch cost <directory> <model> --acceptable yes|no --reviewer NAME --note EXPLANATION');
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Batch failed'); process.exitCode = 1; });
