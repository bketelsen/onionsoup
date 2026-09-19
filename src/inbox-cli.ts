import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { refreshInbox } from './inbox.ts';
import { renderInbox } from './inbox-report.ts';
import { Repository, recoverInbox } from './inbox-store.ts';
import { providerName } from './providers.ts';

async function main() {
  if(process.argv[2]==='serve') { await (await import('./console/cli.ts')).serve(process.argv.slice(3)); return; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    directory: { type: 'string' }, provider: { type: 'string', default: 'copilot' },
    'max-issues': { type: 'string', default: '5' }, 'max-seconds': { type: 'string', default: '300' },
    pages: { type: 'string', default: '1' },
  } });
  const [command, repository, issue] = positionals;
  if (!['refresh', 'report', 'retry', 'recover'].includes(command) || !repository ||
      (command === 'retry' ? !issue || positionals.length !== 3 : positionals.length !== 2))
    throw new Error('Usage: inbox refresh OWNER/REPO [--max-issues 5 --pages 1 --max-seconds 300]\n' +
      'inbox report OWNER/REPO | retry OWNER/REPO ISSUE | recover OWNER/REPO\n' +
      'All commands accept --directory PATH. Refresh/retry use Terra only; no GitHub writes.');
  Repository.parse(repository);
  const directory = resolve(values.directory ?? `runs/inbox/${repository.toLowerCase().replace('/', '--')}`);
  if (command === 'report') {
    await renderInbox(directory);
  } else if (command === 'recover') {
    const count = await recoverInbox(directory);
    await renderInbox(directory);
    console.log(`Marked ${count} interrupted attempt(s) failed; no model calls or retries made.`);
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const result = await refreshInbox(directory, repository, { provider: providerName(values.provider),
        maxIssues: Number(values['max-issues']), maxSeconds: Number(values['max-seconds']), pages: Number(values.pages),
        retryIssue: command === 'retry' ? Number(issue) : undefined, signal: controller.signal, onProgress: console.log });
      await renderInbox(directory);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'completed' || result.failed) process.exitCode = 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
  console.log(`Inbox: ${directory}/index.html`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Inbox failed'); process.exitCode = 1; });
