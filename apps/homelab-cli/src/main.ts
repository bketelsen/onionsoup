import { liveModel, providerName } from '@onionsoup/providers';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { investigateWorkloads } from '@onionsoup/workload-triage';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { z } from 'zod';
import { collectKubernetes } from '@onionsoup/kubernetes-source';
import { composeHomelabBrief, renderHomelabBrief, readHomelabObservation } from '@onionsoup/homelab-brief';
import { atomicJson, readJson } from '@onionsoup/runtime/storage';
import { collectContainerInventory } from '@onionsoup/container-source';
import { collectTrueNasHealth } from '@onionsoup/truenas-source';
globalThis.AI_SDK_LOG_WARNINGS = false;
console.error = console.warn = () => process.stderr.write('Provider diagnostic suppressed; inspect saved artifacts.\n');
const usage = 'Usage: npm run homelab -- truenas|containers|kubernetes|investigate|brief CONFIG_JSON [--output NEW_DIRECTORY] [--provider copilot|codex (investigate)]\nTrueNAS: TRUENAS_API_KEY in the environment. Containers: existing SSH keys/agent and trusted host keys. Kubernetes: host-local k3s kubeconfig, direct access by default.\nBrief: saved observation paths; no collection.\n';
try {
  if (process.argv.includes('--help')) process.stdout.write(usage);
  else {
    const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { output: { type: 'string' }, provider: { type: 'string' } } });
    if (positionals.length !== 2 || !['truenas', 'containers', 'kubernetes', 'investigate', 'brief'].includes(positionals[0])) throw new Error('Invalid arguments');
    if (positionals[0] === 'investigate' && !values.provider || positionals[0] !== 'investigate' && values.provider) throw new Error('Explicit provider required only for investigate');
    const config = await readJson(resolve(positionals[1]));
    if (!values.output) await mkdir('runs/homelab', { recursive: true, mode: 0o700 });
    const directory = resolve(values.output ?? join('runs/homelab', randomUUID()));
    const controller = new AbortController(), abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      if (positionals[0] === 'brief') {
        const briefConfig = z.object({ schemaVersion: z.literal(1), observations: z.array(z.string().min(1)).min(1).max(32),
          maxAgeSeconds: z.number().int().min(1).max(86400).default(900) }).strict().parse(config);
        const inputs: unknown[] = [];
        for (const path of briefConfig.observations) {
          const file = resolve(dirname(resolve(positionals[1])), path);
          inputs.push(await readHomelabObservation(file, controller.signal));
        }
        controller.signal.throwIfAborted();
        const brief = composeHomelabBrief(inputs, { maxAgeSeconds: briefConfig.maxAgeSeconds });
        await mkdir(directory, { mode: 0o700 });
        await atomicJson(join(directory, 'brief.json'), brief);
        await writeFile(join(directory, 'brief.md'), renderHomelabBrief(brief), { flag: 'wx', mode: 0o600 });
        process.stdout.write(JSON.stringify({ runId: brief.runId, directory, sources: brief.sources.length }, null, 2) + '\n');
      } else if (positionals[0] === 'investigate') {
        const provider = providerName(values.provider);
        const result = await investigateWorkloads(config, { directory, signal: controller.signal, provider, modelId: EVALUATION_MODEL,
          modelFactory: async () => (await liveModel(EVALUATION_MODEL, provider)).model });
        process.stdout.write(JSON.stringify({runId:result.runId,status:result.status,directory,result:result.result,failure:result.failure},null,2)+'\n');
        if(result.status !== 'completed') process.exitCode=1;
      } else {
        const result = positionals[0] === 'truenas'
          ? await collectTrueNasHealth(config, { apiKey: process.env.TRUENAS_API_KEY ?? '', directory, signal: controller.signal })
          : positionals[0] === 'kubernetes' ? await collectKubernetes(config, { directory, signal: controller.signal })
          : await collectContainerInventory(config, { directory, signal: controller.signal });
        process.stdout.write(JSON.stringify({ runId: result.runId, status: result.status, directory,
          ...('failure' in result && result.failure ? { failure: result.failure } : {}), ...('evidence' in result && result.evidence ? { evidence: result.evidence } : {}),
          ...('queries' in result ? { queries: result.queries } : {}) }, null, 2) + '\n');
        if (result.status !== 'completed') process.exitCode = 1;
      }
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
} catch { process.stderr.write('Homelab observation stopped. Check host config, credential availability and saved artifacts.\n' + usage); process.exitCode = 1; }
