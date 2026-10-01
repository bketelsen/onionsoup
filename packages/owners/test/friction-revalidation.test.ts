import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FrictionInvestigation, type FrictionTriage } from '../src/friction-work.ts';
import { effectiveTriage, frictionFreshness, investigationDirectory, readRevisions, revalidateFriction,
  retryFrictionRevalidation, writeRevision } from '../src/friction-revalidation.ts';
import { preflightHireExecutable } from '../src/opencode.ts';
import { Runtime } from '../src/runtime.ts';
import { effectiveProposalDigest, frictionProposalDigest, promoteFriction, recoverFrictionPromotions } from '../src/friction-promotion.ts';
import { openOwnerSession, type OwnerSessionClient } from '../src/owner-sessions.ts';
import { approvePlan } from '../src/work-recovery.ts';
import { ensureDesk } from '../src/workspace.ts';

const id = 'fr_012345678901234567890123';
const at = '2026-01-01T00:00:00.000Z';
const originalInvestigation: NonNullable<FrictionTriage['investigation']> = {
  observed: ['owner-sessions.ts executionPlace at A'], inferred: [], unknown: [], disposition: 'propose-fix',
  proposedWork: { title: 'Serialize per-owner plan execution', goal: 'Separate plans safely', rationale: 'Shared desk', size: 'small',
    repository: 'example/clippy', acceptance: ['Regression passes'] },
};

async function fixture(representative = false) {
  const root = await mkdtemp(join(tmpdir(), 'friction-revalidation-'));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  runtime.declarations.root = root;
  runtime.preflightHire = async () => {};
  const owner = runtime.declarations.owners.get('clippy')!;
  const workspace = join(root, 'source');
  owner.workspace = workspace;
  await mkdir(workspace);
  execFileSync('git', ['init', workspace]);
  const commit = (message: string) => {
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', message]);
    return execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const first = commit('A');
  for (const file of ['owner-sessions.ts', 'plan-worktrees.ts', 'desk-changes.ts', 'work-lifecycle.test.ts', '_x.ts']) {
    const source = file === 'work-lifecycle.test.ts' ? 'test' : 'src';
    const contents = representative && file !== '_x.ts'
      ? await readFile(`packages/owners/${source}/${file}`, 'utf8')
      : 'fixture line one\nfixture line two\nfixture line three\n';
    await writeFile(join(workspace, file), contents);
  }
  execFileSync('git', ['-C', workspace, 'add', '.']);
  const fixed = commit('C each approved plan gets its own worktree');
  const second = commit('B');
  const triage: FrictionTriage = { version: 1, id, state: 'investigated', createdAt: at, updatedAt: at,
    policy: { version: 1, owner: 'clippy', repository: 'example/clippy', enabledSince: at, intervalMs: 3600000 },
    sourceCommit: first, investigation: originalInvestigation };
  const directory = join(runtime.stateDirectory, 'friction', 'investigations');
  await mkdir(directory, { recursive: true });
  const originalPath = join(directory, `${id}.json`);
  await writeFile(originalPath, JSON.stringify(triage));
  return { root, runtime, workspace, first, fixed, second, triage, originalPath,
    cleanup: async () => { runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test('local clean HEAD determines freshness without fetching, and dirty source fails closed', async () => {
  const state = await fixture();
  try {
    assert.deepEqual(await frictionFreshness(state.runtime, id), {
      investigatedCommit: state.first, referenceCommit: state.second, stale: true, reason: 'source_stale',
      scope: 'local-checkout-not-fetched',
    });
    execFileSync('git', ['-C', state.workspace, 'checkout', state.first], { stdio: 'ignore' });
    assert.deepEqual(await frictionFreshness(state.runtime, id), {
      investigatedCommit: state.first, referenceCommit: state.first, stale: false, scope: 'local-checkout-not-fetched',
    });
    await writeFile(join(state.workspace, 'dirty.txt'), 'untracked');
    assert.deepEqual(await frictionFreshness(state.runtime, id), {
      investigatedCommit: state.first, stale: true, reason: 'source_unavailable', scope: 'local-checkout-not-fetched',
    });
    await rm(state.workspace, { recursive: true, force: true });
    assert.equal((await frictionFreshness(state.runtime, id))?.reason, 'source_unavailable');
  } finally { await state.cleanup(); }
});

async function enabled(state: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(state.root, 'friction-triage.json'), JSON.stringify(state.triage.policy));
}

function scriptedHire(state: Awaited<ReturnType<typeof fixture>>, fixedBy = state.fixed) {
  let calls = 0;
  state.runtime.hire = async (_owner, request) => {
    calls++;
    assert.equal(request.role, 'owner');
    assert.equal(request.model, state.runtime.declarations.owners.get('clippy')!.model);
    assert.equal(request.directory, state.workspace);
    assert.equal(request.extraPermission?.bash, 'deny');
    assert.match(request.brief, /local-checkout-not-fetched/);
    assert.match(request.brief, new RegExp(state.first));
    assert.match(request.brief, new RegExp(state.second));
    assert.match(request.brief, /Serialize per-owner plan execution/);
    assert.match(request.brief, /A changed commit alone is not a fix/);
    return { value: request.schema.parse({ observed: [
      'owner-sessions.ts:1 executionPlace selects plan worktrees',
      'plan-worktrees.ts:1 ensurePlanWorktree creates the worktree',
      'desk-changes.ts:1 proposalDigest/proposalDirectory bind the proposal',
      'work-lifecycle.test.ts:1 concurrent plans are isolated',
    ], inferred: [], unknown: [], disposition: 'already-fixed', fixedBy }),
    sessionID: 'revalidation-hire', cost: 0, startedAt: at, finishedAt: at };
  };
  return () => calls;
}

test('explicit revalidation saves an append-only already-fixed revision and adopts a completed claim', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    const calls = scriptedHire(state);
    const original = await readFile(state.originalPath, 'utf8');
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    assert.equal(claim.revision?.investigation.disposition, 'already-fixed');
    assert.equal(claim.revision?.investigation.fixedBy, state.fixed);
    assert.equal((await readRevisions(state.runtime, id)).length, 1);
    assert.equal((await effectiveTriage(state.runtime, id))?.triage.investigation?.disposition, 'already-fixed');
    assert.equal(await readFile(state.originalPath, 'utf8'), original);
    assert.deepEqual(await revalidateFriction(state.runtime, id), claim);
    assert.equal(calls(), 1);
  } finally { await state.cleanup(); }
});

test('concurrent explicit revalidations acquire one claim and hire only once', async () => {
  const state = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await enabled(state);
    const calls = scriptedHire(state);
    const scripted = state.runtime.hire;
    state.runtime.hire = async (...args) => { entered(); await pending; return scripted(...args); };
    const first = revalidateFriction(state.runtime, id);
    await started;
    assert.equal((await revalidateFriction(state.runtime, id)).state, 'running');
    release();
    assert.equal((await first).state, 'done');
    assert.equal(calls(), 1);
  } finally { release(); await state.cleanup(); }
});

