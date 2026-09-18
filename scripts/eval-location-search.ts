// Tiny Terra-only development corpus, not a model comparison or accuracy harness.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { liveModel } from '../src/providers.ts';
import { EVALUATION_MODEL } from '../src/evaluation-policy.ts';
import { locateCode } from '../src/location-agent.ts';
import { makeLocationInput } from '../src/location-workflow.ts';
import { triage } from '../src/triage.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { atomicJson } from '../src/batch-store.ts';
import { fields } from '../src/contracts.ts';

type Expected = { codePath: string; codeText: string; testPath: string | null; testText: string | null; relevance: 'direct' | 'adjacent' | null };
const corpus = JSON.parse(await readFile(new URL('../evals/location-search.json', import.meta.url), 'utf8')) as {
  files: Record<string, string>; cases: Array<{ id: string; title: string; body: string; expected?: Expected }>;
  expected: Expected;
};
const root = resolve(process.env.ONIONSOUP_RUNS_DIR ?? 'runs/location-search');
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, 'development-'));
const checkout = join(directory, 'source'); await mkdir(checkout);
for (const [path, text] of Object.entries(corpus.files)) {
  await mkdir(dirname(join(checkout, path)), { recursive: true });
  await writeFile(join(checkout, path), text);
}
const git = (...args: string[]) => promisify(execFile)('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgSign=false', '-c', 'user.name=Onionsoup fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
await git('init', '-q'); await git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
await git('add', '.'); await git('commit', '-qm', 'Synthetic code-location development fixture');
const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
await atomicJson(join(directory, 'corpus.json'), corpus);
const adapter = await liveModel(EVALUATION_MODEL);
const results = [];
for (const [i, item] of corpus.cases.entries()) {
  const issue = { schemaVersion: 1, repository: 'example/widget', number: i + 1,
    updatedAt: '2026-09-18T12:00:00Z', title: item.title, body: item.body };
  // Scripted readiness only admits the synthetic input; it is not a quality result.
  const parent = await triage(issue, { model: fixtureModel([{ schemaVersion: 2, kind: 'bug_report', bug_readiness: 'ready',
    summary: item.title,
    evidence: fields.map(field => ({ field, source: 'body', quote: item.body })), questions: [] }]),
    provider: 'fixture', modelId: 'scripted' });
  await atomicJson(join(directory, `${item.id}-parent.json`), parent);
  const input = makeLocationInput(parent, { number: issue.number, title: issue.title, state: 'open',
    updatedAt: issue.updatedAt, observedAt: issue.updatedAt, commentsExcluded: 0, snapshot: parent.input }, commit);
  const run = await locateCode(input, { ...adapter, checkout,
    checkpoint: record => atomicJson(join(directory, `${item.id}-${record.runId}.json`), record) });
  // Expectations stay outside model context; check concrete locations/assertions, not just valid JSON.
  const expected = item.expected ?? corpus.expected;
  const pass = run.status === 'completed' && run.brief?.status === 'located' &&
    run.brief.codePointers.some(c => c.path === expected.codePath && c.quote.includes(expected.codeText)) &&
    (expected.testPath === null ? run.brief.testPointers.length === 0 :
      run.brief.schemaVersion === 3 && run.brief.testPointers.some(c => c.path === expected.testPath && c.quote.includes(expected.testText!) && c.relevance === expected.relevance));
  results.push({ case: item.id, pass, runId: run.runId, status: run.status, testSearch: run.brief?.schemaVersion === 3 ? run.brief.testSearch.status : null,
    relevance: run.brief?.schemaVersion === 3 ? run.brief.testPointers.map(c => c.relevance) : null });
  console.log(JSON.stringify(results.at(-1)));
}
await atomicJson(join(directory, 'summary.json'), { provider: adapter.provider, model: adapter.modelId, commit, results });
console.log(`Saved fixture, parents, runs, and checks: ${directory}`);
if (results.some(r => !r.pass)) process.exitCode = 1;
