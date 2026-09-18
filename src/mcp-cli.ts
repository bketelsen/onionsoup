import { open } from 'node:fs/promises';
import { ReadinessWorkflowInput } from './readiness-workflow.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentMcpServer } from './mcp-adapter.ts';
import { liveModel, providerName } from './providers.ts';

async function main() {
  // Raw SDK warnings can include model response details. stdout is protocol only.
  globalThis.AI_SDK_LOG_WARNINGS = false;
  // AgentLayer's AI SDK error callback can print raw transport errors. This
  // dedicated process emits only fixed diagnostics; never patch a caller's logger.
  const diagnostic = () => { process.stderr.write('Onionsoup runtime diagnostic omitted; inspect run status.\n'); };
  console.error = diagnostic; console.warn = diagnostic;
  console.log = diagnostic; console.info = diagnostic; console.debug = diagnostic;
  const provider = process.env.ONIONSOUP_PROVIDER;
  const modelId = process.env.ONIONSOUP_MODEL;
  const runsDirectory = process.env.ONIONSOUP_RUNS_DIR;
  if (!provider || !modelId || !runsDirectory || process.argv.length !== 2)
    throw new Error('Missing launch configuration');
  const selectedProvider = providerName(provider);
  const maxInvocations = Number(process.env.ONIONSOUP_MCP_MAX_INVOCATIONS ?? '1');
  let preparedInput;
  if (process.env.ONIONSOUP_WORKFLOW_INPUT) {
    const file = await open(process.env.ONIONSOUP_WORKFLOW_INPUT, 'r');
    try {
      if (!(await file.stat()).isFile()) throw new Error('Not a regular input file');
      const bytes = Buffer.alloc(524289);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const next = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!next.bytesRead) break;
        bytesRead += next.bytesRead;
      }
      if (bytesRead > 524288) throw new Error('Prepared input is too large');
      preparedInput = ReadinessWorkflowInput.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    } finally { await file.close(); }
  }
  const server = createAgentMcpServer({ runsDirectory, maxInvocations, preparedInput,
    model: () => liveModel(modelId, selectedProvider) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void server.close(); });
  }
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  process.stderr.write('Onionsoup MCP startup failed. Set ONIONSOUP_PROVIDER, ONIONSOUP_MODEL, ONIONSOUP_RUNS_DIR, and an optional ONIONSOUP_MCP_MAX_INVOCATIONS (1–10).\n');
  process.exitCode = 1;
});
