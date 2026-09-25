import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Plugin } from '@opencode-ai/plugin';
import { recentActivityContext, recentJournal } from '../src/chat-context.ts';
import { engineCommit, FrictionEvents, frictionDetail, listFriction, reportFriction, safeProse, safeToolError } from '../src/friction.ts';
import { withActiveHooks } from './active-hooks.ts';
import { Runtime } from '../src/runtime.ts';
import { Notebook } from '../src/notebook.ts';

const declarations = 'packages/owners/test/fixtures/owners';
async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-friction-'));
  const runtime = await Runtime.open({ declarations, state });
  await runtime.notebook('homelab').ensure('# Test');
  return { runtime, state };
}

const input = { summary: 'An engine failure when verifying', expected: 'Verification passes', actual: 'Verification failed' };
function submission(owner = 'homelab', submissionID = 'one') {
  return { owner, submissionID, origin: { sessionID: 'ses_first', directory: '/desk' },
    model: 'provider/model', commit: 'a'.repeat(40), input,
    failures: [{ tool: 'bash', input: 'arguments withheld', error: 'permission denied' }] };
}

test('observed failure is session-isolated, ignores untrusted input, and unobserved context says unavailable', () => {
  const events = new FrictionEvents();
  events.observe({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_first', type: 'tool', tool: 'bash',
    state: { status: 'error', input: { command: 'token=SECRET; cat /private/.env', patchText: 'secret' }, error: 'permission denied token=SECRET' } } } });
  events.observe({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_first', type: 'tool', tool: 'edit',
    state: { status: 'completed', output: 'failed in prose' } } } });
  events.observe({ type: 'message.updated', properties: { info: { sessionID: 'ses_first', role: 'assistant', providerID: 'p', modelID: 'm' } } });
  events.observe({ type: 'message.part.updated', properties: { part: { sessionID: 4, type: 'tool', tool: 'bash', state: { status: 'error' } } } });
  assert.deepEqual(events.context('ses_first'), { model: 'p/m', failures: [{ tool: 'bash', input: 'arguments withheld', error: 'permission denied' }] });
  assert.deepEqual(events.context('ses_second'), { model: 'unavailable', failures: [] });
  assert.equal(safeProse('token=SECRET .env'), 'token=[redacted] [env file]');
  assert.throws(() => safeProse('-----BEGIN PRIVATE KEY-----'), /friction_unsafe_text/);
  assert.equal(safeProse('Failure ghp_SUPERSECRET1234'), 'Failure [redacted]');
});

test('re-emitted errored parts replace the same call instead of evicting distinct failures', () => {
  const events = new FrictionEvents();
  for (const id of ['one', 'two', 'three', 'four', 'five', 'five']) {
    events.observe({ type: 'message.part.updated', properties: { part: {
      id, sessionID: 'session', type: 'tool', tool: id, state: { status: 'error', error: 'permission denied' },
    } } });
  }
  assert.deepEqual(events.context('session').failures.map(failure => failure.tool), ['one', 'two', 'three', 'four', 'five']);
});

test('two runtimes deduplicate by failure shape and keep first occurrence with one wake', async () => {
  const { runtime, state } = await fixture();
  const other = await Runtime.open({ declarations, state });
  const first = await reportFriction(runtime, submission());
  const second = await reportFriction(other, { ...submission('homelab', 'two'),
    origin: { sessionID: 'ses_next', directory: '/new/desk' }, input: { ...input, actual: 'Different session result' } });
  assert.equal(second.id, first.id);
  assert.equal(second.count, 2);
  assert.equal(second.firstSeen, first.firstSeen);
  assert.deepEqual(second.origin, first.origin);
  assert.equal((await readdir(join(state, 'friction', 'wakes'))).filter(file => file.endsWith('.json')).length, 1);
  assert.equal((await listFriction(runtime)).length, 1);
  assert.equal((await frictionDetail(runtime, first.id)).count, 2);
  assert.equal((await recentJournal(runtime, 'homelab')).filter(entry => entry.kind === 'friction').length, 2);
  const { deskState } = await import('../src/desk.ts');
  const desk = await deskState(runtime, { owner: 'homelab' });
  assert.ok('notes' in desk && desk.notes?.some(note => note.kind === 'friction'));
  assert.match(await recentActivityContext(runtime, 'homelab'), /friction/);
  assert.equal((await reportFriction(other, submission())).count, 2, 'retry must not count again');
  const { stdout } = await promisify(execFile)('git', ['-C', runtime.notebook('homelab').root, 'status', '--porcelain', 'homelab']);
  assert.equal(stdout, '', 'friction journal is committed');
});

