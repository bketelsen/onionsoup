import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { investigateFriction, FrictionInvestigation, readFrictionTriage } from '../src/friction-work.ts';
import { effectiveTriage, frictionFreshness, investigationDirectory, readRevisions, revalidateFriction,
  retryFrictionRevalidation, writeRevision } from '../src/friction-revalidation.ts';
import { preflightHireExecutable } from '../src/opencode.ts';
import { frictionFixture } from './friction-fixture.ts';

async function investigated() {
  const state = await frictionFixture();
  let calls = 0;
  state.runtime.hire = async (_owner, request) => {
    calls++;
    return { value: request.schema.parse({ disposition: 'needs-evidence', observed: ['Original host evidence'],
      inferred: [], unknown: ['Positive original condition needed'] }), sessionID: 'initial', cost: 0,
    startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
  };
  await investigateFriction(state.runtime, state.report.id);
  return { ...state, initialCalls: () => calls };
}

function scriptedFix(state: Awaited<ReturnType<typeof investigated>>, fixedBy: string, conditions: string[]) {
  let calls = 0;
  state.runtime.hire = async (_owner, request) => {
    calls++;
    assert.equal(request.extraPermission?.bash, 'deny');
    assert.match(request.brief, /host-incident-bundle/);
    assert.match(request.brief, /local-checkout-not-fetched/);
    return { value: request.schema.parse({ disposition: 'already-fixed', fixedBy, conditionEvidence: conditions,
      observed: ['Host-observed original condition'], inferred: [], unknown: [] }), sessionID: 'revalidated', cost: 0,
    startedAt: state.report.firstSeen, finishedAt: state.report.firstSeen };
  };
  return () => calls;
}

test('freshness is local-only; dirty source cannot supply fresh publication evidence', async () => {
  const state = await investigated();
  try {
    const second = state.commit('Current source');
    assert.deepEqual(await frictionFreshness(state.runtime, state.report.id), {
      investigatedCommit: state.first, referenceCommit: second, stale: true, reason: 'source_stale',
      scope: 'local-checkout-not-fetched',
    });
    await writeFile(join(state.workspace, 'dirty.txt'), 'Untracked');
    assert.equal((await frictionFreshness(state.runtime, state.report.id))?.reason, 'source_unavailable');
    await assert.rejects(revalidateFriction(state.runtime, state.report.id), /not_stale/);
  } finally { await state.cleanup(); }
});

test('positive host condition plus contained version makes one append-only effective revision', async () => {
  const state = await investigated();
  try {
    const original = await readFile(join(state.runtime.stateDirectory, 'friction/investigations', `${state.report.id}.json`), 'utf8');
    state.commit('Fixing source');
    const condition = await state.resolveCondition();
    const calls = scriptedFix(state, state.first, [condition]);
    const claim = await revalidateFriction(state.runtime, state.report.id);
    assert.equal(claim.state, 'done');
    if (claim.state === 'done') assert.equal(claim.revision?.state, 'revised');
    assert.equal((await effectiveTriage(state.runtime, state.report.id))?.triage.investigation?.disposition, 'already-fixed');
    const repeated = await revalidateFriction(state.runtime, state.report.id);
    assert.deepEqual(repeated, claim);
    assert.equal(calls(), 1);
    assert.equal((await readRevisions(state.runtime, state.report.id)).length, 1);
    assert.equal(await readFile(join(state.runtime.stateDirectory, 'friction/investigations', `${state.report.id}.json`), 'utf8'), original);
  } finally { await state.cleanup(); }
});

test('source citations and fixing code alone never replace pending operational findings', async () => {
  const state = await investigated();
  try {
    const second = state.commit('Source exists, not operational evidence');
    scriptedFix(state, second, ['invented-host-condition']);
    const claim = await revalidateFriction(state.runtime, state.report.id);
    assert.equal(claim.state, 'done');
    if (claim.state === 'done') assert.equal(claim.revision?.blockedReason, 'friction_operational_condition_unverified');
    assert.equal((await effectiveTriage(state.runtime, state.report.id))?.triage.investigation?.disposition, 'needs-evidence');
  } finally { await state.cleanup(); }
});

test('unknown fixing versions remain blocked even with a real positive condition', async () => {
  const state = await investigated();
  try {
    state.commit('New source');
    scriptedFix(state, 'f'.repeat(40), [await state.resolveCondition()]);
    const claim = await revalidateFriction(state.runtime, state.report.id);
    if (claim.state !== 'done') throw new Error('Expected saved revision');
    assert.equal(claim.revision?.blockedReason, 'friction_fixed_by_unknown');
  } finally { await state.cleanup(); }
});

test('concurrent revalidations acquire one persisted claim and hire once', async () => {
  const state = await investigated();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    state.commit('Current source');
    const calls = scriptedFix(state, state.first, [await state.resolveCondition()]);
    const hire = state.runtime.hire;
    state.runtime.hire = async (...args) => { entered(); await pending; return hire(...args); };
    const first = revalidateFriction(state.runtime, state.report.id);
    await started;
    assert.equal((await revalidateFriction(state.runtime, state.report.id)).state, 'running');
    release();
    assert.equal((await first).state, 'done');
    assert.equal(calls(), 1);
  } finally { release(); await state.cleanup(); }
});

