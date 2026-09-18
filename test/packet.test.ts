import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createPacket, packetMarkdown, validatePacket } from '../src/packet.ts';
import { triage } from '../src/triage.ts';
import { fixtureModel } from '../src/fixture-model.ts';
import { fields, type IssueSnapshot } from '../src/contracts.ts';

const issue: IssueSnapshot = { schemaVersion: 1, repository: 'example/widget', number: 7,
  updatedAt: '2026-09-18T12:00:00Z', title: 'Widget returns bad', body: 'Linux v1. Call build(). Expected good. Actual bad.' };
const ready = { schemaVersion: 2, kind: 'bug_report', bug_readiness: 'ready', summary: 'Widget returns bad.',
  evidence: fields.map(field => ({ field, source: 'body', quote: issue.body })), questions: [] };
const code = "export function build() { return 'bad'; }";
const tests = "test('build', () => expect(build()).toBe('good'));";
const draft = { status: 'located', summary: 'Read build and its assertion.',
  codePointers: [{ excerptId: 'E1', startLine: 1, endLine: 1, symbol: 'build', reason: 'Returns the reported value.' }],
  testPointers: [{ excerptId: 'E2', startLine: 1, endLine: 1, symbol: 'build', reason: 'Asserts the expected value.' }], uncertainties: ['Runtime behavior was not reproduced.'] };
const locationCalls = [
  { name: 'search_repository', input: { query: 'build', scope: 'tests', pathPrefix: '' } },
  { name: 'read_repository', input: { path: 'src/widget.ts', startLine: 1, endLine: 1 } },
  { name: 'read_repository', input: { path: 'src/widget.test.ts', startLine: 1, endLine: 1 } },
  { name: 'submit_brief', input: draft },
];
function scripted(calls: Array<{ name: string; input: unknown }>) {
  let i = 0;
  return new MockLanguageModelV3({ provider: 'fixture', modelId: 'scripted', doStream: async () => {
    const call = calls[i++]; if (!call) throw new Error('Fixture exhausted');
    return { stream: simulateReadableStream({ chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: `packet-${i}`, toolName: call.name, input: JSON.stringify(call.input) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ], initialDelayInMs: null, chunkDelayInMs: null }) };
  } });
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'onionsoup-packet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'source'); await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'src/widget.ts'), code); await writeFile(join(checkout, 'src/widget.test.ts'), tests);
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  await git('init', '-q'); await git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
  await git('add', '.'); await git('commit', '-qm', 'fixture');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  const parent = await triage(issue, { model: fixtureModel([ready]), provider: 'copilot', modelId: 'gpt-5.6-terra' });
  const model = scripted(locationCalls);
  const options = { directory: join(directory, 'packet'), checkout, commit, provider: 'copilot' as const,
    modelFactory: async (modelId = 'gpt-5.6-terra', provider: 'copilot' | 'codex' = 'copilot') => ({ modelId, provider, model }) };
  return { directory, parent, model, options };
}

test('standalone snapshot runs both agents and embeds exact handoff and Markdown/JSON evidence without inbox state', async t => {
  const f = await fixture(t);
  const model = scripted([{ name: 'submit_assessment', input: ready }, ...locationCalls]);
  const packet = await createPacket(issue, { ...f.options,
    modelFactory: async (modelId = 'gpt-5.6-terra', provider: 'copilot' | 'codex' = 'copilot') => ({ modelId, provider, model }) });
  assert.equal(packet.status, 'completed'); assert.equal(packet.reusedReadiness, false);
  assert.equal(model.doStreamCalls.length, 5);
  assert.equal(packet.location?.input.parent.runId, packet.readiness?.runId);
  const saved = validatePacket(JSON.parse(await readFile(join(f.options.directory, 'packet.json'), 'utf8')));
  assert.equal(saved.location?.brief?.testPointers[0].quote, tests);
  const markdown = await readFile(join(f.options.directory, 'packet.md'), 'utf8');
  assert.equal(markdown, packetMarkdown(saved));
  assert.ok(markdown.includes(`/blob/${f.options.commit}/src/widget.test.ts#L1-L1`));
  assert.ok(markdown.includes(tests));
  assert.deepEqual((await readdir(f.options.directory)).sort(), ['packet.json', 'packet.md']);
});

test('explicit readiness reuse skips its model call; existing output cannot be overwritten or implicitly retried', async t => {
  const f = await fixture(t);
  const p = await createPacket(issue, { ...f.options, readiness: f.parent });
  assert.equal(p.reusedReadiness, true); assert.equal(p.readiness?.runId, f.parent.runId);
  assert.equal(f.model.doStreamCalls.length, 4);
  const before = await readFile(join(f.options.directory, 'packet.json'), 'utf8');
  await assert.rejects(createPacket(issue, { ...f.options, readiness: f.parent }), /EEXIST/);
  assert.equal(f.model.doStreamCalls.length, 4);
  assert.equal(await readFile(join(f.options.directory, 'packet.json'), 'utf8'), before);
});

