import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { locateInboxIssues } from './location-workflow.ts';
import { renderInbox } from './inbox-report.ts';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { checkout: { type: 'string' },
    commit: { type: 'string' }, issues: { type: 'string' }, retry: { type: 'boolean', default: false } } });
  if (positionals.length !== 1 || !values.checkout || !values.commit || !values.issues)
    throw new Error('Usage: npm run locate -- INBOX_DIRECTORY --checkout PATH --commit FULL_SHA --issues 123,456,789 [--retry]');
  const directory = resolve(positionals[0]);
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const outcomes = await locateInboxIssues(directory, values.checkout, values.commit, values.issues.split(',').map(Number),
      { retry: values.retry, signal: controller.signal, onProgress: console.log });
    await renderInbox(directory);
    console.log(JSON.stringify(outcomes, null, 2));
    console.log(`Inbox: ${directory}/index.html`);
    if (controller.signal.aborted || outcomes.some(o => !['completed', 'skipped_completed'].includes(o.status))) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Code-location failed'); process.exitCode = 1; });