test('unknown/dead/corrupt paid claims never launch a replacement', async () => {
  const state = await investigated();
  try {
    const current = state.commit('Current source');
    const directory = investigationDirectory(state.runtime, state.report.id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `claim-${current}.json`);
    await writeFile(path, '{"state":"running","runner":999999999,"token":"paid","at":"2026-01-01T00:00:00.000Z"}');
    const calls = scriptedFix(state, state.first, []);
    assert.equal((await revalidateFriction(state.runtime, state.report.id)).state, 'uncertain');
    await writeFile(path, '{broken');
    assert.equal((await revalidateFriction(state.runtime, state.report.id)).state, 'uncertain');
    assert.equal(calls(), 0);
  } finally { await state.cleanup(); }
});

test('failed explicit hire is masked, durable and has one supported attributable retry', async () => {
  const state = await investigated();
  try {
    const current = state.commit('Current source');
    state.runtime.hire = async () => { throw new Error('PRIVATE_TRANSPORT_CREDENTIAL'); };
    const failed = await revalidateFriction(state.runtime, state.report.id);
    if (failed.state !== 'failed' || !failed.token) throw new Error('Expected failed paid claim');
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_TRANSPORT/);
    const calls = scriptedFix(state, state.first, [await state.resolveCondition()]);
    const retried = await retryFrictionRevalidation(state.runtime, state.report.id, {
      referenceCommit: current, failedToken: failed.token, authorizedBy: 'Fixture host person',
    });
    assert.equal(retried.state, 'done');
    await retryFrictionRevalidation(state.runtime, state.report.id, {
      referenceCommit: current, failedToken: failed.token, authorizedBy: 'Fixture host person',
    });
    assert.equal(calls(), 1);
    const files = await readdir(investigationDirectory(state.runtime, state.report.id));
    assert.ok(files.includes(`claim-${current}.json.failed-attempt.json`));
  } finally { await state.cleanup(); }
});

test('changed source during diagnosis saves a failure and cannot publish stale conditions', async () => {
  const state = await investigated();
  try {
    state.commit('Current source');
    const condition = await state.resolveCondition();
    const originalHire = scriptedFix(state, state.first, [condition]);
    const hire = state.runtime.hire;
    state.runtime.hire = async (...args) => { const response = await hire(...args); state.commit('Concurrent edit'); return response; };
    const claim = await revalidateFriction(state.runtime, state.report.id);
    if (claim.state !== 'failed') throw new Error('Expected changed-source failure');
    assert.equal(claim.reason, 'friction_triage_source_changed');
    assert.equal(originalHire(), 1);
    assert.deepEqual(await readRevisions(state.runtime, state.report.id), []);
  } finally { await state.cleanup(); }
});

test('already-fixed schema requires version and observations; proposal and closure are mutually exclusive', () => {
  const closure = { disposition: 'already-fixed', observed: ['Host condition'], inferred: [], unknown: [] };
  assert.equal(FrictionInvestigation.safeParse(closure).success, false);
  assert.equal(FrictionInvestigation.safeParse({ ...closure, fixedBy: 'a'.repeat(40) }).success, true);
  assert.equal(FrictionInvestigation.safeParse({ ...closure, fixedBy: 'a'.repeat(40), observed: [] }).success, false);
});

async function failedInitial() {
  const state = await investigated();
  const current = state.commit('Current source');
  state.runtime.hire = async () => { throw new Error('PRIVATE_TRANSPORT'); };
  const failed = await revalidateFriction(state.runtime, state.report.id);
  if (failed.state !== 'failed' || !failed.token) throw new Error('Expected failed paid claim');
  const path = join(investigationDirectory(state.runtime, state.report.id), `claim-${current}.json`);
  return { ...state, current, failed, path, bytes: await readFile(path, 'utf8'),
    approval: { referenceCommit: current, failedToken: failed.token, authorizedBy: 'Fixture host person' } };
}

