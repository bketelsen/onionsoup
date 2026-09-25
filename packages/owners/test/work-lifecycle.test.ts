import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime, advance, approvePlan, cancelItem, landOverFindings, publish, resumeItem, retryItem } from '@onionsoup/owners';
import { git, refreshCheckout, ensureDesk, createWorktree } from '../src/workspace.ts';
import { REBASE_WORKFLOW, maintainPullRequests } from '../src/rebase.ts';
import { DESK_CHANGE_LIMITS, proposeDeskChanges, resetDeskReviews } from '../src/desk-changes.ts';
import { deskReviewRounds } from '../src/desk-reviews.ts';
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

/** What the fake gh recorded: PRs created, the body of the last one, and how often a PR's state alone was read. */
async function githubState(root: string) {
  return JSON.parse(await readFile(join(root, 'github.json'), 'utf8')) as { created: number; body?: string; state: string; stateViews?: number };
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
  view() {
    if (args[args.indexOf('--json') + 1] === 'state') { state.stateViews = (state.stateViews || 0) + 1; console.log(JSON.stringify({ state: state.state })); return; }
    const branch = state.branch || 'original'; const headRefOid = cp.execFileSync('git', ['-C', remote, 'rev-parse', branch]).toString().trim(); console.log(JSON.stringify({ url, state: state.state, mergeable: state.mergeable || 'MERGEABLE', headRefOid })); },
  checks() { console.log(JSON.stringify(state.failing === false ? [] : [{ name: 'test', bucket: 'fail', link: '' }])); },
  list() { console.log(JSON.stringify(state.created ? [{ url, state: state.state }] : [])); },
  create() { if (state.failCreate) { state.failCreate = false; fs.writeFileSync(path, JSON.stringify(state)); process.exit(1); } state.created++; state.branch = args[args.indexOf('--head') + 1]; state.body = args[args.indexOf('--body') + 1]; console.log(url); },
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
  scriptHires(runtime, async request => {
    assert.match(request.brief, /read as the project's own record/);
    assert.match(request.brief, /flag violations as review findings/);
    assert.match(request.brief, /Repository-specific templates, conventions and review rubrics take precedence/);
    return verdict;
  });
  await fakeGithub(root, remote, async () => {
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, failCreate: true, state: 'OPEN' }));
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update the desk' })).outcome, 'publication-failed');
    const [failed] = await runtime.ledger.list();
    assert.equal(failed?.deskPublication?.stage, 'open');
    assert.equal((await git(desk.path, ['status', '--porcelain'])).trim(), '');
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Retry', summary: 'Retry' })).outcome, 'opened');
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
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Retry', summary: 'Retry' })).outcome, 'opened');
    assert.equal(JSON.parse(await readFile(join(root, 'github.json'), 'utf8')).created, 1);
  });
});

