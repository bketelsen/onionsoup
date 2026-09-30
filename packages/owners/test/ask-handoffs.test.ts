import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HireRequest } from '../src/opencode.ts';
import { Runtime } from '../src/runtime.ts';
import { askOwner } from '../src/ask.ts';
import { Answer, readAskHandoff, recoverAskHandoffs, routeAskHandoff, saveAskHandoff, withAskConsultation, type HandoffInput } from '../src/ask-handoffs.ts';

const input: HandoffInput = {
  from: 'homelab', to: 'clippy', question: 'Please propose a fix for the known typo.',
  origin: { sessionID: 'session-fixture', messageID: 'message-fixture', directory: '/fixture/chat' },
};
const answer: Answer = {
  answer: 'A repository fix is appropriate.', observed: ['README.md has a typo'], inferred: [], unknown: [],
  proposedWork: { title: 'Repair typo', goal: 'Correct the spelling', rationale: 'README.md',
    acceptance: ['Correct spelling appears in README.md'], size: 'small', repository: 'example/clippy' },
};
async function setup() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'ask-handoff-')) });
  for (const owner of runtime.declarations.owners.values()) await runtime.notebook(owner.id).ensure('# Test');
  return runtime;
}

test('persisted answer recovers a crash before request creation without another consultation', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, answer);
  runtime.hire = async () => { throw new Error('unexpected_model_call'); };
  const resumed = await askOwner(runtime, input.from, input.to, input.question, { origin: input.origin });
  assert.equal(resumed.request?.status, 'pending-owner');
  assert.deepEqual(resumed.request?.approvals, []);
  assert.equal(resumed.request?.workItem, undefined);
  assert.equal((await runtime.requests.list()).length, 1);
  assert.ok(await readAskHandoff(runtime, input));
});

test('concurrent delivery and post-request crash retries adopt one progressed request', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, answer);
  const routed = await Promise.all(Array.from({ length: 5 }, () => routeAskHandoff(runtime, input)));
  assert.equal(new Set(routed.map(request => request?.id)).size, 1);
  await runtime.requests.update(routed[0]!.id, request => ({ ...request, status: 'denied', reason: 'Person declined' }));
  const replay = await routeAskHandoff(runtime, input);
  assert.equal(replay?.status, 'denied');
  assert.equal((await runtime.requests.list()).length, 1);
});

test('first persisted proposal wins concurrent inference; changed deterministic request payload is refused', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, answer);
  const changed = { ...answer, proposedWork: { ...answer.proposedWork!, goal: 'A different goal' } };
  assert.deepEqual((await saveAskHandoff(runtime, input, changed)).answer, answer);
  const request = (await routeAskHandoff(runtime, input))!;
  await assert.rejects(runtime.requests.openIdentified(request.id, request.from, request.to,
    { kind: 'work', purpose: 'different', proposal: changed.proposedWork }, 'none', request.origin), /request_identity_conflict/);
});

test('routing refuses undeclared repository and non-executing receiver without opening work', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, { ...answer, proposedWork: { ...answer.proposedWork!, repository: 'foreign/repository' } });
  await assert.rejects(routeAskHandoff(runtime, input), /not_your_repository/);
  const nas = { ...input, to: 'moneo' };
  await saveAskHandoff(runtime, nas, answer);
  await assert.rejects(routeAskHandoff(runtime, nas), /owner_cannot_change/);
  assert.equal((await runtime.requests.list()).length, 0);
});

test('missing evidence is a durable answer without manufactured work; malformed proposals are refused', async () => {
  const runtime = await setup();
  const evidenceOnly = { answer: 'Need a current snapshot', observed: [], inferred: [], unknown: ['Snapshot unavailable'] };
  await saveAskHandoff(runtime, input, evidenceOnly);
  assert.equal(await routeAskHandoff(runtime, input), undefined);
  assert.equal((await runtime.requests.list()).length, 0);
  assert.equal(Answer.safeParse({ ...answer, proposedWork: { ...answer.proposedWork, acceptance: [] } }).success, false);
  assert.equal(Answer.safeParse({ ...answer, proposedWork: { ...answer.proposedWork, repository: undefined } }).success, false);
  const files = await readdir(join(runtime.stateDirectory, 'handoffs'));
  const persisted = JSON.parse(await readFile(join(runtime.stateDirectory, 'handoffs', files.find(file => file.endsWith('.json'))!), 'utf8'));
  assert.deepEqual(persisted.input.origin, input.origin);
});

test('ordinary informational ask ignores unsolicited proposed work', async () => {
  const runtime = await setup();
  for (const owner of runtime.declarations.owners.values()) await runtime.notebook(owner.id).ensure('# Test');
  const receiver = runtime.declarations.owners.get('homelab')!;
  receiver.domain = { kind: 'incus', ...receiver.incus! };
  receiver.incus = undefined;
  runtime.incus = { run: async () => '[]' };
  runtime.hire = async <Output>(_owner: string, request: HireRequest<Output>) => {
    assert.match(request.brief, /informational question/);
    const at = new Date().toISOString();
    return { value: request.schema.parse(answer), sessionID: 'fixture-answer', cost: 0, startedAt: at, finishedAt: at };
  };
  const reply = await askOwner(runtime, 'clippy', 'homelab', 'What did you observe?');
  assert.equal(reply.answer.proposedWork, undefined);
  assert.equal(reply.request, undefined);
  assert.equal((await runtime.requests.list()).length, 0);
});

