import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { WorkflowEventExport } from '../src/workflow-events.ts';
import { AgentId, capabilityManifest, capabilityCatalog } from '../src/capabilities.ts';
const check = process.argv.includes('--check');
const artifacts = [['capabilities/catalog.json', capabilityCatalog()],
  ['capabilities/workflow-events.schema.json', z.toJSONSchema(WorkflowEventExport, { target: 'draft-2020-12' })],
  ...AgentId.options.map(id => [`capabilities/${id}.json`, capabilityManifest(id)] as const)] as const;
if (!check) await mkdir('capabilities', { recursive: true });
for (const [file, value] of artifacts) {
  const expected = JSON.stringify(value, null, 2) + '\n';
  if (check) {
    let actual: string | undefined;
    try { actual = await readFile(file, 'utf8'); } catch { /* report drift below */ }
    if (actual !== expected) throw new Error(`${file} is missing or stale; run npm run capabilities:generate`);
  } else await writeFile(file, expected);
}
console.log(check ? 'Capability manifests match implementation.' : 'Generated capability catalog and manifests.');