test('feature requests and incomplete bugs export their result without initializing a provider or source', async t => {
  const f = await fixture(t);
  const outcomes = [
    { ...ready, kind: 'feature_request', bug_readiness: 'not_applicable', evidence: [] },
    { ...ready, bug_readiness: 'needs_information', evidence: ready.evidence.slice(1), questions: [{ field: 'reproduction', question: 'Which command?' }] },
  ];
  for (const [i, assessment] of outcomes.entries()) {
    const parent = await triage(issue, { model: fixtureModel([assessment]), provider: 'copilot', modelId: 'gpt-5.6-terra' });
    const p = await createPacket(issue, { ...f.options, directory: join(f.directory, `packet${i}`), readiness: parent, checkout: '/absent',
      modelFactory: async () => { throw new Error('Provider must not initialize'); } });
    assert.equal(p.status, 'completed'); assert.equal(p.locationDisposition, 'not_eligible'); assert.equal(p.location, undefined);
    if (i === 1) assert.match(packetMarkdown(p), /Which command/);
  }
});

test('stale, historical, failed and mismatched reused readiness fail before admission', async t => {
  const f = await fixture(t);
  for (const parent of [{ ...f.parent, model: 'other' }, { ...f.parent, promptVersion: 'old' }, { ...f.parent, schemaVersion: 1 },
    { ...f.parent, inputHash: '0'.repeat(64) }, { ...f.parent, status: 'failed', assessment: undefined }])
    await assert.rejects(createPacket(issue, { ...f.options, readiness: parent }));
  await assert.rejects(createPacket({ ...issue, body: 'Edited report' }, { ...f.options, readiness: f.parent }));
  assert.equal(f.model.doStreamCalls.length, 0);
  assert.deepEqual(await readdir(f.directory), ['source']);
});

test('source failure and cancellation produce partial packets; invalid readiness produces failed packets', async t => {
  const f = await fixture(t);
  const partial = await createPacket(issue, { ...f.options, readiness: f.parent, checkout: '/absent' });
  assert.equal(partial.status, 'partial'); assert.equal(partial.locationDisposition, 'failed');
  assert.equal(partial.location, undefined); assert.equal(partial.readiness?.status, 'completed');
  assert.equal(f.model.doStreamCalls.length, 0);
  const controller = new AbortController();
  const cancelled = await createPacket(issue, { ...f.options, directory: join(f.directory, 'cancelled'), readiness: f.parent, signal: controller.signal,
    modelFactory: async (...args) => { controller.abort(); return f.options.modelFactory(...args); } });
  assert.equal(cancelled.status, 'partial'); assert.equal(cancelled.failure, 'interrupted_or_timed_out');
  const bad = fixtureModel([{}, {}, {}]);
  const failed = await createPacket(issue, { ...f.options, directory: join(f.directory, 'failed'),
    modelFactory: async (modelId = 'gpt-5.6-terra', provider: 'copilot' | 'codex' = 'copilot') => ({ modelId, provider, model: bad }) });
  assert.equal(failed.status, 'failed'); assert.equal(failed.location, undefined);
});

test('rendering rejects tampered handoffs and evidence and keeps untrusted Markdown inert', async t => {
  const f = await fixture(t); const p = await createPacket(issue, { ...f.options, readiness: f.parent });
  const corrupt = structuredClone(p); corrupt.location!.input.parent.runId = '00000000-0000-4000-8000-000000000000';
  assert.throws(() => packetMarkdown(corrupt), /handoff/);
  const invented = structuredClone(p); invented.location!.brief!.codePointers[0].quote = 'invented';
  assert.throws(() => packetMarkdown(invented), /not grounded/);
  const prose = structuredClone(p); prose.location!.brief!.summary = '<script>alert(1)</script> [click](javascript:bad)';
  const md = packetMarkdown(prose);
  assert.ok(!md.includes('<script>')); assert.ok(!md.includes('[click](javascript:bad)')); assert.match(md, /&lt;script&gt;/);
});

test('a valid not_located brief is an explicit partial packet, with no invented locations', async t => {
  const f = await fixture(t);
  const model = scripted([locationCalls[0], { name: 'submit_brief', input: { status: 'not_located',
    summary: 'No implementation established.', codePointers: [], testPointers: [], uncertainties: ['Search was inconclusive.'] } }]);
  const p = await createPacket(issue, { ...f.options, readiness: f.parent,
    modelFactory: async (modelId = 'gpt-5.6-terra', provider: 'copilot' | 'codex' = 'copilot') => ({ modelId, provider, model }) });
  assert.equal(p.status, 'partial'); assert.equal(p.locationDisposition, 'not_located');
  assert.equal(p.location?.status, 'completed'); assert.equal(p.location?.brief?.codePointers.length, 0);
  assert.match(packetMarkdown(p), /Search was inconclusive/);
  const bad = structuredClone(p); bad.status = 'completed';
  assert.throws(() => validatePacket(bad), /Invalid completed/);
});