test('failed hire persists only a bounded failure and cannot retry for the same commit', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    let calls = 0;
    state.runtime.hire = async () => { calls++; throw new Error('Bearer SECRET'); };
    const failed = await revalidateFriction(state.runtime, id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason, 'friction_revalidation_failed');
    assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
    assert.deepEqual(await revalidateFriction(state.runtime, id), failed);
    assert.equal(calls, 1);
    assert.deepEqual(await readRevisions(state.runtime, id), []);
  } finally { await state.cleanup(); }
});

test('dead running claim becomes uncertain without hiring', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    const directory = investigationDirectory(state.runtime, id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `claim-${state.second}.json`), JSON.stringify({ state: 'running', runner: 2147483647,
      token: 'fixture', at }));
    state.runtime.hire = async () => { throw new Error('unexpected hire'); };
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'uncertain');
    assert.equal(claim.reason, 'friction_revalidation_uncertain');
    assert.deepEqual(await revalidateFriction(state.runtime, id), claim);
  } finally { await state.cleanup(); }
});

test('malformed preexisting claim stays uncertain and never starts a hire', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    const directory = investigationDirectory(state.runtime, id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `claim-${state.second}.json`);
    await writeFile(path, '{"state":"running"');
    state.runtime.hire = async () => { throw new Error('unexpected hire'); };
    assert.deepEqual(await revalidateFriction(state.runtime, id), {
      state: 'uncertain', reason: 'friction_revalidation_uncertain',
    });
    assert.equal(await readFile(path, 'utf8'), '{"state":"running"');
  } finally { await state.cleanup(); }
});

test('different reference commits concurrently allocate distinct revisions without re-hiring', async () => {
  const state = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  let bothEntered!: () => void;
  const started = new Promise<void>(resolve => { bothEntered = resolve; });
  let other: Runtime | undefined;
  try {
    await enabled(state);
    const otherWorkspace = join(state.root, 'other-source');
    execFileSync('git', ['clone', '--quiet', state.workspace, otherWorkspace]);
    execFileSync('git', ['-C', otherWorkspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'different reference']);
    other = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(state.root, 'state') });
    other.declarations.root = state.root;
    other.preflightHire = async () => {};
    other.declarations.owners.get('clippy')!.workspace = otherWorkspace;
    let calls = 0;
    const hire: typeof state.runtime.hire = async (_owner, request) => {
      calls++;
      entered++;
      if (entered === 2) bothEntered();
      await pending;
      return { value: request.schema.parse({ observed: ['owner-sessions.ts:1 checked'], inferred: [], unknown: [],
        disposition: 'no-action' }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at };
    };
    state.runtime.hire = hire;
    other.hire = hire;
    const first = revalidateFriction(state.runtime, id);
    const second = revalidateFriction(other, id);
    await started;
    release();
    const claims = await Promise.all([first, second]);
    assert.deepEqual(claims.map(claim => claim.state), ['done', 'done']);
    assert.deepEqual((await readRevisions(state.runtime, id)).map(revision => revision.revision), [1, 2]);
    assert.equal(calls, 2);
  } finally { release(); other?.close(); await state.cleanup(); }
});