test('a blocked or failed notebook commit cannot hold up friction reads or reject a saved report', async () => {
  const { runtime } = await fixture();
  const original = Notebook.prototype.commit;
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  Notebook.prototype.commit = async function () {
    started();
    await blocked;
    throw new Error('index.lock busy');
  };
  try {
    const reporting = reportFriction(runtime, submission());
    await entered;
    const listing = await Promise.race([listFriction(runtime), new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('friction_read_blocked_by_notebook')), 1000);
    })]);
    assert.equal(listing.length, 1);
    release();
    assert.equal((await reporting).count, 1);
    assert.equal((await reportFriction(runtime, submission())).count, 1);
  } finally {
    release();
    Notebook.prototype.commit = original;
  }
});

test('unknown error shapes retain a safe discriminator and do not merge distinct failures', async () => {
  const { runtime, state } = await fixture();
  const first = await reportFriction(runtime, { ...submission(), failures: [{ tool: 'bash', input: 'SECRET COMMAND', error: 'daemon refused job 387 /secret/one' }] });
  const repeat = await reportFriction(runtime, { ...submission('homelab', 'repeat'), failures: [{ tool: 'bash', input: 'OTHER SECRET', error: 'daemon refused job 499 /secret/two' }] });
  const different = await reportFriction(runtime, { ...submission('homelab', 'different'), failures: [{ tool: 'bash', input: 'SECRET', error: 'compiler rejected syntax 127 /other/path' }] });
  assert.equal(first.id, repeat.id);
  assert.notEqual(first.id, different.id);
  assert.equal((await readdir(join(state, 'friction', 'wakes'))).filter(file => file.endsWith('.json')).length, 2);
  assert.doesNotMatch(JSON.stringify(await listFriction(runtime)), /SECRET|387|499|127|\/secret\//);
  assert.equal(safeToolError('daemon refused job 492 /tmp/log'), safeToolError('daemon refused job 567 /tmp/other'));
});

test('interrupted submission is retried without incrementing twice, and missing records fail explicitly', async () => {
  const { runtime, state } = await fixture();
  const first = await reportFriction(runtime, submission());
  const marker = join(state, 'friction', 'submissions', `${createHash('sha256').update('one').digest('hex').slice(0, 24)}.json`);
  await writeFile(marker, JSON.stringify({ id: first.id, journaled: false, baseline: 0 }));
  assert.equal((await reportFriction(runtime, submission())).count, 1);
  await rm(join(state, 'friction', 'records', `${first.id}.json`));
  await assert.rejects(reportFriction(runtime, submission()), /friction_missing_record/);
  assert.equal((await readdir(join(state, 'friction', 'records'))).length, 0);
});

test('a pre-write pending claim blocks another submitter until its original submission recovers', async () => {
  const { runtime, state } = await fixture();
  const original = await reportFriction(runtime, submission());
  const markerID = createHash('sha256').update('interrupted').digest('hex').slice(0, 24);
  const pendingPath = join(state, 'friction', 'pending', `${original.id}.json`);
  const marker = join(state, 'friction', 'submissions', `${markerID}.json`);
  await writeFile(pendingPath, JSON.stringify(markerID));
  await writeFile(marker, JSON.stringify({ id: original.id, journaled: false, baseline: 1 }));
  await assert.rejects(reportFriction(runtime, submission('homelab', 'another')), /friction_pending_submission/);
  const recovered = await reportFriction(runtime, submission('homelab', 'interrupted'));
  assert.equal(recovered.count, 2);
  assert.equal((await reportFriction(runtime, submission('homelab', 'interrupted'))).count, 2);
  assert.equal((await reportFriction(runtime, submission('homelab', 'another'))).count, 3);
});

test('concurrent submissions, provisional fallback and invalid records', async () => {
  const { runtime, state } = await fixture();
  const records = await Promise.all(Array.from({ length: 8 }, (_, index) => reportFriction(runtime, submission('homelab', `concurrent-${index}`))));
  assert.equal((await frictionDetail(runtime, records[0]!.id)).count, 8);
  const absent = { ...submission('homelab', 'absent'), failures: [] };
  const provisional = await reportFriction(runtime, absent);
  const repeated = await reportFriction(runtime, { ...absent, submissionID: 'absent-repeat', input: { ...input, actual: 'Verification failed' } });
  assert.equal(provisional.id, repeated.id);
  assert.equal(provisional.failureContext, 'unavailable');
  assert.equal(provisional.provisional, true);
  const meaningless = { ...absent, input: { summary: '???', expected: '!!!', actual: '...' } };
  const unique = await reportFriction(runtime, { ...meaningless, submissionID: 'meaningless-1' });
  assert.notEqual(unique.id, (await reportFriction(runtime, { ...meaningless, submissionID: 'meaningless-2' })).id);
  await assert.rejects(reportFriction(runtime, { ...absent, submissionID: 'huge',
    input: { ...input, evidence: '🎯'.repeat(1000) } }), /too_big|too large|Too big|maximum|<=/i);
  const redacted = await reportFriction(runtime, { ...absent, submissionID: 'unsafe',
    input: { ...input, summary: 'Credential environment failure', evidence: 'api_key=SECRET' } });
  assert.equal(redacted.evidence, 'api_key=[redacted]');
  await writeFile(join(state, 'friction', 'records', 'fr_aaaaaaaaaaaaaaaaaaaaaaaa.json'), '{bad');
  assert.equal((await listFriction(runtime)).length, 5);
  assert.ok((await readFile(join(state, 'friction', 'records', `${records[0]!.id}.json`), 'utf8')).length < 8192);
});

test('active plugin hook executes owner-only capture with host commit and no event context', async () => {
  const { runtime, state } = await fixture();
  const hooks = await withActiveHooks({ client: {} } as unknown as Parameters<Plugin>[0], { declarations, state });
  const tool = hooks.tool!.onionsoup_friction!;
  const context = { agent: 'Miles Teg', sessionID: 'ses_host', messageID: 'msg_host', directory: '/desk' };
  await assert.rejects(tool.execute(input, { ...context, agent: 'someone else' } as never), /not one/);
  assert.match(String(await tool.execute(input, context as never)), /Recorded fr_/);
  const [record] = await listFriction(runtime);
  assert.equal(record?.commit, await engineCommit());
  assert.equal(record?.model, 'unavailable');
  assert.equal(record?.failureContext, 'unavailable');
  await hooks.event!({ event: { type: 'message.updated', properties: { info: {
    sessionID: 'ses_observed', role: 'assistant', providerID: 'copilot', modelID: 'model',
  } } } as never });
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'part_failed', sessionID: 'ses_observed', type: 'tool', tool: 'bash',
    state: { status: 'error', error: 'permission denied: token=SHOULD_NOT_PERSIST', input: { command: 'cat /private/.env' } },
  } } } as never });
  await tool.execute({ ...input, actual: 'An observed permission failure' },
    { ...context, sessionID: 'ses_observed', messageID: 'msg_observed' } as never);
  const observed = (await listFriction(runtime)).find(entry => entry.failureContext === 'observed');
  assert.equal(observed?.model, 'copilot/model');
  assert.equal(observed?.failures[0]?.error, 'permission denied');
  assert.doesNotMatch(JSON.stringify(observed), /SHOULD_NOT_PERSIST|cat \/private|\.env/);
});
