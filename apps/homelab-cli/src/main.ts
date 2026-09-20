import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readJson } from '@onionsoup/runtime/storage';
import { collectTrueNasHealth } from '@onionsoup/truenas-source';
const usage = 'Usage: npm run homelab -- truenas CONFIG_JSON [--output NEW_DIRECTORY]\nCredentials: TRUENAS_API_KEY in the environment; never in the config or arguments.\n';
try {
  if (process.argv.includes('--help')) process.stdout.write(usage);
  else {
    const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { output: { type: 'string' } } });
    if (positionals.length !== 2 || positionals[0] !== 'truenas') throw new Error('Invalid arguments');
    const config = await readJson(resolve(positionals[1]));
    if (!values.output) await mkdir('runs/homelab', { recursive: true, mode: 0o700 });
    const directory = resolve(values.output ?? join('runs/homelab', randomUUID()));
    const controller = new AbortController(), abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await collectTrueNasHealth(config, { apiKey: process.env.TRUENAS_API_KEY ?? '', directory, signal: controller.signal });
      process.stdout.write(JSON.stringify({ runId: result.runId, status: result.status, directory,
        ...(result.failure ? { failure: result.failure } : {}), ...(result.evidence ? { evidence: result.evidence } : {}) }, null, 2) + '\n');
      if (result.status !== 'completed') process.exitCode = 1;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
} catch { process.stderr.write('TrueNAS observation stopped. Check host config, credential availability and saved artifacts.\n' + usage); process.exitCode = 1; }
