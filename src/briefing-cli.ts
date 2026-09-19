import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createBriefing, renderBriefing } from './briefing.ts';
import { providerName } from './providers.ts';
// Provider SDK diagnostics can contain request bodies or auth headers.
globalThis.AI_SDK_LOG_WARNINGS = false;
console.error = console.warn = () => process.stderr.write('Provider diagnostic suppressed; inspect the saved run status.\n');
const usage = 'Usage: npm run briefing -- OWNER/REPO --checkout PATH [--commit FULL_SHA] [--issues 1,2] [--count 1..5] [--provider copilot|codex] [--output NEW_DIRECTORY]\n       npm run briefing -- render DIRECTORY\n';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { process.stdout.write(usage); }
  else {
    let b; let directory: string;
    if (args[0] === 'render') {
      if (args.length !== 2) throw new Error('Invalid render arguments');
      directory = resolve(args[1]); b = await renderBriefing(directory);
    } else {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
        options: { checkout: { type: 'string' }, commit: { type: 'string' }, issues: { type: 'string' },
          count: { type: 'string' }, provider: { type: 'string' }, output: { type: 'string' } } });
      if (positionals.length !== 1 || !values.checkout || values.issues !== undefined && !/^\d+(,\d+)*$/.test(values.issues) ||
          values.count !== undefined && !/^[1-5]$/.test(values.count)) throw new Error('Invalid arguments');
      const provider = providerName(values.provider);
      if (!values.output) await mkdir('runs/briefings', { recursive: true, mode: 0o700 });
      directory = resolve(values.output ?? join('runs/briefings', randomUUID()));
      const controller = new AbortController();
      const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try {
        b = await createBriefing(positionals[0], { directory, checkout: resolve(values.checkout), commit: values.commit,
          count: values.count ? Number(values.count) : 5, issueNumbers: values.issues?.split(',').map(Number), provider, signal: controller.signal });
      } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    }
    process.stdout.write(JSON.stringify({ workflowId: b.workflowId, status: b.status, budget: b.budget, directory, failure: b.failure }) + '\n');
    if (b.status !== 'completed') process.exitCode = 1;
  }
} catch {
  process.stderr.write('Briefing command failed. Check arguments, source checkout, subscription configuration, and saved artifacts. Existing output directories are not reusable.\n' + usage);
  process.exitCode = 1;
}