test('proposing desk changes for an approved plan publishes that plan item, and only while it is being worked on', async () => {
  const { runtime, root, remote } = await fixture();
  const planned = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'awaiting-plan-approval', planDocument: { markdown: '1. Write the change file', digest: 'd1' },
  });
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'planned change');
  scriptHires(runtime, async () => ({ decision: 'approve', summary: 'Does what the plan says', findings: [{ severity: 'nit', file: 'change', issue: 'Terse', suggestion: 'Fine' }] }));
  const change = { title: 'Planned change', summary: 'Carry out the plan', item: planned.id };
  await assert.rejects(proposeDeskChanges(runtime, 'clippy', change), /plan_item_not_working/);
  await approvePlan(runtime, planned.id, 'person');
  await assert.rejects(proposeDeskChanges(runtime, 'bellonda', change), /plan_item_not_yours/);
  await fakeGithub(root, remote, async () => {
    const result = await proposeDeskChanges(runtime, 'clippy', change);
    assert.equal(result.outcome, 'opened', result.summary);
    const items = await runtime.ledger.list();
    assert.deepEqual(items.map(item => item.id), [planned.id], 'the plan item itself carries the publication');
    const published = items[0]!;
    assert.equal(published.status, 'landed');
    assert.equal(published.publication?.state, 'open');
    assert.equal(published.deskPublication?.stage, 'complete');
    assert.equal(published.proposal.title, 'Planned change');
    const github = JSON.parse(await readFile(join(root, 'github.json'), 'utf8'));
    assert.match(github.body, /Approved plan<\/summary>\n\n1\. Write the change file/);
    assert.match(github.body, /Plan approved by person\./);
    assert.equal((await git(remote, ['show', `${published.branch}:change`])).trim(), 'planned change');
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

test('each daemon tick recovers dead external runners while preserving live claims', async () => {
  const { tick, drain } = await import('../src/daemon.ts');
  const { runtime } = await fixture();
  const owner = runtime.declarations.owners.get('clippy')!;
  runtime.declarations.owners.clear();
  runtime.declarations.owners.set('clippy', owner);
  runtime.reloadDeclarations = async () => {};
  const dead = await runtime.ledger.create('clippy', 'change', proposal, { status: 'landed', activeRunner: 424242 });
  const live = await runtime.ledger.create('clippy', 'change', proposal, { status: 'implementing', activeRunner: process.pid });
  const errors: string[] = [];
  const log = { duty() {}, item() {}, request() {}, error(context: string) { errors.push(context); } };
  await tick(runtime, log);
  await drain();
  assert.equal((await runtime.ledger.get(dead.id)).status, 'interrupted');
  assert.equal((await runtime.ledger.get(live.id)).activeRunner, process.pid);
  assert.equal((await resumeItem(runtime, dead.id, 'person')).status, 'landed');
  assert.deepEqual(errors, ['recovery']);
  await tick(runtime, log);
  await drain();
  assert.deepEqual(errors, ['recovery'], 'a live external runner is neither replayed nor logged as a conflict');
});

test('retry after the replan limit plans from the original repair head with fresh budgets', async () => {
  const { runtime } = await fixture();
  runtime.declarations.workflows.get('change')!.review.maxReplans = 1;
  const head = (await git(runtime.owner('clippy').workspace, ['rev-parse', 'HEAD'])).trim();
  const source = await runtime.ledger.create('clippy', 'change', proposal, { status: 'landed' });
  const item = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' }, replans: 1,
    repairOf: { itemId: source.id, previousHead: head, branch: 'original', prUrl: 'https://example.invalid/pr/1' },
  });
  let reviews = 0;
  let plans = 0;
  scriptHires(runtime, async request => {
    if (request.role === 'planner') {
      plans++;
      await assert.rejects(readFile(join(request.directory, 'change')));
      assert.equal((await git(request.directory, ['rev-parse', 'HEAD'])).trim(), head);
      return plan;
    }
    if (request.role === 'implementer') {
      await writeFile(join(request.directory, 'change'), 'attempt');
      return report;
    }
    if (request.role === 'reviewer') return ++reviews === 1 ? { ...verdict, decision: 'replan' } : verdict;
    return { notebook: [] };
  });
  assert.equal((await advance(runtime, item.id)).reason, 'replan_limit_reached');
  const retried = await retryItem(runtime, item.id, 'person');
  assert.equal(retried.status, 'planning');
  assert.equal(retried.replans, 0);
  assert.equal(retried.planApproval, undefined);
  assert.equal(retried.revisionStart, 1);
  assert.equal((await advance(runtime, item.id)).status, 'awaiting-plan-approval');
  await approvePlan(runtime, item.id, 'person');
  assert.equal((await advance(runtime, item.id)).status, 'landed');
  assert.equal(plans, 1);
  assert.equal(reviews, 2);
});

test('retry after the revision limit goes to implementation with the previous findings', async () => {
  const { runtime } = await fixture();
  runtime.declarations.workflows.get('change')!.review.maxRevisions = 0;
  const item = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' },
  });
  let implementations = 0;
  let reviews = 0;
  scriptHires(runtime, async request => {
    if (request.role === 'implementer') {
      implementations++;
      await writeFile(join(request.directory, 'change'), `attempt ${implementations}`);
      return report;
    }
    if (request.role === 'reviewer') return ++reviews === 1 ? { ...verdict, decision: 'revise' } : verdict;
    return { notebook: [] };
  });
  assert.equal((await advance(runtime, item.id)).reason, 'revision_limit_reached');
  assert.equal((await retryItem(runtime, item.id, 'person')).status, 'implementing');
  assert.equal((await advance(runtime, item.id)).status, 'landed');
  assert.equal(implementations, 2);
  assert.equal(reviews, 2);
});

test("a retry note reaches the next implementer and reviewer, so the person's answer is not lost", async () => {
  const { runtime } = await fixture();
  const item = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' },
  });
  const briefs: Record<string, string[]> = { implementer: [], reviewer: [] };
  scriptHires(runtime, async request => {
    briefs[request.role]?.push(request.brief);
    if (request.role === 'implementer' && briefs.implementer!.length > 1) await writeFile(join(request.directory, 'change'), 'accepted');
    if (request.role === 'implementer') return report;
    if (request.role === 'reviewer') return verdict;
    return { notebook: [] };
  });
  assert.equal((await advance(runtime, item.id)).reason, 'implementer_changed_nothing');
  assert.doesNotMatch(briefs.implementer![0]!, /person-notes-on-recovery/);
  await retryItem(runtime, item.id, 'person', 'I approve the exact wording.');
  const retried = await runtime.ledger.get(item.id);
  assert.equal(retried.humanNotes.at(-1)?.note, 'I approve the exact wording. (continue from implementing)');
  assert.equal((await advance(runtime, item.id)).status, 'landed');
  assert.match(briefs.implementer![1]!, /<person-notes-on-recovery>\nperson \(\d{4}-\d\d-\d\d\): I approve the exact wording\./);
  assert.match(briefs.reviewer![0]!, /<person-notes-on-recovery>[\s\S]*I approve the exact wording\./);
});