test('unverifiable source citations block already-fixed without replacing the effective proposal', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
      observed: ['owner-sessions.ts:1000 does not exist', 'missing.ts:1 is not in the tree'],
      inferred: [], unknown: [], disposition: 'already-fixed', fixedBy: state.fixed,
    }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    assert.equal(claim.revision?.state, 'blocked');
    assert.equal(claim.revision?.blockedReason, 'friction_citation_unverified');
    assert.equal((await effectiveTriage(state.runtime, id))?.revision, 0);
  } finally { await state.cleanup(); }
});

for (const citation of ['missing.ts:1 absent', 'owner-sessions.ts:4 beyond end',
  'owner-sessions.ts:3-4 bad range', 'owner-sessions.ts:0 invalid line',
  'owner-sessions.ts:1 valid but missing.ts:1 absent',
  'owner-sessions.ts exists but has no line number',
  'owner-sessions.ts:1 valid but plan-worktrees.ts has no line number',
  'owner-sessions.ts:1 verified; `plan-worktrees.ts` also confirms',
  'owner-sessions.ts:1 verified; **plan-worktrees.ts** also confirms',
  'owner-sessions.ts:1 verified; _plan-worktrees.ts_ also confirms',
  'owner-sessions.ts:1 verified; [x](plan-worktrees.ts) also confirms',
  'owner-sessions.ts:1junk is not a line number',
  'owner-sessions.ts:1 verified but plan-worktrees.ts:bogus is not a citation']) {
  test(`${citation} cannot attest an already-fixed revision`, async () => {
    const state = await fixture();
    try {
      await enabled(state);
      state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
        observed: [citation], inferred: [], unknown: [], disposition: 'already-fixed', fixedBy: state.fixed,
      }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
      const claim = await revalidateFriction(state.runtime, id);
      assert.equal(claim.state, 'done');
      if (claim.state !== 'done') throw new Error('expected completed claim');
      assert.equal(claim.revision?.blockedReason, 'friction_citation_unverified');
      assert.equal((await effectiveTriage(state.runtime, id))?.revision, 0);
    } finally { await state.cleanup(); }
  });
}

test('a source citation to an existing line range at the reference commit is effective', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
      observed: ['owner-sessions.ts:1-2 verified'], inferred: [], unknown: [],
      disposition: 'already-fixed', fixedBy: state.fixed,
    }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    if (claim.state !== 'done') throw new Error('expected completed claim');
    assert.equal(claim.revision?.state, 'revised');
    assert.equal((await effectiveTriage(state.runtime, id))?.revision, 1);
  } finally { await state.cleanup(); }
});

test('a parenthesized citation to an existing line at the reference commit is effective', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
      observed: ['Verified by (owner-sessions.ts:3)'], inferred: [], unknown: [],
      disposition: 'already-fixed', fixedBy: state.fixed,
    }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    if (claim.state !== 'done') throw new Error('expected completed claim');
    assert.equal(claim.revision?.state, 'revised');
    assert.equal((await effectiveTriage(state.runtime, id))?.revision, 1);
  } finally { await state.cleanup(); }
});

test('a bold source citation to an existing line at the reference commit is effective', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
      observed: ['Verified by **owner-sessions.ts:3**'], inferred: [], unknown: [],
      disposition: 'already-fixed', fixedBy: state.fixed,
    }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    if (claim.state !== 'done') throw new Error('expected completed claim');
    assert.equal(claim.revision?.state, 'revised');
    assert.equal((await effectiveTriage(state.runtime, id))?.revision, 1);
  } finally { await state.cleanup(); }
});

for (const [description, citation] of [
  ['italic citation', '_owner-sessions.ts:3_'],
  ['literal underscore-prefixed file', '_x.ts:1'],
] as const) {
  test(`${description} verifies at the reference commit`, async () => {
    const state = await fixture();
    try {
      await enabled(state);
      state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
        observed: [citation], inferred: [], unknown: [], disposition: 'already-fixed', fixedBy: state.fixed,
      }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
      const claim = await revalidateFriction(state.runtime, id);
      assert.equal(claim.state, 'done');
      assert.equal(claim.revision?.state, 'revised');
      assert.equal((await effectiveTriage(state.runtime, id))?.revision, 1);
    } finally { await state.cleanup(); }
  });
}