test('revisions remain write-once, sorted and effective without replacing capture or original diagnosis', async () => {
  const state = await investigated();
  try {
    const current = state.commit('New source');
    const original = await readFrictionTriage(state.runtime, state.report.id);
    const revision = { version: 1 as const, id: state.report.id, revision: 1, previousCommit: state.first,
      sourceCommit: current, reason: 'source_stale' as const, state: 'revised' as const,
      at: new Date().toISOString(), investigation: original!.investigation! };
    await writeRevision(state.runtime, { ...revision, revision: 2, state: 'blocked', blockedReason: 'fixture' });
    await writeRevision(state.runtime, revision);
    const path = join(investigationDirectory(state.runtime, state.report.id), 'rev-1.json');
    const bytes = await readFile(path);
    await assert.rejects(writeRevision(state.runtime, revision), { code: 'EEXIST' });
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual((await readRevisions(state.runtime, state.report.id)).map(entry => entry.revision), [1, 2]);
    assert.equal((await effectiveTriage(state.runtime, state.report.id))?.revision, 1);
    assert.deepEqual(await readFrictionTriage(state.runtime, state.report.id), original);
  } finally { await state.cleanup(); }
});

test('unpublished revision temp is ignored and the next diagnosis publishes revision one', async () => {
  const state = await investigated();
  try {
    state.commit('New source');
    const directory = investigationDirectory(state.runtime, state.report.id);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, 'rev-1.json.interrupted.tmp');
    await writeFile(temporary, '{"version":1');
    assert.deepEqual(await readRevisions(state.runtime, state.report.id), []);
    scriptedFix(state, state.first, [await state.resolveCondition()]);
    assert.equal((await revalidateFriction(state.runtime, state.report.id)).state, 'done');
    assert.equal((await readRevisions(state.runtime, state.report.id))[0]?.revision, 1);
    assert.equal(await readFile(temporary, 'utf8'), '{"version":1');
  } finally { await state.cleanup(); }
});

test('revision identity and filename mismatch cannot silently become effective', async () => {
  const state = await investigated();
  try {
    const directory = investigationDirectory(state.runtime, state.report.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'rev-1.json'), JSON.stringify({ version: 1,
      id: 'fr_aaaaaaaaaaaaaaaaaaaaaaaa', revision: 1, previousCommit: state.first, sourceCommit: state.first,
      reason: 'source_stale', state: 'revised', at: new Date().toISOString(),
      investigation: (await readFrictionTriage(state.runtime, state.report.id))!.investigation }));
    await assert.rejects(readRevisions(state.runtime, state.report.id), /friction_revision_identity_mismatch/);
    await assert.rejects(effectiveTriage(state.runtime, state.report.id), /friction_revision_identity_mismatch/);
  } finally { await state.cleanup(); }
});

test('failed explicit retry cannot replenish its budget with either token', async () => {
  const state = await failedInitial();
  try {
    let calls = 0;
    state.runtime.hire = async () => { calls++; throw new Error('PRIVATE_TRANSPORT'); };
    const retried = await retryFrictionRevalidation(state.runtime, state.report.id, state.approval);
    assert.equal(retried.state, 'failed');
    assert.deepEqual(await retryFrictionRevalidation(state.runtime, state.report.id, state.approval), retried);
    await assert.rejects(retryFrictionRevalidation(state.runtime, state.report.id,
      { ...state.approval, failedToken: 'token' in retried ? retried.token! : 'missing' }), /retry_not_eligible/);
    assert.equal(calls, 1);
    assert.deepEqual(await readRevisions(state.runtime, state.report.id), []);
  } finally { await state.cleanup(); }
});

test('concurrent attributable retries acquire one replacement and preserve exact failed bytes', async () => {
  const state = await failedInitial();
  try {
    const calls = scriptedFix(state, state.first, [await state.resolveCondition()]);
    const retried = await Promise.all([retryFrictionRevalidation(state.runtime, state.report.id, state.approval),
      retryFrictionRevalidation(state.runtime, state.report.id, state.approval)]);
    assert.ok(retried.some(claim => claim.state === 'done'));
    assert.equal(calls(), 1);
    assert.equal(await readFile(`${state.path}.failed-attempt.json`, 'utf8'), state.bytes);
  } finally { await state.cleanup(); }
});