test('a malformed CI fix is recorded once and raised for a person', async () => {
  const { runtime, root, remote } = await fixture();
  await git(remote, ['branch', 'original', 'main']);
  const head = (await git(remote, ['rev-parse', 'original'])).trim();
  await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'landed', branch: 'original', landedCommit: head,
    publication: { url: 'https://github.com/example/clippy/pull/1', branch: 'original', by: 'person', at: '', state: 'open' },
  });
  let hires = 0;
  scriptHires(runtime, async () => {
    hires++;
    return { decision: 'fix', reason: 'Missing proposal' };
  });
  await fakeGithub(root, remote, async () => {
    assert.equal((await maintainPullRequests(runtime, 'clippy')).opened.length, 0);
    assert.equal((await maintainPullRequests(runtime, 'clippy')).opened.length, 0);
  });
  assert.equal(hires, 1);
  const snapshot = await runtime.notebook('clippy').journalSnapshot(runtime.owner('clippy').memory);
  const entries = snapshot.lines.map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.kind === 'attention' && entry.note.includes('ci_fix_missing_workflow_or_proposal')));
  assert.equal(JSON.parse(await readFile(join(runtime.stateDirectory, 'ci-triage-clippy.json'), 'utf8'))['https://github.com/example/clippy/pull/1'], head);
});

test('a completed rebase cannot be cancelled and a repair notice names the original PR', async () => {
  const { describeChange } = await import('../src/notices.ts');
  const { runtime } = await fixture();
  const target = { itemId: 'source', previousHead: 'head', branch: 'original', prUrl: 'https://example.invalid/pr/1' };
  const rebased = await runtime.ledger.create('clippy', 'rebase', proposal, { status: 'landed', rebaseOf: target });
  await assert.rejects(cancelItem(runtime, rebased.id, 'person', 'Too late'), /published_work_cannot_cancel/);
  assert.equal((await runtime.ledger.get(rebased.id)).status, 'landed');
  const repair = await runtime.ledger.create('clippy', 'change', proposal, { status: 'landed', repairOf: target, branch: 'repair' });
  assert.match(describeChange(repair, 'landing|')!.text, /publication will update https:\/\/example.invalid\/pr\/1/);
});

test('desk publication reports a competing runner and explains permanent failures', async () => {
  const { runtime } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const item = await runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'landing', worktree: desk.path, activeRunner: process.pid,
    deskPublication: { stage: 'commit', reviewedHead: 'old', reviewedTree: 'tree', reviewer: 'reviewer' },
  });
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Retry', summary: 'Retry' })).outcome, 'in-progress');
  await runtime.ledger.update(item.id, current => ({ ...current, activeRunner: undefined }));
  const failed = await proposeDeskChanges(runtime, 'clippy', { title: 'Retry', summary: 'Retry' });
  assert.equal(failed.outcome, 'publication-failed');
  assert.match(failed.summary, /desk_head_changed/);
  assert.match(failed.summary, /Cancel .* before proposing/);
  assert.equal((await runtime.ledger.get(item.id)).status, 'failed');
});

test('desk publication stays landed if its journal fails, and commits the journal on success', async () => {
  const { advanceDeskPublication } = await import('../src/desk-changes.ts');
  const { runtime } = await fixture();
  const createFinished = () => runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'landing',
    publication: { url: 'https://example.invalid/pr/1', branch: 'desk', by: 'owner', at: '', state: 'open' },
    deskPublication: { stage: 'complete', reviewedHead: 'head', reviewedTree: 'tree', reviewer: 'reviewer' },
  });
  const notebook = runtime.notebook('clippy');
  const realJournal = notebook.journal.bind(notebook);
  runtime.notebook = () => notebook;
  notebook.journal = async () => { throw new Error('journal_disk_full'); };
  const first = await createFinished();
  assert.equal((await advanceDeskPublication(runtime, first.id)).status, 'landed');
  const persisted = await runtime.ledger.get(first.id);
  assert.match(persisted.reason!, /desk_publication_journal_failed: journal_disk_full/);
  assert.equal(persisted.deskPublication?.stage, 'complete');
  notebook.journal = realJournal;
  const second = await createFinished();
  await advanceDeskPublication(runtime, second.id);
  assert.equal((await git(notebook.root, ['status', '--porcelain'])).trim(), '');
  assert.match(await git(notebook.root, ['log', '-1', '--format=%s']), /journal desk change/);
});