test('source changes during the hire fail the claim without a revision', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    const calls = scriptedHire(state);
    const hire = state.runtime.hire;
    state.runtime.hire = async (...args) => {
      const response = await hire(...args);
      execFileSync('git', ['-C', state.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        'commit', '--allow-empty', '-m', 'head moved']);
      return response;
    };
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'failed');
    assert.equal(claim.reason, 'friction_triage_source_changed');
    assert.deepEqual(await readRevisions(state.runtime, id), []);
    assert.equal(calls(), 1);
  } finally { await state.cleanup(); }
});

test('unsafe model prose fails closed without persisting its content', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    state.runtime.hire = async (_owner, request) => ({ value: request.schema.parse({
      observed: ['owner-sessions.ts:1 contains a leaked key: ghp_abcdefghijklmnopqrstuvwx'],
      inferred: [], unknown: [], disposition: 'already-fixed', fixedBy: state.fixed,
    }), sessionID: 'fixture', cost: 0, startedAt: at, finishedAt: at });
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    assert.match(claim.revision!.investigation.observed[0]!, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(claim), /ghp_abcdefghijklmnopqrstuvwx/);
    assert.doesNotMatch(await readFile(join(investigationDirectory(state.runtime, id), 'rev-1.json'), 'utf8'),
      /ghp_abcdefghijklmnopqrstuvwx/);
  } finally { await state.cleanup(); }
});

for (const [description, fixedBy, reason] of [
  ['missing fixing commit', 'f'.repeat(40), 'friction_fixed_by_unknown'],
  ['non-ancestor fixing commit', 'side', 'friction_fixed_by_unreachable'],
] as const) {
  test(`${description} blocks the revision and leaves the original effective`, async () => {
    const state = await fixture();
    try {
      await enabled(state);
      let candidate = fixedBy;
      if (candidate === 'side') {
        execFileSync('git', ['-C', state.workspace, 'checkout', '--orphan', 'side'], { stdio: 'ignore' });
        execFileSync('git', ['-C', state.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
          'commit', '--allow-empty', '-m', 'side']);
        candidate = execFileSync('git', ['-C', state.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        execFileSync('git', ['-C', state.workspace, 'checkout', state.second], { stdio: 'ignore' });
      }
      scriptedHire(state, candidate);
      const claim = await revalidateFriction(state.runtime, id);
      assert.equal(claim.state, 'done');
      assert.equal(claim.revision?.state, 'blocked');
      assert.equal(claim.revision?.blockedReason, reason);
      assert.equal((await effectiveTriage(state.runtime, id))?.revision, 0);
    } finally { await state.cleanup(); }
  });
}

test('disabled policy, uninvestigated report, and unchanged or unavailable HEAD cannot start a hire', async () => {
  const state = await fixture();
  try {
    assert.deepEqual(await revalidateFriction(state.runtime, id), { state: 'disabled' });
    await enabled(state);
    await writeFile(state.originalPath, JSON.stringify({ ...state.triage, state: 'blocked' }));
    await assert.rejects(revalidateFriction(state.runtime, id), /friction_revalidation_not_stale/);
    await writeFile(state.originalPath, JSON.stringify(state.triage));
    execFileSync('git', ['-C', state.workspace, 'checkout', state.first], { stdio: 'ignore' });
    await assert.rejects(revalidateFriction(state.runtime, id), /friction_revalidation_not_stale/);
    await rm(state.workspace, { recursive: true, force: true });
    await assert.rejects(revalidateFriction(state.runtime, id), /friction_revalidation_not_stale/);
  } finally { await state.cleanup(); }
});

test('revisions are write-once, sorted, and the latest revised record is effective without changing the original', async () => {
  const state = await fixture();
  try {
    assert.deepEqual(await readRevisions(state.runtime, id), []);
    assert.deepEqual(await effectiveTriage(state.runtime, id), { triage: state.triage, revision: 0 });
    assert.equal(await effectiveTriage(state.runtime, 'fr_aaaaaaaaaaaaaaaaaaaaaaaa'), undefined);
    assert.equal(await frictionFreshness(state.runtime, 'fr_aaaaaaaaaaaaaaaaaaaaaaaa'), undefined);
    const original = await readFile(state.originalPath, 'utf8');
    const revisedInvestigation = { observed: ['src/check.ts includes the correction'], inferred: [], unknown: [],
      disposition: 'already-fixed' as const, fixedBy: state.second };
    const revision = { version: 1 as const, id, revision: 1, previousCommit: state.first,
      sourceCommit: state.second, reason: 'source_stale' as const, state: 'revised' as const, at,
      investigation: revisedInvestigation };
    await writeRevision(state.runtime, { ...revision, revision: 2, state: 'blocked', blockedReason: 'review_needed' });
    await writeRevision(state.runtime, revision);
    const revisionPath = join(investigationDirectory(state.runtime, id), 'rev-1.json');
    const originalRevisionBytes = await readFile(revisionPath);
    await assert.rejects(writeRevision(state.runtime, { ...revision, at: '2026-02-01T00:00:00.000Z' }), { code: 'EEXIST' });
    assert.deepEqual(await readFile(revisionPath), originalRevisionBytes);
    assert.deepEqual((await readRevisions(state.runtime, id)).map(entry => entry.revision), [1, 2]);
    assert.deepEqual(await effectiveTriage(state.runtime, id), {
      triage: { ...state.triage, sourceCommit: state.second, investigation: revisedInvestigation }, revision: 1,
    });
    assert.equal((await frictionFreshness(state.runtime, id))?.stale, false);
    assert.equal(await readFile(state.originalPath, 'utf8'), original);
    assert.equal(investigationDirectory(state.runtime, id), join(state.runtime.stateDirectory, 'friction', 'investigations', id));
  } finally { await state.cleanup(); }
});

test('an unpublished revision temp is ignored and the next explicit revalidation publishes revision one', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    const directory = investigationDirectory(state.runtime, id);
    await mkdir(directory, { recursive: true });
    const leftover = join(directory, 'rev-1.json.interrupted.tmp');
    await writeFile(leftover, '{"version":1');
    assert.deepEqual(await readRevisions(state.runtime, id), []);
    assert.deepEqual(await effectiveTriage(state.runtime, id), { triage: state.triage, revision: 0 });
    scriptedHire(state);
    const claim = await revalidateFriction(state.runtime, id);
    if (claim.state === 'disabled') throw new Error('expected revalidation');
    assert.equal(claim.state, 'done');
    assert.equal(claim.revision?.revision, 1);
    assert.deepEqual((await readRevisions(state.runtime, id)).map(entry => entry.revision), [1]);
    assert.equal((await effectiveTriage(state.runtime, id))?.revision, 1);
    assert.equal(await readFile(leftover, 'utf8'), '{"version":1');
  } finally { await state.cleanup(); }
});

