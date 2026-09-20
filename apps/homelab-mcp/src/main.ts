import { mkdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHomelabMcpServer, HomelabMcpConfig } from '@onionsoup/homelab-mcp';
import { readJson } from '@onionsoup/runtime/storage';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { liveModel } from '@onionsoup/providers';
globalThis.AI_SDK_LOG_WARNINGS = false;
console.error = console.warn = () => process.stderr.write('Provider diagnostic suppressed; inspect saved job status.\n');
let release: (() => Promise<void>) | undefined;
try {
  if (process.argv.includes('--help')) {
    process.stdout.write('Homelab MCP (stdio): set ONIONSOUP_HOMELAB_CONFIG to an operator-owned JSON config.\n');
  } else {
    if (process.argv.length !== 2 || !process.env.ONIONSOUP_HOMELAB_CONFIG) throw new Error('Missing config');
    const path=resolve(process.env.ONIONSOUP_HOMELAB_CONFIG), config=HomelabMcpConfig.parse(await readJson(path));
    config.runsDirectory=resolve(dirname(path),config.runsDirectory);
    config.observations=config.observations.map(p=>resolve(dirname(path),p));
    const root=config.runsDirectory;
    const host=createHomelabMcpServer(config,{modelFactory:async()=>(await liveModel(EVALUATION_MODEL,config.provider)).model});
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
    // SDK stdio transport does not translate stdin EOF into onclose.
    process.stdin.once('end', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  }
} catch {
  await release?.();
  process.stderr.write('Homelab MCP host stopped. Check host configuration and exclusive run-directory lock.\n');
  process.exitCode = 1;
}