test('maintenance rebases a desk PR whose earlier desk commit was squash-merged', async () => {
  const { runtime, root, remote, seed } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'previous-change'), 'already merged');
  await git(desk.path, ['add', '.']);
  await git(desk.path, ['commit', '-qm', 'Previous desk change']);
  await git(desk.path, ['push', '-q', 'origin', 'HEAD:earlier-desk-pr']);
  await git(seed, ['fetch', '-q', 'origin']);
  await git(seed, ['merge', '--squash', 'origin/earlier-desk-pr']);
  await git(seed, ['commit', '-qm', 'Squash previous desk PR']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  await writeFile(join(desk.path, 'next-change'), 'new work');
  scriptHires(runtime, async request => {
    assert.equal(request.role, 'reviewer', 'patch-equivalent history needs no conflict-resolution hire');
    return verdict;
  });
  await fakeGithub(root, remote, async () => {
    await proposeDeskChanges(runtime, 'clippy', { title: 'Next desk change', summary: 'New work' });
    const [source] = await runtime.ledger.list();
    const github = JSON.parse(await readFile(join(root, 'github.json'), 'utf8'));
    await writeFile(join(root, 'github.json'), JSON.stringify({ ...github, failing: false, mergeable: 'CONFLICTING' }));
    const maintained = await maintainPullRequests(runtime, 'clippy');
    assert.equal(maintained.opened.length, 1);
    const rebase = maintained.opened[0]!;
    assert.equal(rebase.rebaseOf?.itemId, source!.id);
    assert.equal(rebase.rebaseOf?.branch, source!.publication!.branch);
    const replayed = await advance(runtime, rebase.id);
    assert.equal(replayed.status, 'awaiting-push-approval', replayed.reason);
    assert.equal(await readFile(join(replayed.worktree!, 'previous-change'), 'utf8'), 'already merged');
    assert.equal(await readFile(join(replayed.worktree!, 'next-change'), 'utf8'), 'new work');
    assert.equal((await git(replayed.worktree!, ['rev-list', '--count', 'origin/main..HEAD'])).trim(), '1');
  });
});

test('desk PR CI failures wake the owner once per observed head', async () => {
  const { runtime, root, remote } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'first');
  let triages = 0;
  scriptHires(runtime, async request => {
    if (request.role === 'reviewer') return verdict;
    triages++;
    return { decision: 'flaky', reason: 'External test failure' };
  });
  await fakeGithub(root, remote, async () => {
    await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'First change' });
    const [source] = await runtime.ledger.list();
    await maintainPullRequests(runtime, 'clippy');
    await maintainPullRequests(runtime, 'clippy');
    assert.equal(triages, 1);
    await writeFile(join(desk.path, 'change'), 'second');
    await git(desk.path, ['add', '.']);
    await git(desk.path, ['commit', '-qm', 'Update PR head']);
    await git(desk.path, ['push', '-q', 'origin', `HEAD:${source!.publication!.branch}`]);
    await maintainPullRequests(runtime, 'clippy');
    await maintainPullRequests(runtime, 'clippy');
    assert.equal(triages, 2);
    const head = (await git(desk.path, ['rev-parse', 'HEAD'])).trim();
    const triaged = JSON.parse(await readFile(join(runtime.stateDirectory, 'ci-triage-clippy.json'), 'utf8'));
    assert.equal(triaged[source!.publication!.url], head);
  });
});

test('desk PR merges and closes notify the original chat and remain visible in owner work', async context => {
  const { noticeWorkChanges, pendingNotices } = await import('../src/notices.ts');
  const { deskState } = await import('@onionsoup/owners');
  for (const terminal of ['MERGED', 'CLOSED']) {
    await context.test(terminal, async () => {
      const { runtime, root, remote } = await fixture();
      const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
      const origin = { sessionID: 'chat-that-proposed-the-change', directory: desk.path };
      await writeFile(join(desk.path, 'change'), 'desk change');
      scriptHires(runtime, async () => verdict);
      await fakeGithub(root, remote, async () => {
        await proposeDeskChanges(runtime, 'clippy', { title: 'Desk proposal', summary: 'Update', origin });
        const [source] = await runtime.ledger.list();
        assert.deepEqual(source!.origin, origin);
        for (let index = 0; index < 6; index++) {
          await runtime.ledger.create('clippy', 'change', { ...proposal, title: `Newer finished item ${index}` }, { status: 'landed' });
        }
        const visible = await deskState(runtime, { owner: 'clippy' });
        assert.ok(visible.work!.some(item => item.id === source!.id), 'open PR survives the recent-completed limit');
        assert.ok(!visible.recent!.some(item => item.id === source!.id), 'open PR is not duplicated among completed items');
        const fallbackDirectory = async () => '/wrong-chat-directory';
        await noticeWorkChanges(runtime, fallbackDirectory);
        const github = JSON.parse(await readFile(join(root, 'github.json'), 'utf8'));
        await writeFile(join(root, 'github.json'), JSON.stringify({ ...github, state: terminal }));
        await maintainPullRequests(runtime, 'clippy');
        assert.equal((await runtime.ledger.get(source!.id)).publication!.state, terminal.toLowerCase());
        const raised = await noticeWorkChanges(runtime, fallbackDirectory);
        const notice = raised.find(entry => entry.workItem === source!.id)!;
        assert.equal(notice.change, `pr-${terminal.toLowerCase()}`);
        assert.deepEqual(notice.origin, origin);
        assert.ok((await pendingNotices(runtime)).some(entry => entry.id === notice.id));
        assert.deepEqual(await noticeWorkChanges(runtime, fallbackDirectory), [], 'terminal notice is queued once');
      });
    });
  }
});