test('invalid revision identity and filename do not silently become effective', async () => {
  const state = await fixture();
  try {
    const directory = investigationDirectory(state.runtime, id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'rev-1.json'), JSON.stringify({ version: 1, id: 'fr_aaaaaaaaaaaaaaaaaaaaaaaa',
      revision: 1, previousCommit: state.first, sourceCommit: state.second, reason: 'source_stale',
      state: 'revised', at, investigation: originalInvestigation }));
    await assert.rejects(readRevisions(state.runtime, id), /friction_revision_identity_mismatch/);
    await assert.rejects(effectiveTriage(state.runtime, id), /friction_revision_identity_mismatch/);
  } finally { await state.cleanup(); }
});

test('already-fixed requires observed evidence and fixedBy, and excludes proposed work', () => {
  const base = { observed: ['src/check.ts includes the correction'], inferred: [], unknown: [], disposition: 'already-fixed' };
  assert.equal(FrictionInvestigation.safeParse(base).success, false);
  assert.equal(FrictionInvestigation.safeParse({ ...base, fixedBy: 'not-a-commit' }).success, false);
  assert.equal(FrictionInvestigation.safeParse({ ...base, fixedBy: 'a'.repeat(40), observed: [] }).success, false);
  assert.equal(FrictionInvestigation.safeParse({ ...base, fixedBy: 'a'.repeat(40),
    proposedWork: originalInvestigation.proposedWork }).success, false);
  assert.equal(FrictionInvestigation.safeParse({ ...originalInvestigation, fixedBy: 'a'.repeat(40) }).success, false);
  assert.equal(FrictionInvestigation.safeParse({ ...base, fixedBy: 'a'.repeat(40) }).success, true);
});


async function failInitial(state: Awaited<ReturnType<typeof fixture>>) {
  await enabled(state);
  state.runtime.hire = async () => { throw new Error('failure may have occurred after inference'); };
  const failed = await revalidateFriction(state.runtime, id);
  if (failed.state !== 'failed' || !failed.token) throw new Error('expected failed claim');
  const path = join(investigationDirectory(state.runtime, id), `claim-${state.second}.json`);
  return { failed, path, bytes: await readFile(path, 'utf8'),
    approval: { referenceCommit: state.second, failedToken: failed.token, authorizedBy: 'fixture-person' } };
}

