import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { liveModel, providerName } from '../src/providers.ts';
import { triage } from '../src/triage.ts';
import { EVALUATION_MODEL } from '../src/evaluation-policy.ts';

const cases = JSON.parse(await readFile(new URL('../evals/cases.json', import.meta.url), 'utf8')) as Array<{
  id: string; title: string; body: string; expected: { kind: string; bug_readiness: string }; missing: string[];
}>;
const provider = await liveModel(EVALUATION_MODEL, providerName());
const directory = process.env.ONIONSOUP_RUNS_DIR ?? 'runs';
await mkdir(directory, { recursive: true, mode: 0o700 });
let passed = 0;
let falseReady = 0;
for (const item of cases) {
  const run = await triage({
    schemaVersion: 1, repository: 'example/widget', number: 42,
    updatedAt: '2026-09-18T12:00:00Z', title: item.title, body: item.body,
  }, provider);
  await writeFile(join(directory, `eval-${item.id}-${run.runId}.json`), JSON.stringify(run, null, 2), { mode: 0o600 });
  const actualMissing = run.assessment?.questions.map(q => q.field).sort() ?? [];
  const actual = run.assessment && { kind: run.assessment.kind, bug_readiness: run.assessment.bug_readiness };
  const pass = run.status === 'completed' && actual?.kind === item.expected.kind &&
    actual?.bug_readiness === item.expected.bug_readiness &&
    JSON.stringify(actualMissing) === JSON.stringify([...item.missing].sort());
  if (pass) passed++;
  if (actual?.bug_readiness === 'ready' && item.expected.bug_readiness !== 'ready') falseReady++;
  console.log(JSON.stringify({ case: item.id, pass, expected: item.expected,
    actual: actual ?? run.failure, actualMissing, runId: run.runId }));
}
console.log(JSON.stringify({ passed, total: cases.length, falseReady, provider: provider.provider, model: provider.modelId }));
if (passed !== cases.length || falseReady) process.exitCode = 1;