test('interrupted retry archive adopts identical bytes but rejects conflicting history', async () => {
  for (const matches of [true, false]) {
    const state = await failedInitial();
    try {
      await writeFile(`${state.path}.failed-attempt.json`, matches ? state.bytes : '{}');
      const calls = scriptedFix(state, state.first, [await state.resolveCondition()]);
      if (matches) {
        assert.equal((await retryFrictionRevalidation(state.runtime, state.report.id, state.approval)).state, 'done');
        assert.equal(calls(), 1);
      } else {
        await assert.rejects(retryFrictionRevalidation(state.runtime, state.report.id, state.approval), /retry_history_conflict/);
        assert.equal(await readFile(state.path, 'utf8'), state.bytes);
        assert.equal(calls(), 0);
      }
    } finally { await state.cleanup(); }
  }
});

for (const condition of ['running', 'dead', 'uncertain', 'malformed', 'wrong-token', 'wrong-commit', 'revision']) {
  test(`${condition} refuses attributable retry without hiring or losing history`, async () => {
    const state = await failedInitial();
    try {
      const claims: Record<string, unknown> = {
        running: { ...state.failed, state: 'running', runner: process.pid },
        dead: { ...state.failed, state: 'running', runner: 999999999 },
        uncertain: { ...state.failed, state: 'uncertain' },
      };
      if (condition in claims) await writeFile(state.path, JSON.stringify(claims[condition]));
      if (condition === 'malformed') await writeFile(state.path, '{');
      if (condition === 'revision') await writeRevision(state.runtime, { version: 1, id: state.report.id,
        revision: 1, previousCommit: state.first, sourceCommit: state.current, reason: 'source_stale',
        state: 'blocked', at: new Date().toISOString(),
        investigation: (await readFrictionTriage(state.runtime, state.report.id))!.investigation! });
      const calls = scriptedFix(state, state.first, []);
      await assert.rejects(retryFrictionRevalidation(state.runtime, state.report.id, { ...state.approval,
        ...(condition === 'wrong-token' ? { failedToken: 'other' } : {}),
        ...(condition === 'wrong-commit' ? { referenceCommit: state.first } : {}),
      }), /friction_revalidation_/);
      assert.equal(calls(), 0);
      await assert.rejects(readFile(`${state.path}.failed-attempt.json`), { code: 'ENOENT' });
    } finally { await state.cleanup(); }
  });
}

test('dead retry stays uncertain and cannot start a third attempt', async () => {
  const state = await failedInitial();
  try {
    await writeFile(`${state.path}.failed-attempt.json`, state.bytes);
    await writeFile(state.path, JSON.stringify({ state: 'running', runner: 999999999,
      token: 'retry', at: new Date().toISOString(), retry: { ...state.approval, at: new Date().toISOString() } }));
    const calls = scriptedFix(state, state.first, []);
    assert.equal((await retryFrictionRevalidation(state.runtime, state.report.id, state.approval)).state, 'uncertain');
    assert.equal((await retryFrictionRevalidation(state.runtime, state.report.id, state.approval)).state, 'uncertain');
    assert.equal(calls(), 0);
    assert.equal(await readFile(`${state.path}.failed-attempt.json`, 'utf8'), state.bytes);
  } finally { await state.cleanup(); }
});

test('missing executable consumes neither a new claim nor an attributable retry', async () => {
  const state = await investigated();
  try {
    const current = state.commit('New source');
    const binaryDirectory = join(state.root, 'bin');
    await mkdir(binaryDirectory);
    state.runtime.preflightHire = directory => preflightHireExecutable(directory, binaryDirectory);
    const calls = scriptedFix(state, state.first, []);
    await assert.rejects(revalidateFriction(state.runtime, state.report.id), /hire_executable_unavailable/);
    const path = join(investigationDirectory(state.runtime, state.report.id), `claim-${current}.json`);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    assert.equal(calls(), 0);
    const binary = join(binaryDirectory, 'opencode');
    await writeFile(binary, '#!/bin/sh\nexit 77\n');
    await chmod(binary, 0o755);
    state.runtime.hire = async () => { throw new Error('PRIVATE_TRANSPORT'); };
    const failed = await revalidateFriction(state.runtime, state.report.id);
    if (failed.state !== 'failed' || !failed.token) throw new Error('Expected failed claim');
    const bytes = await readFile(path, 'utf8');
    await rm(binary);
    await assert.rejects(retryFrictionRevalidation(state.runtime, state.report.id,
      { referenceCommit: current, failedToken: failed.token, authorizedBy: 'Fixture' }), /hire_executable_unavailable/);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await assert.rejects(readFile(`${path}.failed-attempt.json`), { code: 'ENOENT' });
  } finally { await state.cleanup(); }
});