test('explicit retry preserves original bytes and allows one additional hire with idempotent completion', async () => {
  const state = await fixture();
  try {
    const initial = await failInitial(state);
    const original = await readFile(state.originalPath, 'utf8');
    const calls = scriptedHire(state);
    const retried = await retryFrictionRevalidation(state.runtime, id, initial.approval);
    assert.equal(retried.state, 'done');
    if (retried.state !== 'done') throw new Error('expected completed retry');
    assert.equal(retried.retry?.failedToken, initial.failed.token);
    assert.equal(retried.retry?.authorizedBy, 'fixture-person');
    assert.equal(retried.retry?.referenceCommit, state.second);
    assert.equal(retried.retry?.at, retried.at);
    assert.deepEqual(JSON.parse(await readFile(initial.path, 'utf8')).retry,
      { ...initial.approval, at: retried.at });
    assert.notEqual(retried.token, initial.failed.token);
    assert.equal(retried.revision?.investigation.disposition, 'already-fixed');
    assert.equal(await readFile(initial.path + '.failed-attempt.json', 'utf8'), initial.bytes);
    assert.equal(await readFile(state.originalPath, 'utf8'), original);
    assert.deepEqual(await retryFrictionRevalidation(state.runtime, id, initial.approval), retried);
    assert.deepEqual(await revalidateFriction(state.runtime, id), retried);
    assert.equal(calls(), 1);
    assert.equal((await readRevisions(state.runtime, id)).length, 1);
    assert.deepEqual(await state.runtime.requests.list(), []);
  } finally { await state.cleanup(); }
});

test('failed explicit retry cannot replenish its budget with either token', async () => {
  const state = await fixture();
  try {
    const initial = await failInitial(state);
    let calls = 0;
    state.runtime.hire = async () => { calls++; throw new Error('Bearer SECRET'); };
    const retried = await retryFrictionRevalidation(state.runtime, id, initial.approval);
    assert.equal(retried.state, 'failed');
    if (retried.state !== 'failed') throw new Error('expected failed retry');
    assert.deepEqual(await retryFrictionRevalidation(state.runtime, id, initial.approval), retried);
    await assert.rejects(retryFrictionRevalidation(state.runtime, id,
      { ...initial.approval, failedToken: retried.token! }), /retry_not_eligible/);
    assert.deepEqual(await revalidateFriction(state.runtime, id), retried);
    assert.doesNotMatch(await readFile(initial.path, 'utf8'), /SECRET/);
    assert.equal(calls, 1);
    assert.deepEqual(await readRevisions(state.runtime, id), []);
  } finally { await state.cleanup(); }
});

test('concurrent human retries acquire one replacement and never dispatch twice', async () => {
  const state = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const initial = await failInitial(state);
    const calls = scriptedHire(state);
    const hire = state.runtime.hire;
    state.runtime.hire = async (...args) => { entered(); await pending; return hire(...args); };
    const attempts = [retryFrictionRevalidation(state.runtime, id, initial.approval),
      retryFrictionRevalidation(state.runtime, id, initial.approval)];
    await started;
    assert.equal((await retryFrictionRevalidation(state.runtime, id, initial.approval)).state, 'running');
    assert.equal((await revalidateFriction(state.runtime, id)).state, 'running');
    release();
    assert.ok((await Promise.all(attempts)).some(claim => claim.state === 'done'));
    assert.equal(calls(), 1);
    assert.equal((await readRevisions(state.runtime, id)).length, 1);
    assert.equal(await readFile(initial.path + '.failed-attempt.json', 'utf8'), initial.bytes);
  } finally { release(); await state.cleanup(); }
});

test('interruption after archival resumes only an identical failed attempt', async () => {
  const state = await fixture();
  try {
    const initial = await failInitial(state);
    await writeFile(initial.path + '.failed-attempt.json', initial.bytes);
    const calls = scriptedHire(state);
    assert.equal((await retryFrictionRevalidation(state.runtime, id, initial.approval)).state, 'done');
    assert.equal(calls(), 1);
    assert.equal(await readFile(initial.path + '.failed-attempt.json', 'utf8'), initial.bytes);
  } finally { await state.cleanup(); }
});

test('conflicting archive blocks retry without replacing failed claim or hiring', async () => {
  const state = await fixture();
  try {
    const initial = await failInitial(state);
    await writeFile(initial.path + '.failed-attempt.json', '{}');
    const calls = scriptedHire(state);
    await assert.rejects(retryFrictionRevalidation(state.runtime, id, initial.approval), /retry_history_conflict/);
    assert.equal(await readFile(initial.path, 'utf8'), initial.bytes);
    assert.equal(await readFile(initial.path + '.failed-attempt.json', 'utf8'), '{}');
    assert.equal(calls(), 0);
  } finally { await state.cleanup(); }
});