test('an old open desk PR remains in owner status text with its PR URL', async () => {
  const { statusText } = await import('@onionsoup/owners');
  const { runtime } = await fixture();
  const source = await runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'landed', publication: {
      url: 'https://example.invalid/pr/1', branch: 'desk', by: 'owner', at: '', state: 'open',
    },
  });
  const text = statusText([source], [], new Date('2100-01-01T00:00:00Z'));
  assert.match(text, /^Open:\n- work /);
  assert.match(text, /https:\/\/example.invalid\/pr\/1 \(open\)/);
  assert.doesNotMatch(text, /Finished in the last/);
});

test('a desk PR merged under its grant between ticks queues a merge notice for the proposing chat', async () => {
  const { noticeWorkChanges, pendingNotices } = await import('../src/notices.ts');
  const { runtime, root, remote } = await fixture();
  const owner = runtime.declarations.owners.get('clippy')!;
  owner.grants.push({ to: 'clippy', action: 'merge', target: 'example/clippy' });
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const origin = { sessionID: 'grant-proposal-chat', directory: desk.path };
  await writeFile(join(desk.path, 'change'), 'desk change');
  scriptHires(runtime, async () => verdict);
  const fallbackDirectory = async () => '/wrong-directory';
  await noticeWorkChanges(runtime, fallbackDirectory);
  await fakeGithub(root, remote, async () => {
    const opened = await proposeDeskChanges(runtime, 'clippy', { title: 'Merge desk change', summary: 'Update', origin });
    assert.equal(opened.outcome, 'merged');
    const [source] = await runtime.ledger.list();
    assert.equal(source!.publication!.state, 'merged');
    const notices = await noticeWorkChanges(runtime, fallbackDirectory);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.change, 'pr-merged');
    assert.deepEqual(notices[0]!.origin, origin);
    assert.match(notices[0]!.text, /was merged/);
    assert.equal((await pendingNotices(runtime))[0]!.change, 'pr-merged');
    assert.deepEqual(await noticeWorkChanges(runtime, fallbackDirectory), []);
  });
});


test('a post-merge desk failure still reports the failed follow-up', async () => {
  const { describeChange } = await import('../src/notices.ts');
  const { runtime } = await fixture();
  const source = await runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'failed', reason: 'site_publish_unavailable', publication: {
      url: 'https://example.invalid/pr/1', branch: 'desk', by: 'owner', at: '', state: 'merged',
    },
  });
  const notice = describeChange(source, 'landing|open');
  assert.equal(notice?.change, 'failed');
  assert.match(notice!.text, /site_publish_unavailable/);
});

async function journalKinds(runtime: Runtime, ownerId: string) {
  const directory = join(runtime.notebook(ownerId).directory, 'journal');
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('').split('\n').filter(Boolean);
  return lines.map(line => (JSON.parse(line) as { kind: string }).kind);
}

const revise = (issue: string, severity = 'blocker') => ({
  decision: 'revise', summary: `Fix ${issue}`, findings: [{ severity, file: 'change', issue, suggestion: `Resolve ${issue}` }],
});

test('a desk re-review checks the previous findings against what changed since, instead of starting over', async () => {
  const { runtime } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const briefs: string[] = [];
  scriptHires(runtime, async request => {
    briefs.push(request.brief);
    return revise(`issue ${briefs.length}`);
  });
  await writeFile(join(desk.path, 'change'), 'first draft\n');
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' })).outcome, 'needs-work');
  assert.doesNotMatch(briefs[0]!, /previous-review/, 'a first review has nothing to check against');
  await writeFile(join(desk.path, 'change'), 'second draft\n');
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' })).outcome, 'needs-work');
  assert.match(briefs[1]!, /<previous-review round="1" reviewer="[^"]+" decision="revise">/);
  assert.match(briefs[1]!, /\[blocker\] change: issue 1 → Resolve issue 1/);
  assert.match(briefs[1]!, /<changes-since-previous-review>[\s\S]*-first draft\n\+second draft/);
  assert.match(briefs[1]!, /checking every previous finding/);
  const rounds = await deskReviewRounds(runtime, 'clippy', 'example/clippy');
  assert.deepEqual(rounds.map(round => round.findings[0]?.issue), ['issue 1', 'issue 2']);
  assert.equal((await git(desk.path, ['diff', '--name-only'])).trim(), 'change', "the review's snapshot leaves the owner's own git diff intact");
});

