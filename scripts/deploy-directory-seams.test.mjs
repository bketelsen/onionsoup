import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { rememberSession } from '../packages/owners/src/session-history.ts';
import { armDeployment, beginAdmission } from '../packages/owners/src/deployment-admission.ts';
import { createAdmission } from './deploy-admission.mjs';

const proposal = { title: 'Deployment scope', goal: 'Do not initialize history', rationale: 'Regression', acceptance: ['Safe drain'], size: 'small' };
const build = 'a'.repeat(40);
const openPublication = {
  url: 'https://github.com/example/clippy/pull/1', branch: 'fixture',
  by: 'fixture', at: '2026-10-01T00:00:00Z', state: 'open',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deploy-directories-'));
  const state = join(root, 'state');
  const config = resolve('packages/owners/test/fixtures/owners');
  const runtime = await Runtime.open({ state, declarations: config });
  const probes = [];
  const status = new Map();
  await armDeployment(state, build);
  const admission = await createAdmission({ state, config, admissionEffects: {
    endpoint: async () => ({ opencodePid: process.pid }), processes: async () => false,
    request: async (_endpoint, path, directory) => {
      probes.push({ path, directory });
      return path === '/session/status' ? status.get(directory) ?? {} : [];
    },
  } });
  return { root, state, runtime, probes, status, admission };
}

test('old terminal session.directory is history, never an OpenCode directory initialization', async () => {
  const { root, runtime, probes, admission } = await fixture();
  const deleted = join(root, 'deleted-terminal');
  await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'cancelled', session: { sessionID: 'ses_terminal', directory: deleted },
  });
  await admission.drain(build);
  assert.equal(await admission.quiescent(), true);
  assert.ok(!probes.some(probe => probe.directory === deleted));
});

for (const scope of [
  { name: 'missing', exists: false, archived: false },
  { name: 'archived-missing', exists: false, archived: true },
  { name: 'archived-reused', exists: true, archived: true },
]) {
  test(`a landed open PR's ${scope.name} execution is history, while an actual lease still blocks drain`, async () => {
    const { root, state, runtime, probes, admission } = await fixture();
    const historical = join(root, scope.name);
    if (scope.exists) await mkdir(historical);
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'landed', publication: openPublication,
      session: { sessionID: 'ses_open_pr_history', directory: historical },
    });
    if (scope.archived) await rememberSession(runtime, {
      id: item.session.sessionID, owner: item.owner, directory: historical, archived: true, item: item.id,
      title: 'Historical PR execution', time: { created: 1, updated: 2 },
    });
    const lease = await beginAdmission(state, 'chat');
    try {
      await admission.drain(build);
      assert.equal(await admission.quiescent(), false);
      assert.equal(probes.length, 0);
    } finally {
      await lease.release();
    }
    assert.equal(await admission.quiescent(), true, 'the open PR alone is not actual active execution');
    assert.ok(!probes.some(probe => probe.directory === historical));
  });
}

test('archived metadata excludes even an existing reused terminal workspace from probes', async () => {
  const { root, runtime, probes, admission } = await fixture();
  const retired = join(root, 'retired');
  await mkdir(retired);
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'landed', planWorktree: retired, session: { sessionID: 'ses_archived', directory: retired },
  });
  await rememberSession(runtime, {
    id: 'ses_archived', owner: 'clippy', directory: retired, archived: true, item: item.id,
    title: 'Archived', time: { created: 1, updated: 2 },
  });
  await admission.drain(build);
  assert.equal(await admission.quiescent(), true);
  assert.ok(!probes.some(probe => probe.directory === retired));
});

for (const fields of [{ status: 'working' }, { status: 'cancelled', activeRunner: process.pid }]) {
  test(`missing ${fields.status} active work scope blocks drain before directory transport`, async () => {
    const { root, runtime, probes, admission } = await fixture();
    const missing = join(root, 'missing-active');
    await runtime.ledger.create('clippy', 'owner-change', proposal, {
      ...fields, planWorktree: missing, session: { sessionID: 'ses_active', directory: missing },
    });
    await admission.drain(build);
    assert.equal(await admission.quiescent(), false);
    assert.equal(probes.length, 0);
  });
}

test('a lease blocks drain even when its terminal work directory has disappeared', async () => {
  const { root, state, runtime, probes, admission } = await fixture();
  const lease = await beginAdmission(state, 'chat');
  try {
    await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'landed', session: { sessionID: 'ses_terminal', directory: join(root, 'gone') },
    });
    await admission.drain(build);
    assert.equal(await admission.quiescent(), false);
    assert.equal(probes.length, 0);
  } finally {
    await lease.release();
  }
});

test('retained terminal rollout busy/retry activity blocks drain, not just ledger work status', async () => {
  const { root, runtime, probes, status, admission } = await fixture();
  const rollout = join(root, 'retained-rollout');
  await mkdir(rollout);
  await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'landed', publication: openPublication, planWorktree: rollout,
    session: { sessionID: 'ses_rollout', directory: rollout },
  });
  status.set(rollout, { ses_child: { type: 'retry' } });
  await admission.drain(build);
  assert.equal(await admission.quiescent(), false);
  assert.ok(probes.some(probe => probe.directory === rollout));
  status.delete(rollout);
  assert.equal(await admission.quiescent(), true);
});

test('nonterminal explicit sessions with an existing scope are still checked without a plan worktree', async () => {
  const { root, runtime, status, admission } = await fixture();
  const active = join(root, 'active');
  await mkdir(active);
  await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'planning', session: { sessionID: 'ses_planning', directory: active },
  });
  status.set(active, { ses_planning: { type: 'busy' } });
  await admission.drain(build);
  assert.equal(await admission.quiescent(), false);
});