for (const condition of ['running', 'dead', 'uncertain', 'malformed', 'wrong-token', 'wrong-commit', 'revision']) {
  test(`${condition} refuses a human retry without hiring or losing history`, async () => {
    const state = await fixture();
    try {
      const initial = await failInitial(state);
      const claims: Record<string, unknown> = {
        running: { ...initial.failed, state: 'running', runner: process.pid },
        dead: { ...initial.failed, state: 'running', runner: 2147483647 },
        uncertain: { ...initial.failed, state: 'uncertain' },
      };
      if (condition in claims) await writeFile(initial.path, JSON.stringify(claims[condition]));
      if (condition === 'malformed') await writeFile(initial.path, '{');
      if (condition === 'revision') await writeRevision(state.runtime, { version: 1, id, revision: 1,
        previousCommit: state.first, sourceCommit: state.second, reason: 'source_stale',
        state: 'blocked', at, investigation: originalInvestigation });
      const calls = scriptedHire(state);
      await assert.rejects(retryFrictionRevalidation(state.runtime, id, { ...initial.approval,
        ...(condition === 'wrong-token' ? { failedToken: 'other-attempt' } : {}),
        ...(condition === 'wrong-commit' ? { referenceCommit: state.first } : {}),
      }), /friction_revalidation_/);
      assert.equal(calls(), 0);
      assert.equal((await readdir(investigationDirectory(state.runtime, id))).includes(
        `claim-${state.second}.json.failed-attempt.json`), false);
    } finally { await state.cleanup(); }
  });
}

test('dead retry remains uncertain and cannot start a third attempt', async () => {
  const state = await fixture();
  try {
    const initial = await failInitial(state);
    await writeFile(initial.path + '.failed-attempt.json', initial.bytes);
    await writeFile(initial.path, JSON.stringify({ state: 'running', runner: 2147483647, token: 'retry-token', at,
      retry: { ...initial.approval, at } }));
    const calls = scriptedHire(state);
    assert.equal((await retryFrictionRevalidation(state.runtime, id, initial.approval)).state, 'uncertain');
    assert.equal((await retryFrictionRevalidation(state.runtime, id, initial.approval)).state, 'uncertain');
    assert.equal(calls(), 0);
    assert.equal(await readFile(initial.path + '.failed-attempt.json', 'utf8'), initial.bytes);
  } finally { await state.cleanup(); }
});

test('missing executable preflight consumes neither initial claim nor human retry', async () => {
  const state = await fixture();
  try {
    await enabled(state);
    const executable = join(state.root, 'bin');
    await mkdir(executable);
    state.runtime.preflightHire = directory => preflightHireExecutable(directory, executable);
    const calls = scriptedHire(state);
    await assert.rejects(revalidateFriction(state.runtime, id), /hire_executable_unavailable/);
    assert.equal(calls(), 0);
    const claimPath = join(investigationDirectory(state.runtime, id), `claim-${state.second}.json`);
    await assert.rejects(readFile(claimPath), { code: 'ENOENT' });
    // Executable resolution is a filesystem-only check: this script must never run.
    const binary = join(executable, 'opencode');
    await writeFile(binary, '#!/bin/sh\nexit 77\n');
    await chmod(binary, 0o755);
    const initial = await failInitial(state);
    await rm(binary);
    await assert.rejects(retryFrictionRevalidation(state.runtime, id, initial.approval), /hire_executable_unavailable/);
    assert.equal(await readFile(initial.path, 'utf8'), initial.bytes);
    await assert.rejects(readFile(initial.path + '.failed-attempt.json'), { code: 'ENOENT' });
    await writeFile(binary, '#!/bin/sh\nexit 77\n');
    await chmod(binary, 0o755);
    const retries = scriptedHire(state);
    assert.equal((await retryFrictionRevalidation(state.runtime, id, initial.approval)).state, 'done');
    assert.equal(retries(), 1);
  } finally { await state.cleanup(); }
});