test('after too many rounds the person decides; a reset starts afresh and an approval clears the history', async (context) => {
  const { runtime, root, remote } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const limit = DESK_CHANGE_LIMITS.reviewRoundsBeforePerson;
  context.after(() => { DESK_CHANGE_LIMITS.reviewRoundsBeforePerson = limit; });
  DESK_CHANGE_LIMITS.reviewRoundsBeforePerson = 2;
  let hires = 0;
  let answer: unknown = revise('wording');
  scriptHires(runtime, async () => {
    hires++;
    return answer;
  });
  await writeFile(join(desk.path, 'change'), 'draft\n');
  await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' });
  await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' });
  const waiting = await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' });
  assert.equal(waiting.outcome, 'needs-person');
  assert.match(waiting.summary, /desk-review-reset clippy example\/clippy/);
  assert.equal(hires, 2, 'no reviewer is hired while the person decides');
  await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' });
  assert.equal((await journalKinds(runtime, 'clippy')).filter(kind => kind === 'attention').length, 1, 'the person is asked once');

  assert.equal(await resetDeskReviews(runtime, 'clippy', undefined, 'person'), 2);
  assert.ok((await journalKinds(runtime, 'clippy')).includes('desk-review-reset'));
  answer = verdict;
  await fakeGithub(root, remote, async () => {
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' })).outcome, 'opened');
  });
  assert.equal(hires, 3);
  assert.deepEqual(await deskReviewRounds(runtime, 'clippy', 'example/clippy'), [], 'an approved change leaves no history');
});

test('a desk change whose review has only nits opens its PR with them in the body, and records no review round', async () => {
  const { runtime, root, remote } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'desk change');
  scriptHires(runtime, async () => revise('spacing', 'nit'));
  await fakeGithub(root, remote, async () => {
    const result = await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update the desk' });
    assert.equal(result.outcome, 'opened', result.summary);
    const github = await githubState(root);
    assert.match(github.body!, /### Review\n\napprove after 1 round: Fix spacing/);
    assert.match(github.body!, /\[nit\] change: spacing → Resolve spacing/);
    assert.deepEqual(await deskReviewRounds(runtime, 'clippy', 'example/clippy'), [], 'advice records no review round');
  });
});

test('a desk review that approves over a blocker sends the change back', async () => {
  const { runtime } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'desk change');
  scriptHires(runtime, async () => ({ ...revise('a wrong claim'), decision: 'approve', summary: 'Looks fine' }));
  const result = await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update the desk' });
  assert.equal(result.outcome, 'needs-work');
  assert.match(result.summary, /\[blocker\] change: a wrong claim/);
  assert.equal((await runtime.ledger.list()).length, 0, 'nothing was published');
  assert.deepEqual((await deskReviewRounds(runtime, 'clippy', 'example/clippy')).map(round => round.findings[0]?.issue), ['a wrong claim']);
});

test('a merged PR is recorded on the next tick, and its request and notice follow on that tick', async () => {
  const { tick, drain } = await import('../src/daemon.ts');
  const { requestWork } = await import('../src/delegation.ts');
  const { noticeWorkChanges, pendingNotices } = await import('../src/notices.ts');
  const { runtime, root, remote } = await fixture();
  for (const owner of runtime.declarations.owners.values()) {
    owner.duties = [];
    owner.memory.enabled = false;
    await runtime.notebook(owner.id).ensure('# Charter\n');
  }
  runtime.reloadDeclarations = async () => {};
  const session = { sessionID: 'ses_plan_work', directory: '/desks/clippy' };
  const publication = { url: 'https://github.com/example/clippy/pull/1', branch: 'owners/work', by: 'clippy', at: '', state: 'open' as const };
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'landed', branch: 'owners/work', publication, session });
  const request = await requestWork(runtime, 'homelab', 'clippy', proposal);
  await runtime.requests.save({ ...request, status: 'work-running', workItem: item.id });
  await noticeWorkChanges(runtime, async () => '/desks/clippy');
  const errors: string[] = [];
  const log = { duty() {}, item() {}, request() {}, error(context: string, error: unknown) { errors.push(`${context}: ${String(error)}`); } };
  await fakeGithub(root, remote, async () => {
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 1, state: 'MERGED' }));
    await tick(runtime, log);
    await drain();
    assert.equal((await githubState(root)).stateViews, 1, 'one state read, no mergeability wait');
  });
  assert.equal((await runtime.ledger.get(item.id)).publication?.state, 'merged');
  assert.equal((await runtime.requests.get(request.id)).status, 'completed');
  const merged = (await pendingNotices(runtime)).find(notice => notice.id === `${item.id}-pr-merged`);
  assert.deepEqual(merged?.origin, session, 'the session carrying out the plan hears it');
  assert.deepEqual(errors, []);
});

