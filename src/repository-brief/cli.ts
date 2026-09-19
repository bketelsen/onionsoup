import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRepositoryBrief, renderRepositoryBrief } from './recipe.ts';
import { BriefRequest } from './contracts.ts';
import { providerName } from '../providers.ts';
globalThis.AI_SDK_LOG_WARNINGS = false;
console.error = console.warn = () => process.stderr.write('Provider diagnostic suppressed; inspect saved status.\n');
const usage = 'Usage: npm run repo-brief -- OWNER/REPO [--days 1..90 | --since ISO --until ISO] [--max-suggestions 0..10] [--provider copilot|codex] [--output NEW_DIRECTORY]\n       npm run repo-brief -- render DIRECTORY\n';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) process.stdout.write(usage);
  else {
    let b; let directory;
    if (args[0] === 'render') {
      if (args.length !== 2) throw new Error('Invalid arguments');
      directory = resolve(args[1]); b = await renderRepositoryBrief(directory);
    } else {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
        days: { type:'string' }, since: { type:'string' }, until: { type:'string' }, 'max-suggestions': { type:'string' },
        provider: { type:'string' }, output: { type:'string' } } });
      if (positionals.length !== 1 || values.days && values.since || values.days && !/^([1-9]|[1-8][0-9]|90)$/.test(values.days) ||
          values['max-suggestions'] && !/^([0-9]|10)$/.test(values['max-suggestions'])) throw new Error('Invalid selection');
      const until = values.until ?? new Date().toISOString();
      const request = BriefRequest.parse({ schemaVersion: 1, repository: positionals[0], until,
        since: values.since ?? new Date(Date.parse(until)-Number(values.days ?? 7)*86400000).toISOString(), maxSuggestions: Number(values['max-suggestions'] ?? 5) });
      if (Date.parse(until) > Date.now()) throw new Error('Window ends in future');
      const provider = providerName(values.provider);
      if (!values.output) await mkdir('runs/repository-briefs',{ recursive:true, mode:0o700 });
      directory = resolve(values.output ?? join('runs/repository-briefs',randomUUID()));
      const controller = new AbortController(), abort = () => controller.abort();
      process.once('SIGINT',abort); process.once('SIGTERM',abort);
      try { b = await createRepositoryBrief(request,{ directory, provider, signal:controller.signal }); }
      finally { process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); }
    }
    process.stdout.write(JSON.stringify({ workflowId:b.workflowId, status:b.status, budget:b.budget, directory })+'\n');
    if (b.status !== 'completed') process.exitCode = 1;
  }
} catch { process.stderr.write('Repository brief command failed. Check arguments, GitHub/subscription access and saved artifacts. Existing output directories cannot be reused.\n'+usage); process.exitCode = 1; }