test('executable preflight rejects nonexecutable files and directories and resolves relative PATH at hire directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hire-executable-'));
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin', 'opencode'), 'not executable');
    await assert.rejects(preflightHireExecutable(root, 'bin'), /hire_executable_unavailable/);
    await rm(join(root, 'bin', 'opencode'));
    await mkdir(join(root, 'bin', 'opencode'));
    await assert.rejects(preflightHireExecutable(root, 'bin'), /hire_executable_unavailable/);
    await rm(join(root, 'bin', 'opencode'), { recursive: true });
    await writeFile(join(root, 'bin', 'opencode'), '#!/bin/sh\nexit 77\n');
    await chmod(join(root, 'bin', 'opencode'), 0o755);
    await preflightHireExecutable(root, 'bin');
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function localWorktreeRepository(state: Awaited<ReturnType<typeof fixture>>) {
  const remote = join(state.root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['-C', state.workspace, 'branch', '-M', 'main']);
  execFileSync('git', ['-C', state.workspace, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', state.workspace, 'push', '--quiet', 'origin', 'main']);
  const owner = state.runtime.declarations.owners.get('clippy')!;
  assert.equal(owner.domain.kind, 'git-repository');
  state.runtime.declarations.owners.set('clippy', { ...owner,
    domain: { kind: 'git-repository', name: 'example/clippy', remote, baseBranch: 'main', verify: [] } });
  await state.runtime.notebook('clippy').ensure('# Test charter\n');
}

async function isolatedPlanSessions(state: Awaited<ReturnType<typeof fixture>>) {
  const directories: string[] = [];
  const client: OwnerSessionClient = {
    create: async directory => { directories.push(directory); return `ses_plan_${directories.length}`; },
    prompt: async () => {}, remove: async () => {},
    activity: async () => ({ isBusy: false, updatedAt: Date.now() }),
  };
  for (const title of ['First independent plan', 'Second independent plan']) {
    const item = await state.runtime.ledger.create('clippy', 'owner-change', {
      title, goal: title, rationale: 'Exercise worktree isolation', size: 'small', acceptance: ['Isolated changes'],
    }, { status: 'awaiting-plan-approval', planDocument: { markdown: title, digest: title } });
    await approvePlan(state.runtime, item.id, 'Fixture person');
    await openOwnerSession(state.runtime, client, item.id);
  }
  return directories;
}

async function isolationCitations(state: Awaited<ReturnType<typeof fixture>>) {
  const evidence = [
    ['owner-sessions.ts', "const worktree = await sessionOpeningPhase(context, 'plan-place', () => ensurePlanWorktree(runtime, item, context));"],
    ['plan-worktrees.ts', "return join(runtime.plansRoot, item.owner, item.id);"],
    ['desk-changes.ts', 'const planWorktree = item && !isRepair(item) ? item.planWorktree : undefined;'],
    ['work-lifecycle.test.ts', "test('proposing one plan publishes only its worktree; the other plan and the desk propose on their own'"],
  ];
  return Promise.all(evidence.map(async ([file, text]) => {
    const lines = (await readFile(join(state.workspace, file!), 'utf8')).split('\n');
    const line = lines.findIndex(candidate => candidate.includes(text!));
    assert.ok(line >= 0, `representative source contains ${text}`);
    return `${file}:${line + 1} ${lines[line]!.trim()}`;
  }));
}

test('representative per-plan worktree fix revalidates as already-fixed without serialization dispatch', async () => {
  const state = await fixture(true);
  try {
    await enabled(state);
    await localWorktreeRepository(state);
    const desk = await ensureDesk(state.runtime.repositoryOwner('clippy'), state.runtime.desksRoot);
    const [first, second] = await isolatedPlanSessions(state);
    assert.ok(first && second);
    assert.notEqual(first, second);
    await writeFile(join(first, 'first-plan.txt'), 'independent first change\n');
    await writeFile(join(second, 'second-plan.txt'), 'independent second change\n');
    await assert.rejects(readFile(join(first, 'second-plan.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(second, 'first-plan.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(desk.path, 'first-plan.txt')), { code: 'ENOENT' });
    assert.equal(execFileSync('git', ['-C', desk.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
    const original = await readFile(state.originalPath, 'utf8');
    const observed = await isolationCitations(state);
    let hires = 0;
    state.runtime.hire = async (_owner, request) => {
      hires++;
      assert.match(request.brief, /Serialize per-owner plan execution/);
      assert.ok(request.brief.includes(state.first) && request.brief.includes(state.second));
      assert.equal(request.extraPermission?.bash, 'deny');
      const lock = join(investigationDirectory(state.runtime, id), 'revisions.lock');
      assert.equal(spawnSync('flock', ['--nonblock', lock, 'true']).status, 0, 'model execution holds no report lock');
      return { value: request.schema.parse({ disposition: 'already-fixed', fixedBy: state.fixed, observed,
        inferred: [], unknown: [] }), sessionID: 'representative-isolation', cost: 0, startedAt: at, finishedAt: at };
    };
    const claim = await revalidateFriction(state.runtime, id);
    assert.equal(claim.state, 'done');
    assert.equal(claim.revision?.state, 'revised');
    assert.equal(claim.revision?.investigation.disposition, 'already-fixed');
    assert.equal(claim.revision?.investigation.fixedBy, state.fixed);
    assert.deepEqual(claim.revision?.investigation.observed, observed);
    assert.equal(claim.revision?.previousCommit, state.first);
    assert.equal(claim.revision?.sourceCommit, state.second);
    assert.equal(await effectiveProposalDigest(state.runtime, id), undefined);
    await assert.rejects(promoteFriction(state.runtime, id, frictionProposalDigest(state.triage)!, 'Fixture person'),
      /friction_proposal_unavailable/);
    await recoverFrictionPromotions(state.runtime, (_id, error) => { throw error; });
    assert.equal((await state.runtime.requests.list()).length, 0);
    assert.equal((await state.runtime.ledger.list()).length, 2, 'only the two fixture plans exist');
    assert.equal(await readFile(state.originalPath, 'utf8'), original);
    assert.deepEqual(await revalidateFriction(state.runtime, id), claim);
    assert.equal(hires, 1);
    assert.equal((await readRevisions(state.runtime, id)).length, 1);
    assert.equal(await readFile(join(first, 'first-plan.txt'), 'utf8'), 'independent first change\n');
    assert.equal(await readFile(join(second, 'second-plan.txt'), 'utf8'), 'independent second change\n');
  } finally { await state.cleanup(); }
});