/** A base with ignored dependencies, as a Node repository has. */
async function ignoreDependencies(runtime: Runtime, seed: string) {
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n');
  await writeFile(join(seed, 'doc'), 'base doc\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'Ignore dependencies']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  await refreshCheckout(runtime.repositoryOwner('clippy'));
}

/** What a hire leaves behind that no commit contains: installed dependencies with their own broken-link docs. */
async function installDependencies(directory: string) {
  await mkdir(join(directory, 'node_modules', 'zod'), { recursive: true });
  await writeFile(join(directory, 'node_modules', 'zod', 'README.md'), '[refine](#refine)\n');
}

test('a conflict resolution is verified as its commit, without what the resolver installed or left behind', async () => {
  const { runtime, seed } = await fixture();
  await ignoreDependencies(runtime, seed);
  await git(seed, ['checkout', '-qb', 'original']);
  await writeFile(join(seed, 'doc'), 'original change\n');
  await git(seed, ['commit', '-qam', 'Original change']);
  await git(seed, ['push', '-q', 'origin', 'original']);
  const head = (await git(seed, ['rev-parse', 'HEAD'])).trim();
  await git(seed, ['checkout', '-q', 'main']);
  await writeFile(join(seed, 'doc'), 'base moved on\n');
  await git(seed, ['commit', '-qam', 'Base moves on']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  const prUrl = 'https://github.com/example/clippy/pull/1';
  const source = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'landed', branch: 'original', landedCommit: head,
    publication: { url: prUrl, branch: 'original', by: 'person', at: '', state: 'open' },
  });
  const rebase = await runtime.ledger.create('clippy', REBASE_WORKFLOW, proposal, {
    status: 'implementing', rebaseOf: { itemId: source.id, branch: 'original', prUrl, previousHead: head },
  });
  let reviewed = false;
  scriptHires(runtime, async request => {
    if (request.role === 'owner') return { decision: 'resolve', guidance: 'Keep both lines', reason: 'Both sides matter' };
    if (request.role === 'implementer') {
      assert.match(request.brief, /the runtime stages your resolution/);
      await writeFile(join(request.directory, 'doc'), 'base moved on\noriginal change\n');
      await installDependencies(request.directory);
      await writeFile(join(request.directory, 'scratch.txt'), 'notes');
      return { ...report, filesChanged: ['doc'] };
    }
    if (request.role === 'reviewer') {
      reviewed = true;
      assert.equal(existsSync(join(request.directory, 'node_modules')), false, 'ignored dependencies are gone before verification');
      assert.equal(existsSync(join(request.directory, 'scratch.txt')), false, 'a leftover is reported, not verified');
      assert.equal((await git(request.directory, ['status', '--porcelain'])).trim(), '');
      assert.equal(await readFile(join(request.directory, 'doc'), 'utf8'), 'base moved on\noriginal change\n');
      return verdict;
    }
    return { notebook: [] };
  });
  const replayed = await advance(runtime, rebase.id);
  assert.equal(replayed.status, 'awaiting-push-approval', replayed.reason);
  assert.ok(reviewed);
  assert.match(replayed.implementations.at(-1)!.report.summary, /Left out of the commit .*scratch\.txt/);
});

test('an implementation is verified without the ignored files its implementer installed, keeping its new files', async () => {
  const { runtime, seed } = await fixture();
  await ignoreDependencies(runtime, seed);
  const item = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' },
  });
  let reviewed = false;
  scriptHires(runtime, async request => {
    if (request.role === 'implementer') {
      await writeFile(join(request.directory, 'change'), 'new file');
      await installDependencies(request.directory);
      return report;
    }
    if (request.role === 'reviewer') {
      reviewed = true;
      assert.equal(existsSync(join(request.directory, 'node_modules')), false, 'ignored dependencies are gone before verification');
      assert.equal(await readFile(join(request.directory, 'change'), 'utf8'), 'new file', 'untracked files of the change stay');
      return verdict;
    }
    return { notebook: [] };
  });
  const landed = await advance(runtime, item.id);
  assert.equal(landed.status, 'landed', landed.reason);
  assert.ok(reviewed);
  assert.match(await git(runtime.owner('clippy').workspace, ['show', '--name-only', '--format=', landed.landedCommit!]), /^change$/m);
});

