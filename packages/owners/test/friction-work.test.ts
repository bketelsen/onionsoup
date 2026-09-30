import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { drain, scheduleFriction } from '../src/daemon.ts';
import { Runtime } from '../src/runtime.ts';
import { reportFriction } from '../src/friction.ts';
import { consumeFrictionWake, investigateFriction, nextFrictionInvestigation, readFrictionTriage } from '../src/friction-work.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'friction-triage-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  runtime.declarations.root = root;
  const owner = runtime.declarations.owners.get('clippy')!;
  owner.workspace = join(root, 'source');
  await mkdir(owner.workspace);
  execFileSync('git', ['init', owner.workspace]);
  execFileSync('git', ['-C', owner.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-m', 'fixture']);
  await runtime.notebook('clippy').ensure('# Fixture');
  const report = await reportFriction(runtime, { owner: 'clippy', submissionID: 'one',
    origin: { sessionID: 'fixture', directory: owner.workspace }, model: 'fixture/model', commit: 'a'.repeat(40),
    failures: [], input: { summary: 'Verification cannot see required evidence', expected: 'Evidence is available', actual: 'Evidence unavailable' } });
  const policy = { version: 1, owner: 'clippy', repository: 'example/clippy', enabledSince: '2020-01-01T00:00:00.000Z' };
  let calls = 0;
  runtime.hire = async (_owner, request) => {
    calls++;
    assert.equal(request.role, 'owner');
    assert.equal(request.extraPermission?.bash, 'deny');
    assert.equal(request.directory, owner.workspace);
    return { value: request.schema.parse({ observed: ['fixture source examined'], inferred: [], unknown: [],
      disposition: 'propose-fix', proposedWork: { title: 'Fix evidence', goal: 'Provide evidence', rationale: 'Review blocked',
        acceptance: ['Reviewer receives evidence'], size: 'small', repository: 'example/clippy' } }),
    sessionID: 'fixture-hire', cost: 0, startedAt: report.firstSeen, finishedAt: report.firstSeen };
  };
  return { root, runtime, report, policy, calls: () => calls,
    enable: async (value = policy) => writeFile(join(root, 'friction-triage.json'), JSON.stringify(value)),
    cleanup: async () => { runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test('disabled and cutoff prevent legacy dispatch; durable result suppresses duplicates without opening work', async () => {
  const fixtureState = await fixture();
  const { runtime, report, root, policy } = fixtureState;
  try {
    assert.deepEqual(await investigateFriction(runtime, report.id), { state: 'disabled' });
    await fixtureState.enable({ ...policy, enabledSince: '2099-01-01T00:00:00.000Z' });
    assert.equal(await consumeFrictionWake(runtime), undefined);
    await assert.rejects(investigateFriction(runtime, report.id), /before_cutoff/);
    await fixtureState.enable();
    const wakePath = join(root, 'state/friction/wakes', `${report.id}.json`);
    const original = await readFile(wakePath, 'utf8');
    const investigation = await consumeFrictionWake(runtime);
    assert.equal(investigation?.state, 'investigated');
    assert.equal((await readFrictionTriage(runtime, report.id))?.investigation?.proposedWork?.repository, 'example/clippy');
    await investigateFriction(runtime, report.id);
    assert.equal(await consumeFrictionWake(runtime), undefined);
    assert.equal(fixtureState.calls(), 1);
    assert.deepEqual(await runtime.requests.list(), []);
    assert.deepEqual(await runtime.ledger.list(), []);
    assert.equal(await readFile(wakePath, 'utf8'), original);
  } finally { await fixtureState.cleanup(); }
});

test('orphaned running claim becomes uncertain without another hire', async () => {
  const fixtureState = await fixture();
  const { runtime, root, report, policy } = fixtureState;
  try {
    await fixtureState.enable();
    const directory = join(root, 'state/friction/investigations');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${report.id}.json`), JSON.stringify({ version: 1, id: report.id, policy,
      state: 'running', createdAt: report.firstSeen, updatedAt: report.firstSeen }));
    const recovered = await investigateFriction(runtime, report.id);
    assert.equal('reason' in recovered && recovered.reason, 'friction_triage_delivery_uncertain');
    assert.equal(fixtureState.calls(), 0);
  } finally { await fixtureState.cleanup(); }
});

test('unowned repository policy fails before claim or hire', async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.enable({ ...fixtureState.policy, repository: 'other/private' });
    await assert.rejects(investigateFriction(fixtureState.runtime, fixtureState.report.id), /not_your_repository/);
    assert.equal(fixtureState.calls(), 0);
    assert.equal(await readFrictionTriage(fixtureState.runtime, fixtureState.report.id), undefined);
  } finally { await fixtureState.cleanup(); }
});

test('failed inference is durable, bounded and does not expose transport secrets or retry', async () => {
  const fixtureState = await fixture();
  let calls = 0;
  fixtureState.runtime.hire = async () => { calls++; throw new Error('Bearer TEST_SECRET'); };
  try {
    await fixtureState.enable();
    const outcome = await investigateFriction(fixtureState.runtime, fixtureState.report.id);
    assert.equal('reason' in outcome && outcome.reason, 'friction_triage_investigation_failed');
    assert.doesNotMatch(JSON.stringify(outcome), /TEST_SECRET/);
    await investigateFriction(fixtureState.runtime, fixtureState.report.id);
    assert.equal(calls, 1);
  } finally { await fixtureState.cleanup(); }
});


test('daemon honors a maintainer reservation and does not block other scheduling on inference', async () => {
  const fixtureState = await fixture();
  const log = { duty() {}, item() {}, request() {}, error(_context: string, error: unknown) { throw error; } };
  try {
    await fixtureState.enable();
    await scheduleFriction(fixtureState.runtime, log, new Set(['clippy']));
    await drain();
    assert.equal(fixtureState.calls(), 0);
    await scheduleFriction(fixtureState.runtime, log, new Set());
    await drain();
    assert.equal(fixtureState.calls(), 1);
    assert.equal((await readFrictionTriage(fixtureState.runtime, fixtureState.report.id))?.state, 'investigated');
  } finally { await fixtureState.cleanup(); }
});

test('model cannot select a different repository for its proposal', async () => {
  const fixtureState = await fixture();
  fixtureState.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({ observed: [], inferred: [], unknown: [],
    disposition: 'propose-fix', proposedWork: { title: 'Wrong repo', goal: 'Wrong repo', rationale: 'Wrong repo',
      acceptance: ['Done'], size: 'small', repository: 'other/private' } }), sessionID: 'fixture', cost: 0,
    startedAt: fixtureState.report.firstSeen, finishedAt: fixtureState.report.firstSeen });
  try {
    await fixtureState.enable();
    const outcome = await investigateFriction(fixtureState.runtime, fixtureState.report.id);
    assert.equal('reason' in outcome && outcome.reason, 'friction_triage_wrong_repository');
    assert.equal('investigation' in outcome, false);
    const saved = await readFrictionTriage(fixtureState.runtime, fixtureState.report.id);
    assert.equal(saved?.sessionID, 'fixture');
    assert.equal(saved?.cost, 0);
    assert.deepEqual(await fixtureState.runtime.requests.list(), []);
  } finally { await fixtureState.cleanup(); }
});


test('running claim is readable and concurrent calls adopt it without another paid session', async () => {
  const fixtureState = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  fixtureState.runtime.hire = async (_owner, request) => {
    calls++;
    entered();
    await pending;
    return { value: request.schema.parse({ disposition: 'no-action', observed: ['No defect'], inferred: [], unknown: [] }),
      sessionID: 'fixture', cost: 0, startedAt: fixtureState.report.firstSeen, finishedAt: fixtureState.report.firstSeen };
  };
  try {
    await fixtureState.enable();
    const first = investigateFriction(fixtureState.runtime, fixtureState.report.id);
    await started;
    assert.equal((await readFrictionTriage(fixtureState.runtime, fixtureState.report.id))?.state, 'running');
    assert.equal((await investigateFriction(fixtureState.runtime, fixtureState.report.id)).state, 'running');
    release();
    assert.equal((await first).state, 'investigated');
    assert.equal(calls, 1);
  } finally { release(); await fixtureState.cleanup(); }
});

test('changed selection policy cannot dispatch under the previously reserved owner', async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.enable();
    const selected = await nextFrictionInvestigation(fixtureState.runtime);
    assert.ok(selected);
    await fixtureState.enable({ ...fixtureState.policy, owner: 'bellonda', repository: 'example/wiki' });
    assert.equal(await consumeFrictionWake(fixtureState.runtime, selected), undefined);
    assert.equal(fixtureState.calls(), 0);
  } finally { await fixtureState.cleanup(); }
});


test('invalid oldest wake cannot starve later valid reports or consume cadence', async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.enable();
    const valid = await reportFriction(fixtureState.runtime, { owner: 'clippy', submissionID: 'second',
      origin: { sessionID: 'fixture', directory: '/fixture' }, model: 'fixture/model', commit: 'a'.repeat(40), failures: [],
      input: { summary: 'Distinct later issue', expected: 'Useful answer', actual: 'Answer unavailable' } });
    await writeFile(join(fixtureState.root, 'state/friction/records', `${fixtureState.report.id}.json`), JSON.stringify({
      ...fixtureState.report, firstSeen: '2021-01-01T00:00:00.000Z', lastSeen: '2021-01-01T00:00:00.000Z',
    }));
    await rm(join(fixtureState.root, 'state/friction/wakes', `${fixtureState.report.id}.json`));
    const errors: string[] = [];
    const next = await nextFrictionInvestigation(fixtureState.runtime, (id, reason) => errors.push(`${id}:${reason}`));
    assert.equal(next?.id, valid.id);
    assert.ok(errors.includes(`${fixtureState.report.id}:friction_triage_discovery_unreadable`));
    const outcome = await consumeFrictionWake(fixtureState.runtime, next);
    assert.equal(outcome?.id, valid.id);
    assert.equal(outcome?.state, 'investigated');
    assert.equal(fixtureState.calls(), 1);
  } finally { await fixtureState.cleanup(); }
});

test('corrupt sidecar is attributable and skipped; due duties take priority over friction', async () => {
  const fixtureState = await fixture();
  const log = { duty() {}, item() {}, request() {}, error() {} };
  try {
    await fixtureState.enable();
    fixtureState.runtime.declarations.owners.get('clippy')!.duties.push({ id: 'due', kind: 'survey', raises: 'attention',
      every: '1h', instructions: 'Observe fixture' });
    await scheduleFriction(fixtureState.runtime, log, new Set());
    await drain();
    assert.equal(fixtureState.calls(), 0);
    const directory = join(fixtureState.root, 'state/friction/investigations');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${fixtureState.report.id}.json`), '{broken');
    const errors: string[] = [];
    assert.equal(await nextFrictionInvestigation(fixtureState.runtime, (id, reason) => errors.push(`${id}:${reason}`)), undefined);
    assert.deepEqual(errors, [`${fixtureState.report.id}:friction_triage_discovery_unreadable`]);
  } finally { await fixtureState.cleanup(); }
});