test('daemon recovery routes only new explicit persisted intents and retains requester origin', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, answer);
  const errors: unknown[] = [];
  assert.equal(await recoverAskHandoffs(runtime, (_id, error) => errors.push(error)), 1);
  assert.equal(errors.length, 0);
  const [request] = await runtime.requests.list();
  assert.deepEqual(request.origin, { sessionID: input.origin.sessionID, directory: input.origin.directory });
  assert.equal(await recoverAskHandoffs(runtime, (_id, error) => errors.push(error)), 0);
  assert.equal((await readAskHandoff(runtime, input))?.routing.state, 'routed');
});

test('invalid routing blocks immediately without a model wake', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, { ...answer, proposedWork: { ...answer.proposedWork!, repository: 'foreign/repo' } });
  runtime.hire = async () => { throw new Error('no_model_calls'); };
  const errors: unknown[] = [];
  for (let attempt = 0; attempt < 4; attempt++) await recoverAskHandoffs(runtime, (_id, error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.equal((await readAskHandoff(runtime, input))?.routing.state, 'blocked');
  assert.equal((await runtime.requests.list()).length, 0);
});

test('concurrent consultation is bounded and its claim releases on failure', async () => {
  const runtime = await setup();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = withAskConsultation(runtime, input, async () => { entered(); await paused; return 'answer'; });
  await started;
  await assert.rejects(withAskConsultation(runtime, input, async () => 'duplicate'), /handoff_consultation_in_progress/);
  release();
  assert.equal(await first, 'answer');
  await assert.rejects(withAskConsultation(runtime, input, async () => { throw new Error('fixture_failure'); }), /fixture_failure/);
  assert.equal(await withAskConsultation(runtime, input, async () => 'retry'), 'retry');
});

test('journal failure cannot block an already durable request and daemon repairs the journal', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, answer);
  const originalNotebook = runtime.notebook.bind(runtime);
  runtime.notebook = owner => {
    const notebook = originalNotebook(owner);
    notebook.journal = async () => { throw new Error('fixture_journal_unavailable'); };
    return notebook;
  };
  const request = await routeAskHandoff(runtime, input);
  assert.equal(request?.status, 'pending-owner');
  assert.equal((await readAskHandoff(runtime, input))?.routing.state, 'routed');
  assert.equal((await readAskHandoff(runtime, input))?.journal.attempts, 1);
  runtime.notebook = originalNotebook;
  await recoverAskHandoffs(runtime, (_id, error) => { throw error; });
  assert.equal((await readAskHandoff(runtime, input))?.journal.done, true);
  assert.equal((await runtime.requests.list()).length, 1);
});

test('persisted paid answer survives blocked routing and repeated replay does not retry it', async () => {
  const runtime = await setup();
  const invalid = { ...answer, proposedWork: { ...answer.proposedWork!, repository: 'foreign/repo' } };
  await saveAskHandoff(runtime, input, invalid);
  runtime.hire = async () => { throw new Error('no_repeat_inference'); };
  const reply = await askOwner(runtime, input.from, input.to, input.question, { origin: input.origin });
  assert.deepEqual(reply.answer, invalid);
  assert.equal(reply.handoffStatus?.state, 'blocked');
  assert.equal(reply.handoffStatus?.reason, 'not_your_repository');
  await askOwner(runtime, input.from, input.to, input.question, { origin: input.origin });
  assert.equal((await readAskHandoff(runtime, input))?.routing.attempts, 1);
  assert.equal((await runtime.requests.list()).length, 0);
});

test('missing consultation claim at cleanup does not mask the completed answer', async () => {
  const runtime = await setup();
  const reply = await withAskConsultation(runtime, input, async () => {
    const directory = join(runtime.stateDirectory, 'handoffs');
    const [claim] = (await readdir(directory)).filter(name => name.endsWith('.claim'));
    await unlink(join(directory, claim));
    return 'completed answer';
  });
  assert.equal(reply, 'completed answer');
});

test('recovery adopts a created request after declarations change before routing marker persisted', async () => {
  const runtime = await setup();
  await saveAskHandoff(runtime, input, answer);
  const request = await routeAskHandoff(runtime, input);
  const directory = join(runtime.stateDirectory, 'handoffs');
  const [name] = (await readdir(directory)).filter(name => name.endsWith('.json'));
  const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
  record.routing = { state: 'pending', attempts: 0 };
  await writeFile(join(directory, name), JSON.stringify(record));
  runtime.declarations.owners.delete(input.to);
  const adopted = await routeAskHandoff(runtime, input);
  assert.equal(adopted?.id, request?.id);
  assert.equal((await readAskHandoff(runtime, input))?.routing.state, 'routed');
  assert.equal((await runtime.requests.list()).length, 1);
});