/** A change item whose reviewer asks for changes twice with a revision budget of one: it fails at the limit. */
async function reviewUntilLimit(runtime: Runtime, lastVerdict: unknown = revise('issue 2')) {
  runtime.declarations.workflows.get('change')!.review.maxRevisions = 1;
  const item = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'implementing', plan, planApproval: { by: 'person', at: '' },
  });
  const briefs: string[] = [];
  const ownerViews: string[] = [];
  let implementations = 0;
  scriptHires(runtime, async request => {
    if (request.role === 'implementer') {
      await writeFile(join(request.directory, 'change'), `draft ${++implementations}\n`);
      return report;
    }
    if (request.role !== 'reviewer') return { notebook: [] };
    briefs.push(request.brief);
    ownerViews.push((await git(request.directory, ['diff', '--name-only'])).trim());
    return briefs.length === 1 ? revise('issue 1') : lastVerdict;
  });
  const failed = await advance(runtime, item.id);
  assert.equal(failed.reason, 'revision_limit_reached');
  return { item: failed, briefs, ownerViews };
}

test('a work-item re-review checks the previous findings against what changed since, instead of starting over', async () => {
  const { runtime } = await fixture();
  const { item, briefs, ownerViews } = await reviewUntilLimit(runtime);
  assert.doesNotMatch(briefs[0]!, /previous-review/, 'a first review has nothing to check against');
  assert.match(briefs[1]!, /<previous-review round="1" reviewer="[^"]+" decision="revise">/);
  assert.match(briefs[1]!, /\[blocker\] change: issue 1 → Resolve issue 1/);
  assert.match(briefs[1]!, /<changes-since-previous-review>[\s\S]*-draft 1\n\+draft 2/);
  assert.match(briefs[1]!, /checking every previous finding/);
  const trees = item.implementations.map(implementation => implementation.tree);
  assert.equal(trees.length, 2);
  assert.ok(trees.every(tree => /^[0-9a-f]{40}$/.test(tree ?? '')), 'each implementation keeps its tree');
  assert.notEqual(trees[0], trees[1]);
  assert.deepEqual(ownerViews, ['change', 'change'], "the snapshot leaves the worktree's own git diff intact");
});

test('the person lands over reviewer findings only for verified work that ran out of review rounds', async () => {
  const { runtime } = await fixture();
  const running = await runtime.ledger.create('clippy', 'change', proposal, { status: 'implementing' });
  await assert.rejects(landOverFindings(runtime, running.id, 'person', 'ship it'), /not_failed: implementing/);
  const otherFailure = await runtime.ledger.create('clippy', 'change', proposal, { status: 'failed', reason: 'replan_limit_reached' });
  await assert.rejects(landOverFindings(runtime, otherFailure.id, 'person', 'ship it'), /land_over_findings_not_revision_limit/);
  const unverified = await runtime.ledger.create('clippy', 'change', proposal, {
    status: 'failed', reason: 'revision_limit_reached',
    implementations: [{ report, diffStat: 'change', verification: [{ command: 'test', exitCode: 1, output: 'failed' }] }],
  });
  await assert.rejects(landOverFindings(runtime, unverified.id, 'person', 'ship it'), /land_over_findings_unverified/);
  const { item } = await reviewUntilLimit(runtime);
  await assert.rejects(landOverFindings(runtime, item.id, 'person', '  '), /land_over_findings_note_required/);
  assert.equal((await runtime.ledger.get(item.id)).status, 'failed', 'a refusal changes nothing');
});

test('landing over findings commits through the ordinary landing step and opens a follow-up for the findings', async () => {
  const { runtime } = await fixture();
  const { item } = await reviewUntilLimit(runtime);
  const { followUp } = await landOverFindings(runtime, item.id, 'person', 'The remaining point is a style preference');
  const landed = await advance(runtime, item.id);
  assert.equal(landed.status, 'landed', landed.reason);
  const override = landed.humanNotes.at(-1)!;
  assert.deepEqual([override.kind, override.by, override.note], ['override', 'person', 'The remaining point is a style preference']);
  assert.ok((await journalKinds(runtime, 'clippy')).includes('landed-over-findings'));
  assert.match(await git(landed.worktree!, ['log', '-1', '--format=%B']), /^Landed-over-findings-by: person$/m);
  const persisted = await runtime.ledger.get(followUp!.id);
  assert.equal(persisted.status, 'proposed', 'the follow-up is planned and approved like any work');
  assert.match(persisted.proposal.goal, /\[blocker\] change: issue 2 → Resolve issue 2/);
  assert.match(persisted.proposal.goal, new RegExp(item.id));
});

test('landing over a limit whose last review listed no findings opens no follow-up', async () => {
  const { runtime } = await fixture();
  const { item } = await reviewUntilLimit(runtime, { decision: 'revise', summary: 'Not sure', findings: [] });
  const before = (await runtime.ledger.list()).length;
  const { item: overridden, followUp } = await landOverFindings(runtime, item.id, 'person', 'Good enough');
  assert.equal(overridden.status, 'landing');
  assert.equal(followUp, undefined);
  assert.equal((await runtime.ledger.list()).length, before);
});
