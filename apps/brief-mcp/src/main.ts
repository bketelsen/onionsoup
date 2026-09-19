import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBriefMcpServer } from '@onionsoup/brief-mcp';
import { providerName } from '@onionsoup/providers';
globalThis.AI_SDK_LOG_WARNINGS = false;
console.error = console.warn = () => process.stderr.write('Provider diagnostic suppressed; inspect saved job status.\n');
let release: (() => Promise<void>) | undefined;
try {
  if (process.argv.includes('--help')) {
    process.stdout.write('Repository brief MCP (stdio): set ONIONSOUP_PROVIDER, ONIONSOUP_RUNS_DIR, ONIONSOUP_REPOSITORIES (comma separated); optional ONIONSOUP_MAX_JOBS (1..10, default 1).\n');
  } else {
    if (process.argv.length !== 2 || !process.env.ONIONSOUP_RUNS_DIR || !process.env.ONIONSOUP_PROVIDER || !process.env.ONIONSOUP_REPOSITORIES)
      throw new Error('Missing host configuration');
    const root = resolve(process.env.ONIONSOUP_RUNS_DIR);
    const host = createBriefMcpServer({ runsDirectory: root, provider: providerName(process.env.ONIONSOUP_PROVIDER),
      repositories: process.env.ONIONSOUP_REPOSITORIES.split(',').map(s => s.trim()),
      maxJobs: process.env.ONIONSOUP_MAX_JOBS === undefined ? 1 : Number(process.env.ONIONSOUP_MAX_JOBS) });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = join(root, '.host-lock');
    await mkdir(lock, { mode: 0o700 });
    release = () => rm(lock, { recursive: true });
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      await host.shutdown(); await release?.();
    };
    const transport = new StdioServerTransport();
    await host.server.connect(transport);
    host.server.server.onclose = () => { void close(); };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  }
} catch {
  await release?.();
  process.stderr.write('Brief MCP host stopped. Check host configuration and exclusive run-directory lock.\n');
  process.exitCode = 1;
}
