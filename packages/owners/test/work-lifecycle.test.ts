import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime, advance, approvePlan, cancelItem, publish, resumeItem, retryItem } from '@onionsoup/owners';
import { git, refreshCheckout, ensureDesk, createWorktree } from '../src/workspace.ts';
import { maintainPullRequests } from '../src/rebase.ts';
import { proposeDeskChanges } from '../src/desk-changes.ts';
import type { HireRequest } from '../src/opencode.ts';

const proposal = { title: 'Repair flow', goal: 'Complete the change', rationale: 'Regression', acceptance: ['It completes'], size: 'small' as const };
const plan = { summary: 'Fix it', steps: [{ description: 'Implement', files: ['change'] }], tests: ['verify'], risks: [], outOfScope: [], questionsForOwner: [] };
const report = { summary: 'Implemented', filesChanged: ['change'], deviationsFromPlan: [] };
const verdict = { decision: 'approve', summary: 'Correct', findings: [] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-lifecycle-'));
  const remote = join(root, 'origin');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  const seed = join(root, 'seed');
  await git(root, ['clone', '-q', remote, seed]);
  await git(seed, ['config', 'user.name', 'Fixture']);
  await git(seed, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(seed, 'base'), 'base\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'Base']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  const owner = runtime.declarations.owners.get('clippy')!;
  assert.equal(owner.domain.kind, 'git-repository');
  runtime.declarations.owners.set('clippy', {
    ...owner, workspace: join(root, 'checkout'),
    domain: { kind: 'git-repository', name: 'example/clippy', remote, baseBranch: 'main', verify: [] },
  });
  await refreshCheckout(runtime.repositoryOwner('clippy'));
  await git(runtime.owner('clippy').workspace, ['config', 'user.name', 'Fixture']);
  await git(runtime.owner('clippy').workspace, ['config', 'user.email', 'fixture@example.invalid']);
  await runtime.notebook('clippy').ensure('# Charter\n');
  return { runtime, root, remote, seed };
}

function scriptHires(runtime: Runtime, answer: (request: HireRequest<unknown>) => Promise<unknown>) {
  runtime.hire = async (_owner, request) => ({
    value: request.schema.parse(await answer(request)), sessionID: `test-${request.title}`,
    cost: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  });
}

async function fakeGithub(root: string, remote: string, operation: () => Promise<void>) {
  const bin = join(root, 'bin');
  const state = join(root, 'github.json');
  await mkdir(bin);
  await writeFile(state, JSON.stringify({ created: 0, failCreate: false, state: 'OPEN' }));
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const path = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(path));
const remote = ${JSON.stringify(remote)};
const url = 'https://github.com/example/clippy/pull/1';
const handlers = {
  view() { const branch = state.branch || 'original'; const headRefOid = cp.execFileSync('git', ['-C', remote, 'rev-parse', branch]).toString().trim(); console.log(JSON.stringify({ url, state: state.state, mergeable: state.mergeable || 'MERGEABLE', headRefOid })); },
  checks() { console.log(JSON.stringify(state.failing === false ? [] : [{ name: 'test', bucket: 'fail', link: '' }])); },
  list() { console.log(JSON.stringify(state.created ? [{ url, state: state.state }] : [])); },
  create() { if (state.failCreate) { state.failCreate = false; fs.writeFileSync(path, JSON.stringify(state)); process.exit(1); } state.created++; state.branch = args[args.indexOf('--head') + 1]; console.log(url); },
  merge() { state.state = 'MERGED'; },
};
handlers[args[1]]();
fs.writeFileSync(path, JSON.stringify(state));
`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    await operation();
  } finally {
    process.env.PATH = previous;
  }
}

test('learnings preserve a publication recorded while the hire is running', async () => {
  const { runtime, root, remote } = await fixture();
  const head = (await git(runtime.owner('clippy').workspace, ['rev-parse', 'HEAD'])).trim();
  const item = await runtime.ledger.create('clippy', 'change', proposal, { status: 'landed', branch: 'main', landedCommit: head });
  scriptHires(runtime, async () => {
    await publish(runtime, item.id, 'person');
    return { notebook: [] };
  });
  await fakeGithub(root, remote, async () => {
    await advance(runtime, item.id);
    const persisted = await runtime.ledger.get(item.id);
    assert.equal(persisted.publication?.url, 'https://github.com/example/clippy/pull/1');
    assert.equal(persisted.hires.at(-1)?.stage, 'learn');
  });
});

test('replanned verification retries retain the first attempt and obey maxRevisions', async () => {
  const { runtime } = await fixture();
  const declaration = runtime.declarations.owners.get('clippy')!;
  assert.equal(declaration.domain.kind, 'git-repository');
  if (declaration.domain.kind !== 'git-repository') throw new Error('fixture_repository');
  declaration.domain.verify = [['sh', '-c', 'test -f ready']];
  runtime.declarations.workflows.get('change')!.review.maxRevisions = 1;
  const item = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' }, resetForPlan: true,
    verdicts: [{ decision: 'replan', summary: 'Start again', findings: [] }],
  });
  const worktree = await createWorktree(runtime.repositoryOwner('clippy'), runtime.worktreesRoot, item.id);
  await writeFile(join(worktree.path, 'old-attempt'), 'discard');
  let attempts = 0;
  scriptHires(runtime, async request => {
    if (request.role === 'implementer') {
      attempts++;
      await assert.rejects(readFile(join(request.directory, 'old-attempt')));
      if (attempts === 2) assert.equal(await readFile(join(request.directory, 'change'), 'utf8'), 'first attempt');
      await writeFile(join(request.directory, 'change'), 'first attempt');
      if (attempts === 2) await writeFile(join(request.directory, 'ready'), 'ready');
      return report;
    }
    return request.role === 'reviewer' ? verdict : { notebook: [] };
  });
  await advance(runtime, item.id);
  const persisted = await runtime.ledger.get(item.id);
  assert.equal(persisted.status, 'landed', persisted.reason);
  assert.equal(attempts, 2);
  assert.equal(persisted.resetForPlan, false);

  const failing = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' },
  });
  attempts = 0;
  scriptHires(runtime, async request => {
    if (request.role !== 'implementer') return { notebook: [] };
    attempts++;
    await writeFile(join(request.directory, 'change'), `attempt ${attempts}`);
    return report;
  });
  await advance(runtime, failing.id);
  assert.equal((await runtime.ledger.get(failing.id)).reason, 'verification_failed_after_revisions');
  assert.equal(attempts, 2, 'one initial implementation plus one revision');
});

test('CI repair plans from the failed head and updates the original PR branch', async () => {
  const { runtime, root, remote, seed } = await fixture();
  await git(seed, ['checkout', '-qb', 'original']);
  await writeFile(join(seed, 'feature'), 'original feature');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'Feature']);
  await git(seed, ['push', '-q', 'origin', 'original']);
  const head = (await git(seed, ['rev-parse', 'HEAD'])).trim();
  const source = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'landed', branch: 'original', landedCommit: head,
    publication: { url: 'https://github.com/example/clippy/pull/1', branch: 'original', by: 'person', at: '', state: 'open' },
  });
  scriptHires(runtime, async request => {
    if (request.title.includes('CI triage')) return { decision: 'fix', reason: 'Bug in feature', fix: proposal };
    if (request.role === 'planner') {
      assert.equal(await readFile(join(request.directory, 'feature'), 'utf8'), 'original feature');
      return plan;
    }
    if (request.role === 'implementer') {
      assert.equal(await readFile(join(request.directory, 'feature'), 'utf8'), 'original feature');
      await writeFile(join(request.directory, 'repair'), 'fix');
      return report;
    }
    return request.role === 'reviewer' ? verdict : { notebook: [] };
  });
  await fakeGithub(root, remote, async () => {
    const maintained = await maintainPullRequests(runtime, 'clippy');
    const repair = maintained.opened[0]!;
    assert.equal(repair.repairOf?.previousHead, head);
    await advance(runtime, repair.id);
    await approvePlan(runtime, repair.id, 'person');
    await advance(runtime, repair.id);
    const published = await publish(runtime, repair.id, 'person');
    assert.equal(published.publication?.url, source.publication!.url);
    assert.equal((await git(remote, ['rev-parse', 'original'])).trim(), published.landedCommit);
    assert.equal((await runtime.ledger.get(source.id)).landedCommit, published.landedCommit);
    assert.equal((await git(remote, ['show', 'original:feature'])).trim(), 'original feature');
    assert.equal((await git(remote, ['show', 'original:repair'])).trim(), 'fix');
    assert.equal(JSON.parse(await readFile(join(root, 'github.json'), 'utf8')).created, 0);
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, failing: false, state: 'OPEN', mergeable: 'CONFLICTING' }));
    const maintenance = await maintainPullRequests(runtime, 'clippy');
    assert.equal(maintenance.opened.length, 1, 'source and repair publications produce only one maintenance item');
    const rebased = maintenance.opened[0]!;
    assert.equal(rebased.rebaseOf?.itemId, source.id);
    const replayed = await advance(runtime, rebased.id);
    assert.equal(replayed.status, 'awaiting-push-approval', replayed.reason);
    assert.equal(await readFile(join(replayed.worktree!, 'feature'), 'utf8'), 'original feature');
    assert.equal(await readFile(join(replayed.worktree!, 'repair'), 'utf8'), 'fix');
    await cancelItem(runtime, rebased.id, 'person', 'Keep this head');
    assert.equal((await maintainPullRequests(runtime, 'clippy')).opened.length, 0, 'cancelled rebases stay cancelled for this head');
  });
});

test('a clean desk retries publication after commit and enrolls its PR in the ledger', async () => {
  const { runtime, root, remote } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'desk change');
  scriptHires(runtime, async () => verdict);
  await fakeGithub(root, remote, async () => {
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, failCreate: true, state: 'OPEN' }));
    assert.equal((await proposeDeskChanges(runtime, 'clippy', 'Desk change', 'Update the desk')).outcome, 'needs-work');
    const [failed] = await runtime.ledger.list();
    assert.equal(failed?.deskPublication?.stage, 'open');
    assert.equal((await git(desk.path, ['status', '--porcelain'])).trim(), '');
    assert.equal((await proposeDeskChanges(runtime, 'clippy', 'Retry', 'Retry')).outcome, 'opened');
    const [published] = await runtime.ledger.list();
    assert.equal(published?.id, failed?.id);
    assert.equal(published?.publication?.state, 'open');
    assert.equal(published?.deskPublication?.stage, 'complete');
    assert.equal(published?.landedCommit, failed?.landedCommit);
    assert.equal(JSON.parse(await readFile(join(root, 'github.json'), 'utf8')).created, 1);
    // Simulate a crash after GitHub created the PR but before the ledger checkpoint reached disk.
    await runtime.ledger.update(published!.id, current => ({
      ...current, status: 'failed', publication: undefined, deskPublication: { ...current.deskPublication!, stage: 'open' },
    }));
    assert.equal((await proposeDeskChanges(runtime, 'clippy', 'Retry', 'Retry')).outcome, 'opened');
    assert.equal(JSON.parse(await readFile(join(root, 'github.json'), 'utf8')).created, 1);
  });
});

test('recovery preserves the failed stage, journals the person, and cancellation cannot race a running effect', async () => {
  const { runtime } = await fixture();
  const item = await runtime.ledger.create('clippy', 'change', proposal, { status: 'reviewing', activeRunner: 424242 });
  await assert.rejects(cancelItem(runtime, item.id, 'person', 'Stop'), /work_item_active/);
  await runtime.ledger.markInterrupted();
  assert.equal((await resumeItem(runtime, item.id, 'person')).status, 'reviewing');
  await runtime.ledger.update(item.id, current => ({ ...current, status: 'failed', resumeStatus: 'landing' }));
  assert.equal((await retryItem(runtime, item.id, 'person')).status, 'landing');
  await cancelItem(runtime, item.id, 'person', 'No longer needed');
  const persisted = await runtime.ledger.get(item.id);
  assert.equal(persisted.status, 'cancelled');
  assert.deepEqual(persisted.humanNotes.map(note => note.kind), ['resume', 'retry', 'cancellation']);
  await assert.rejects(retryItem(runtime, item.id, 'person'), /not_failed/);
});

test('concurrent field updates serialize across independent ledger instances', async () => {
  const { runtime } = await fixture();
  const { Ledger } = await import('@onionsoup/owners');
  const other = new Ledger(runtime.ledger.directory);
  const item = await runtime.ledger.create('clippy', 'change', proposal);
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? other : runtime.ledger)
    .update(item.id, current => ({ ...current, replans: current.replans + 1 }))));
  assert.equal((await runtime.ledger.get(item.id)).replans, 12);
});

test('record locks release after a callback error and a stopped process', async () => {
  const { spawn } = await import('node:child_process');
  const { withRecordLock } = await import('../src/record-lock.ts');
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-record-lock-'));
  const lock = join(root, 'test.lock');
  await assert.rejects(withRecordLock(lock, async () => { throw new Error('callback_failed'); }), /callback_failed/);
  await withRecordLock(lock, async () => writeFile(join(root, 'first'), 'released'));
  const module = new URL('../src/record-lock.ts', import.meta.url).href;
  const script = `import { withRecordLock } from ${JSON.stringify(module)};
    await withRecordLock(${JSON.stringify(lock)}, async () => {
      process.stdout.write('ready');
      await new Promise(() => {});
    });`;
  const holder = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.once('data', () => resolve());
    holder.once('exit', () => reject(new Error('holder_exited_before_lock')));
  });
  holder.kill('SIGKILL');
  await withRecordLock(lock, async () => writeFile(join(root, 'second'), 'released'));
  assert.equal(await readFile(join(root, 'second'), 'utf8'), 'released');
});

test('record lock spawn failure rejects without running the mutation', async () => {
  const { withRecordLock } = await import('../src/record-lock.ts');
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-lock-missing-'));
  const previous = process.env.PATH;
  process.env.PATH = '';
  let ran = false;
  try {
    await assert.rejects(withRecordLock(join(root, 'test.lock'), async () => { ran = true; }), /ENOENT/);
  } finally {
    process.env.PATH = previous;
  }
  assert.equal(ran, false);
});
