import { reconcileExternalPublication } from '../src/external-publication.ts';
import { sessionHistory } from '../src/session-history.ts';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changeAttention, listAttention } from '../src/attention.ts';
import { Runtime, advance, approvePlan, cancelItem, resumeItem, retryItem } from '@onionsoup/owners';
import { git, refreshCheckout, ensureDesk, createWorktree } from '../src/workspace.ts';
import { REBASE_WORKFLOW, maintainPullRequests, refreshPublications } from '../src/rebase.ts';
import { deskSyncText } from '../src/desk-sync.ts';
import { openOwnerSession, type OwnerSessionClient, type SessionActivity } from '../src/owner-sessions.ts';
import { PLAN_WORKTREE_LIMITS, ensurePlanWorktree, removeIdlePlanWorktrees, syncPlanWorktree } from '../src/plan-worktrees.ts';
import { checkoutPullRequest, DESK_CHANGE_LIMITS, proposeDeskChanges, resetDeskReviews } from '../src/desk-changes.ts';
import { deskReviewRounds } from '../src/desk-reviews.ts';
import type { HireRequest } from '../src/opencode.ts';

const proposal = { title: 'Repair flow', goal: 'Complete the change', rationale: 'Regression', acceptance: ['It completes'], size: 'small' as const };
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
  api() { console.log(JSON.stringify(state.external)); },
  view() {
    if (args[args.indexOf('--json') + 1] === 'isDraft,autoMergeRequest') { console.log(JSON.stringify({ isDraft: !!state.draft, autoMergeRequest: state.autoMergeRequest || null })); return; }
    if (args[args.indexOf('--json') + 1] === 'state') { state.stateViews = (state.stateViews || 0) + 1; console.log(JSON.stringify({ state: state.state })); return; }
    const branch = state.branch || 'original'; const headRefOid = cp.execFileSync('git', ['-C', remote, 'rev-parse', branch]).toString().trim(); console.log(JSON.stringify({ url, state: state.state, mergeable: state.mergeable || 'MERGEABLE', headRefOid })); },
  checks() { console.log(JSON.stringify(state.failing === false ? [] : [{ name: 'test', bucket: 'fail', link: '' }])); },
  list() { console.log(JSON.stringify(state.created ? [{ url, state: state.state }] : [])); },
  create() {
    if (state.failCreate) {
      state.failCreate = false;
      fs.writeFileSync(path, JSON.stringify(state));
      process.exit(1);
    }
    state.created++;
    state.draft = args.includes('--draft');
    state.branch = args[args.indexOf('--head') + 1];
    state.body = args[args.indexOf('--body') + 1];
    console.log(url);
  },
  merge() { state.state = 'MERGED'; },
};
handlers[args[0] === 'api' ? 'api' : args[1]]();
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

test('a clean desk retries publication after commit and enrolls its PR in the ledger', async () => {
  const { runtime, root, remote } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'desk change');
  scriptHires(runtime, async request => {
    assert.match(request.brief, /read as the project's own record/);
    assert.match(request.brief, /process narration and flag it as a minor finding/);
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
  await assert.rejects(proposeDeskChanges(runtime, 'bellonda', change), /item_not_yours/);
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
    assert.equal(published.proposal.goal, proposal.goal, 'an implementation summary does not replace the requested outcome');
    const github = JSON.parse(await readFile(join(root, 'github.json'), 'utf8'));
    assert.match(github.body, /Approved plan<\/summary>\n\n1\. Write the change file/);
    assert.match(github.body, /Plan approved by person\./);
    assert.equal((await git(remote, ['show', `${published.branch}:change`])).trim(), 'planned change');
  });
});

test('recovery preserves the failed stage, journals the person, and cancellation cannot race a running effect', async () => {
  const { runtime } = await fixture();
  const item = await runtime.ledger.create('clippy', REBASE_WORKFLOW, proposal, { status: 'reviewing', activeRunner: 424242 });
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
  const item = await runtime.ledger.create('clippy', 'desk-publication', proposal);
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
  const dead = await runtime.ledger.create('clippy', REBASE_WORKFLOW, proposal, { status: 'landed', activeRunner: 424242 });
  const live = await runtime.ledger.create('clippy', REBASE_WORKFLOW, proposal, { status: 'implementing', activeRunner: process.pid });
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

test('a failing PR wakes its owner, and the fix proposed from the PR\'s head goes onto the same PR', async () => {
  const { pendingNotices } = await import('../src/notices.ts');
  const { runtime, root, remote } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const origin = { sessionID: 'ses_clippy', directory: desk.path };
  await writeFile(join(desk.path, 'feature'), 'original feature');
  let triages = 0;
  scriptHires(runtime, async request => {
    if (request.role === 'reviewer') return verdict;
    triages++;
    return triages === 1 ? { decision: 'fix', reason: 'The feature test fails' } : { decision: 'flaky', reason: 'Runner timeout' };
  });
  await fakeGithub(root, remote, async () => {
    await proposeDeskChanges(runtime, 'clippy', { title: 'Feature', summary: 'Add the feature', origin });
    const [source] = await runtime.ledger.list();
    const prHead = source!.landedCommit!;
    const maintained = await maintainPullRequests(runtime, 'clippy');
    assert.equal(maintained.opened.length, 0, 'the owner fixes it on its desk; no work item is opened for it');
    assert.equal((await runtime.ledger.list()).length, 1);
    const [woken] = (await pendingNotices(runtime)).filter(notice => notice.change.startsWith('ci-fix'));
    assert.deepEqual(woken?.origin, origin);
    assert.ok(woken!.text.includes(`onionsoup_checkout_pr item "${source!.id}"`), woken!.text);

    await writeFile(join(desk.path, 'unrelated'), 'draft');
    await assert.rejects(checkoutPullRequest(runtime, 'clippy', source!.id), /desk_not_clean/);
    await rm(join(desk.path, 'unrelated'));
    const checkedOut = await checkoutPullRequest(runtime, 'clippy', source!.id);
    assert.equal(checkedOut.head, prHead);
    await writeFile(join(desk.path, 'repair'), 'fix');
    const repaired = await proposeDeskChanges(runtime, 'clippy', { title: 'Fix the feature test', summary: 'Repair', item: source!.id });
    assert.equal(repaired.outcome, 'opened', repaired.summary);
    assert.equal(repaired.url, source!.publication!.url);
    const repair = (await runtime.ledger.list()).find(item => item.repairOf)!;
    assert.equal(repair.repairOf?.previousHead, prHead);
    assert.equal(repair.status, 'landed');
    const branch = source!.publication!.branch;
    assert.equal((await git(remote, ['rev-parse', branch])).trim(), repair.landedCommit, 'the fix went onto the PR branch');
    assert.equal((await git(remote, ['rev-parse', `${branch}~1`])).trim(), prHead, 'on top of the head it was reviewed against');
    assert.equal((await git(remote, ['show', `${branch}:repair`])).trim(), 'fix');
    assert.equal((await runtime.ledger.get(source!.id)).landedCommit, repair.landedCommit);
    assert.equal((await githubState(root)).created, 1, 'no second PR');

    await writeFile(join(root, 'github.json'), JSON.stringify({ ...await githubState(root), failing: false, mergeable: 'CONFLICTING' }));
    const maintenance = await maintainPullRequests(runtime, 'clippy');
    assert.equal(maintenance.opened.length, 1, 'source and repair publications produce only one maintenance item');
    assert.equal(maintenance.opened[0]!.rebaseOf?.itemId, source!.id);
  });
});

test('a PR whose owner cannot change its repository has its CI fix raised for the person, once', async () => {
  const { runtime, root, remote } = await fixture();
  const clippy = runtime.declarations.owners.get('clippy')!;
  runtime.declarations.owners.set('clippy', { ...clippy, persona: undefined });
  await git(remote, ['branch', 'original', 'main']);
  const head = (await git(remote, ['rev-parse', 'original'])).trim();
  await runtime.ledger.create('clippy', 'desk-publication', proposal, {
    status: 'landed', branch: 'original', landedCommit: head,
    publication: { url: 'https://github.com/example/clippy/pull/1', branch: 'original', by: 'person', at: '', state: 'open' },
  });
  let hires = 0;
  scriptHires(runtime, async () => {
    hires++;
    return { decision: 'fix', reason: 'The build is broken' };
  });
  await fakeGithub(root, remote, async () => {
    await maintainPullRequests(runtime, 'clippy');
    await maintainPullRequests(runtime, 'clippy');
  });
  assert.equal(hires, 1);
  const kinds = await journalKinds(runtime, 'clippy');
  assert.equal(kinds.filter(kind => kind === 'attention').length, 1);
  assert.equal(JSON.parse(await readFile(join(runtime.stateDirectory, 'ci-triage-clippy.json'), 'utf8'))['https://github.com/example/clippy/pull/1'], head);
});

test('a completed rebase cannot be cancelled and a repair notice names the original PR', async () => {
  const { describeChange } = await import('../src/notices.ts');
  const { runtime } = await fixture();
  const target = { itemId: 'source', previousHead: 'head', branch: 'original', prUrl: 'https://example.invalid/pr/1' };
  const rebased = await runtime.ledger.create('clippy', 'rebase', proposal, { status: 'landed', rebaseOf: target });
  await assert.rejects(cancelItem(runtime, rebased.id, 'person', 'Too late'), /published_work_cannot_cancel/);
  assert.equal((await runtime.ledger.get(rebased.id)).status, 'landed');
  const publication = { url: target.prUrl, branch: target.branch, by: 'clippy', at: '', state: 'open' as const };
  const repair = await runtime.ledger.create('clippy', 'desk-publication', proposal, { status: 'landed', repairOf: target, branch: 'original', publication });
  assert.match(describeChange(repair, 'landing|')!.text, /is published as https:\/\/example.invalid\/pr\/1/);
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
          await runtime.ledger.create('clippy', 'desk-publication', { ...proposal, title: `Newer finished item ${index}` }, { status: 'landed' });
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
  assert.match(briefs[0]!, /<host-verification>[\s\S]*"verifier":"host-sandbox","checks":\[\]/);
  assert.match(briefs[0]!, /empty checks list means no configured checks ran/);
  await writeFile(join(desk.path, 'change'), 'second draft\n');
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' })).outcome, 'needs-work');
  assert.match(briefs[1]!, /<previous-review round="1" reviewer="[^"]+" decision="revise">/);
  assert.match(briefs[1]!, /\[blocker\] change: issue 1 → Resolve issue 1/);
  assert.match(briefs[1]!, /<changes-since-previous-review>[\s\S]*-first draft\n\+second draft/);
  assert.match(briefs[1]!, /checking every previous finding/);
  const rounds = await deskReviewRounds(runtime, 'clippy', 'example/clippy');
  assert.deepEqual(rounds.map(round => round.findings[0]?.issue), ['issue 1', 'issue 2']);
  assert.equal(rounds[0]!.evidence?.tree, rounds[0]!.tree);
  assert.notEqual(rounds[1]!.evidence?.tree, rounds[0]!.evidence?.tree);
  assert.equal((await git(desk.path, ['diff', '--name-only'])).trim(), 'change', "the review's snapshot leaves the owner's own git diff intact");
});

test('approved-plan review receives original task criteria and recorded host check outcomes', async () => {
  const { runtime } = await fixture();
  const item = await runtime.ledger.create('clippy', 'owner-change', {
    ...proposal, acceptance: ['The operator can resume the same goal after correction'],
  }, { status: 'working' });
  const owner = runtime.declarations.owners.get('clippy')!;
  assert.equal(owner.domain.kind, 'git-repository');
  if (owner.domain.kind === 'git-repository') owner.domain.verify = [['true']];
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'candidate\n');
  let brief = '';
  scriptHires(runtime, async request => {
    brief = request.brief;
    return revise('Needs evidence');
  });
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Author claim', item: item.id })).outcome, 'needs-work');
  assert.match(brief, /"command":"true","exitCode":0/);
  assert.match(brief, /<task-acceptance>\n\["The operator can resume the same goal after correction"\]/);
  assert.match(brief, /does not prove deployment/);
});

test('host checks that modify source require another verification before any paid review', async () => {
  const { runtime } = await fixture();
  const owner = runtime.declarations.owners.get('clippy')!;
  assert.equal(owner.domain.kind, 'git-repository');
  if (owner.domain.kind === 'git-repository') owner.domain.verify = [['sh', '-c', 'echo generated > change']];
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'unverified\n');
  runtime.hire = async () => { throw new Error('review must not run'); };
  const result = await proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Author claim' });
  assert.equal(result.outcome, 'needs-work');
  assert.match(result.summary, /verification_changed_source/);
  assert.deepEqual(await deskReviewRounds(runtime, 'clippy', 'example/clippy'), []);
});

test('source changed during review cannot be published with the old evidence', async () => {
  const { runtime } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'reviewed\n');
  scriptHires(runtime, async () => {
    await writeFile(join(desk.path, 'change'), 'changed concurrently\n');
    return verdict;
  });
  await assert.rejects(proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Author claim' }), /review_evidence_stale/);
  assert.deepEqual(await runtime.ledger.list(), []);
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
  const source = await runtime.ledger.create('clippy', 'desk-publication', proposal, {
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
      assert.match(request.brief, /Do not run the repository's test suite or its\nverification commands: host code verifies the result/);
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

test('a failed verification shows the owner the error, not just the last lines of a long test run', async () => {
  const { failedVerificationSummary } = await import('../src/desk-changes.ts');
  const error = 'Failed to create temporary directory: mkdir -p /var/home/bjk/.ansible/tmp';
  const pytest = `${'.'.repeat(3_000)}\n${error}\n${'E   AssertionError\n'.repeat(55)}9 failed, 10 passed`;
  const summary = failedVerificationSummary([
    { command: 'git diff --check', exitCode: 0, output: '' },
    { command: 'python -m pytest -q tests', exitCode: 1, output: pytest },
  ]);
  assert.match(summary, /\$ python -m pytest -q tests \(exit 1\)/);
  assert.ok(summary.includes(error), 'the cause, about 1,000 characters before the end, is kept');
  assert.match(summary, /9 failed, 10 passed/);
  assert.match(summary, /read-only home and private \/tmp/);
  assert.doesNotMatch(summary, /git diff --check/, 'passing commands are left out');
});

/** The base moves on after the desk was made: someone else's commit lands on main. */
async function landUpstream(seed: string, file: string, text: string) {
  await git(seed, ['pull', '-q', 'origin', 'main']);
  await writeFile(join(seed, file), text);
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', `Upstream ${file}`]);
  await git(seed, ['push', '-q', 'origin', 'main']);
  return (await git(seed, ['rev-parse', 'HEAD'])).trim();
}

test('syncing a desk moves it to the base and restores uncommitted work, including intent-to-add files', async () => {
  const { runtime, seed } = await fixture();
  const { syncOwnerDesk } = await import('../src/desk-sync.ts');
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  assert.equal((await syncOwnerDesk(runtime, 'clippy')).outcome, 'current');
  const upstream = await landUpstream(seed, 'upstream.txt', 'from main\n');
  await writeFile(join(desk.path, 'base'), 'base\nmine\n');
  await writeFile(join(desk.path, 'new.txt'), 'new file\n');
  await git(desk.path, ['add', '-A', '--intent-to-add']);
  const synced = await syncOwnerDesk(runtime, 'clippy');
  assert.equal(synced.outcome, 'updated');
  assert.equal((await git(desk.path, ['rev-parse', 'HEAD'])).trim(), upstream);
  assert.equal(await readFile(join(desk.path, 'base'), 'utf8'), 'base\nmine\n');
  assert.equal(await readFile(join(desk.path, 'new.txt'), 'utf8'), 'new file\n');
  assert.equal(await readFile(join(desk.path, 'upstream.txt'), 'utf8'), 'from main\n');
  assert.equal((await git(desk.path, ['stash', 'list'])).trim(), '', 'a clean restore leaves no stash behind');
});

test('a desk checked out on a PR is not synced off it; the refusal names the rebase that brings the PR up to date', async () => {
  const { syncOwnerDesk } = await import('../src/desk-sync.ts');
  const { runtime, root, remote, seed } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'feature'), 'original feature');
  scriptHires(runtime, async () => verdict);
  await fakeGithub(root, remote, async () => {
    await proposeDeskChanges(runtime, 'clippy', { title: 'Feature', summary: 'Add the feature', origin: { sessionID: 'ses_clippy', directory: desk.path } });
    const [source] = await runtime.ledger.list();
    await landUpstream(seed, 'upstream.txt', 'from main\n');
    const { head } = await checkoutPullRequest(runtime, 'clippy', source!.id);
    await assert.rejects(syncOwnerDesk(runtime, 'clippy'), /desk_on_pull_request: .*maintain-prs rebase/);

    await writeFile(join(root, 'github.json'), JSON.stringify({ ...await githubState(root), mergeable: 'CONFLICTING' }));
    const [rebase] = (await maintainPullRequests(runtime, 'clippy')).opened;
    await assert.rejects(syncOwnerDesk(runtime, 'clippy'), new RegExp(`desk_on_pull_request: .*${rebase!.id} is already rebasing it`));
    assert.equal((await git(desk.path, ['rev-parse', 'HEAD'])).trim(), head, 'the desk stays on the PR head');
  });
});

test('a sync that conflicts keeps the work in a stash and names the files; unpublished commits are never moved', async () => {
  const { runtime, seed } = await fixture();
  const { syncOwnerDesk } = await import('../src/desk-sync.ts');
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await landUpstream(seed, 'base', 'theirs\n');
  await writeFile(join(desk.path, 'base'), 'mine\n');
  const conflicted = await syncOwnerDesk(runtime, 'clippy');
  assert.equal(conflicted.outcome, 'conflicts');
  assert.deepEqual(conflicted.conflicts, ['base']);
  assert.match(await readFile(join(desk.path, 'base'), 'utf8'), /<<<<<<<[\s\S]*mine[\s\S]*theirs|<<<<<<<[\s\S]*theirs[\s\S]*mine/);
  assert.ok((await git(desk.path, ['stash', 'list', '--format=%H'])).includes(conflicted.stash!), 'the work is still in its stash');

  const fresh = await fixture();
  const freshDesk = await ensureDesk(fresh.runtime.repositoryOwner('clippy'), fresh.runtime.desksRoot);
  await writeFile(join(freshDesk.path, 'local-only.txt'), 'never pushed\n');
  await git(freshDesk.path, ['add', 'local-only.txt']);
  await git(freshDesk.path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'local only']);
  await landUpstream(fresh.seed, 'upstream.txt', 'x\n');
  await assert.rejects(syncOwnerDesk(fresh.runtime, 'clippy'), /desk_has_unpublished_commits/);
});

test("a desk behind its base is reviewed against where it meets the base, so newer merges don't read as reversions", async () => {
  const { runtime, seed } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await landUpstream(seed, 'upstream.txt', 'merged by someone else\n');
  await writeFile(join(desk.path, 'change'), 'my change\n');
  const briefs: string[] = [];
  scriptHires(runtime, async request => {
    briefs.push(request.brief);
    return { decision: 'revise', summary: 'Stop here', findings: [{ severity: 'blocker', file: 'change', issue: 'x', suggestion: 'y' }] };
  });
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Desk change', summary: 'Update' })).outcome, 'needs-work');
  assert.match(briefs[0]!, /\+my change/);
  assert.doesNotMatch(briefs[0]!, /upstream\.txt/, 'the base\'s newer commit is not shown as removed');
});

interface OpenedSession { directory: string; title: string; text?: string }

/**
 * opencode as the session opener sees it: sessions are recorded with their directory and first message; nothing runs.
 * Each session's activity is scripted: it starts idle, updated when it opened.
 */
function scriptedSessions() {
  const opened: OpenedSession[] = [];
  const activity = new Map<string, SessionActivity>();
  const client: OwnerSessionClient = {
    create: async (directory, title) => {
      opened.push({ directory, title });
      const sessionID = `ses_plan_${opened.length}`;
      activity.set(sessionID, { isBusy: false, updatedAt: Date.now() });
      return sessionID;
    },
    prompt: async (target, _agent, text) => {
      opened[Number(target.sessionID.split('_').at(-1)) - 1]!.text = text;
    },
    remove: async () => {},
    activity: async target => activity.get(target.sessionID) ?? { isBusy: false, updatedAt: undefined },
  };
  return { client, opened, activity };
}

/** Approved plans for clippy, each with its execution session opened the way the plugin opens it. */
async function openPlans(runtime: Runtime, titles: readonly string[]) {
  const sessions = scriptedSessions();
  const items = [];
  for (const title of titles) {
    const submitted = await runtime.ledger.create('clippy', 'owner-change', { ...proposal, title }, {
      status: 'awaiting-plan-approval', planDocument: { markdown: `1. ${title}`, digest: title },
    });
    await approvePlan(runtime, submitted.id, 'person');
    await openOwnerSession(runtime, sessions.client, submitted.id);
    items.push(await runtime.ledger.get(submitted.id));
  }
  return { items, opened: sessions.opened, sessions };
}

const HOUR_MS = 3_600_000;

/** A moment just past the idle limit, from now. */
function pastIdleLimit() {
  return new Date(Date.now() + (PLAN_WORKTREE_LIMITS.idleBeforeRemovalHours + 1) * HOUR_MS);
}

/** Run the plugin's cleanup pass as of `now`; any failure fails the test. */
async function cleanUp(runtime: Runtime, sessions: OwnerSessionClient, now: Date) {
  const failures: unknown[] = [];
  await removeIdlePlanWorktrees(runtime, sessions, (_itemId, error) => failures.push(error), now);
  assert.deepEqual(failures, []);
}

async function pushedFiles(remote: string, branch: string) {
  return (await git(remote, ['ls-tree', '-r', '--name-only', branch])).split('\n').filter(Boolean).sort();
}

test('each approved plan gets its own worktree at the current base, and its execution session opens there', async () => {
  const { runtime, seed } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const upstream = await landUpstream(seed, 'upstream.txt', 'newer base\n');
  const { items: [first, second], opened } = await openPlans(runtime, ['First plan', 'Second plan']);
  assert.ok(first!.planWorktree && second!.planWorktree);
  assert.notEqual(first!.planWorktree, second!.planWorktree);
  assert.equal(first!.planWorktree, join(runtime.plansRoot, 'clippy', first!.id));
  assert.deepEqual(opened.map(session => session.directory), [first!.planWorktree, second!.planWorktree]);
  assert.deepEqual(first!.session, { sessionID: 'ses_plan_1', directory: first!.planWorktree });
  assert.ok(opened[0]!.text!.includes(first!.planWorktree!), 'the first message names the worktree');
  for (const item of [first!, second!]) {
    assert.equal((await git(item.planWorktree!, ['rev-parse', 'HEAD'])).trim(), upstream, 'made from origin/main as it is now');
    assert.equal((await git(item.planWorktree!, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), `plan/${item.id}`);
  }
  await writeFile(join(first!.planWorktree!, 'first.txt'), 'first\n');
  assert.equal(existsSync(join(second!.planWorktree!, 'first.txt')), false);
  assert.equal(existsSync(join(desk.path, 'first.txt')), false);
  assert.equal((await git(desk.path, ['status', '--porcelain'])).trim(), '', 'the desk is untouched');
});

test('proposing one plan publishes only its worktree; the other plan and the desk propose on their own', async () => {
  const { runtime, root, remote } = await fixture();
  const { items: [first, second] } = await openPlans(runtime, ['First plan', 'Second plan']);
  await writeFile(join(first!.planWorktree!, 'first.txt'), 'first\n');
  await writeFile(join(second!.planWorktree!, 'second.txt'), 'second\n');
  const briefs: string[] = [];
  scriptHires(runtime, async request => {
    briefs.push(request.brief);
    return verdict;
  });
  const resetGithub = () => writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, state: 'OPEN' }));
  await fakeGithub(root, remote, async () => {
    const firstResult = await proposeDeskChanges(runtime, 'clippy', { title: 'First', summary: 'First plan', item: first!.id });
    assert.equal(firstResult.outcome, 'opened', firstResult.summary);
    assert.match(briefs[0]!, /\+first/);
    assert.doesNotMatch(briefs[0]!, /second\.txt/, 'the other plan is not in the review');
    const firstPublished = await runtime.ledger.get(first!.id);
    assert.equal(firstPublished.worktree, first!.planWorktree);
    assert.deepEqual(await pushedFiles(remote, firstPublished.branch!), ['base', 'first.txt']);
    assert.equal((await git(second!.planWorktree!, ['status', '--porcelain'])).trim(), '?? second.txt', 'the other plan is untouched');

    const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
    await writeFile(join(desk.path, 'direct.txt'), 'direct\n');
    await resetGithub();
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Direct', summary: 'A small direct change' })).outcome, 'opened');
    const direct = (await runtime.ledger.list()).find(item => item.workflow === 'desk-publication')!;
    assert.deepEqual(await pushedFiles(remote, direct.branch!), ['base', 'direct.txt']);

    await resetGithub();
    const secondResult = await proposeDeskChanges(runtime, 'clippy', { title: 'Second', summary: 'Second plan', item: second!.id });
    assert.equal(secondResult.outcome, 'opened', secondResult.summary);
    assert.deepEqual(await pushedFiles(remote, (await runtime.ledger.get(second!.id)).branch!), ['base', 'second.txt']);
  });
});

test('a plan merged under its grant keeps its worktree and session; the cleanup pass removes it once the session is idle', async () => {
  const { runtime, root, remote } = await fixture();
  runtime.declarations.owners.get('clippy')!.grants.push({ to: 'clippy', action: 'merge', target: 'example/clippy' });
  const { items: [plan], sessions } = await openPlans(runtime, ['Merged plan']);
  const path = plan!.planWorktree!;
  await writeFile(join(path, 'merged.txt'), 'merged\n');
  scriptHires(runtime, async () => verdict);
  await fakeGithub(root, remote, async () => {
    const result = await proposeDeskChanges(runtime, 'clippy', { title: 'Merged', summary: 'Merge it', item: plan!.id });
    assert.equal(result.outcome, 'merged', result.summary);
  });
  const landed = await runtime.ledger.get(plan!.id);
  assert.equal(landed.status, 'landed');
  assert.equal(landed.planWorktree, path, 'the session may still be working there (a rollout)');
  assert.ok(existsSync(path));
  assert.deepEqual(landed.session, { sessionID: 'ses_plan_1', directory: path });

  await cleanUp(runtime, sessions.client, new Date());
  assert.ok(existsSync(path), 'a session active within the limit keeps it');
  sessions.activity.set('ses_plan_1', { isBusy: true, updatedAt: 0 });
  await cleanUp(runtime, sessions.client, pastIdleLimit());
  assert.ok(existsSync(path), 'a busy session keeps it, however long ago it last changed');

  sessions.activity.set('ses_plan_1', { isBusy: false, updatedAt: Date.now() });
  await cleanUp(runtime, sessions.client, pastIdleLimit());
  const cleaned = await runtime.ledger.get(plan!.id);
  assert.equal(existsSync(path), false);
  assert.equal(cleaned.planWorktree, undefined);
  assert.ok((await sessionHistory(runtime, 'clippy')).some(session => session.id === 'ses_plan_1' && session.directory === path));
  assert.deepEqual(cleaned.session, { sessionID: 'ses_plan_1', directory: path }, 'the session keeps its real directory');
  const { workspace } = runtime.repositoryOwner('clippy');
  assert.equal((await git(workspace, ['branch', '--list', `plan/${plan!.id}`])).trim(), '', 'its branch goes with it');
  assert.equal((await journalKinds(runtime, 'clippy')).filter(kind => kind === 'plan-worktree-removed').length, 1);
});

test('a plan merged by the person is noticed on refresh; its worktree stays until its session is idle', async () => {
  const { runtime, root, remote } = await fixture();
  const { items: [plan], sessions } = await openPlans(runtime, ['Person merges']);
  const path = plan!.planWorktree!;
  await writeFile(join(path, 'change'), 'planned\n');
  scriptHires(runtime, async () => verdict);
  await fakeGithub(root, remote, async () => {
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Plan', summary: 'Plan', item: plan!.id })).outcome, 'opened');
    await cleanUp(runtime, sessions.client, pastIdleLimit());
    assert.ok(existsSync(path), 'an open PR keeps its worktree');
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 1, state: 'MERGED' }));
    await refreshPublications(runtime, 'clippy');
  });
  const merged = await runtime.ledger.get(plan!.id);
  assert.equal(merged.publication?.state, 'merged');
  assert.equal(merged.planWorktree, path);
  assert.deepEqual(merged.session, { sessionID: 'ses_plan_1', directory: path });
  assert.ok(existsSync(path), 'the merge alone does not remove it');
  await cleanUp(runtime, sessions.client, pastIdleLimit());
  assert.equal(existsSync(path), false);
  assert.equal((await runtime.ledger.get(plan!.id)).planWorktree, undefined);
});

test('a cancelled plan\'s worktree waits for its idle session, and is never removed while it holds work', async () => {
  const { runtime } = await fixture();
  const { items: [dirty, clean], sessions } = await openPlans(runtime, ['Dirty plan', 'Clean plan']);
  await writeFile(join(dirty!.planWorktree!, 'dirty.txt'), 'unfinished\n');
  await cancelItem(runtime, dirty!.id, 'person', 'Not now');
  await cancelItem(runtime, clean!.id, 'person', 'Not needed');
  assert.ok(existsSync(clean!.planWorktree!), 'cancelling does not remove it at once');
  await cleanUp(runtime, sessions.client, new Date());
  assert.ok(existsSync(clean!.planWorktree!), 'a recently active session keeps it');

  await cleanUp(runtime, sessions.client, pastIdleLimit());
  await cleanUp(runtime, sessions.client, pastIdleLimit());
  assert.equal(existsSync(clean!.planWorktree!), false);
  assert.equal(await readFile(join(dirty!.planWorktree!, 'dirty.txt'), 'utf8'), 'unfinished\n');
  const kept = await runtime.ledger.get(dirty!.id);
  assert.equal(kept.planWorktree, dirty!.planWorktree);
  assert.equal(kept.planWorktreeKept, 'kept-uncommitted');
  const kinds = await journalKinds(runtime, 'clippy');
  assert.equal(kinds.filter(kind => kind === 'plan-worktree-removed').length, 1);
  assert.equal(kinds.filter(kind => kind === 'attention-condition').length, 2, 'one kept condition and one clean completion');
  const attention = (await listAttention(runtime)).find(entry => entry.condition?.key.startsWith(`plan-worktree:${dirty!.id}:`))!;
  assert.equal(attention.status, 'open');
  await changeAttention(runtime, attention.id, 'acknowledged', 'person', 'Will clean later');
  await rm(join(dirty!.planWorktree!, 'dirty.txt'));
  await cleanUp(runtime, sessions.client, pastIdleLimit());
  const cleared = (await listAttention(runtime)).find(entry => entry.id === attention.id)!;
  assert.equal(cleared.status, 'resolved', 'positive filesystem evidence clears even acknowledged condition');
  assert.equal(cleared.decision?.reason, 'Will clean later', 'human acknowledgment history survives');
  assert.equal(cleared.condition?.state, 'resolved');
  const priorGeneration = (await runtime.ledger.get(dirty!.id)).planWorktreeGeneration;
  const update = runtime.ledger.update.bind(runtime.ledger);
  runtime.ledger.update = async (...args) => {
    await update(...args);
    throw new Error('generation_persisted_reply_lost');
  };
  try {
    await assert.rejects(ensurePlanWorktree(runtime, await runtime.ledger.get(dirty!.id)), /generation_persisted_reply_lost/);
  } finally { runtime.ledger.update = update; }
  assert.equal(existsSync(dirty!.planWorktree!), false, 'identity is persisted before the filesystem effect');
  assert.notEqual((await runtime.ledger.get(dirty!.id)).planWorktreeGeneration, priorGeneration);
  await ensurePlanWorktree(runtime, await runtime.ledger.get(dirty!.id));
  const recreated = await runtime.ledger.get(dirty!.id);
  assert.notEqual(recreated.planWorktreeGeneration, priorGeneration);
  await writeFile(join(recreated.planWorktree!, 'new-work.txt'), 'new unfinished work');
  await cleanUp(runtime, sessions.client, pastIdleLimit());
  const later = (await listAttention(runtime)).filter(entry => entry.condition?.key.startsWith(`plan-worktree:${dirty!.id}:`));
  assert.equal(later.length, 2);
  assert.equal(later.filter(entry => entry.status === 'open').length, 1, 'a new workspace generation can raise attention again');
});

test('a plan\'s worktree syncs with its base on its own, keeping its uncommitted work', async () => {
  const { runtime, seed } = await fixture();
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const { items: [plan] } = await openPlans(runtime, ['Sync me']);
  await writeFile(join(plan!.planWorktree!, 'mine.txt'), 'mine\n');
  const upstream = await landUpstream(seed, 'upstream.txt', 'newer\n');
  await assert.rejects(syncPlanWorktree(runtime, 'bellonda', plan!.id), /item_not_yours/);
  const synced = await syncPlanWorktree(runtime, 'clippy', plan!.id);
  assert.equal(synced.outcome, 'updated');
  assert.match(deskSyncText(synced), new RegExp(`worktree for plan ${plan!.id} moved`));
  assert.equal((await git(plan!.planWorktree!, ['rev-parse', 'HEAD'])).trim(), upstream);
  assert.equal(await readFile(join(plan!.planWorktree!, 'mine.txt'), 'utf8'), 'mine\n');
  assert.notEqual((await git(desk.path, ['rev-parse', 'HEAD'])).trim(), upstream, 'the desk is not moved');
});

test('a desk whose commits were squash-merged moves to the base even though no remote holds those commits', async () => {
  const { runtime, seed } = await fixture();
  const { syncOwnerDesk } = await import('../src/desk-sync.ts');
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const commit = (message: string) => git(desk.path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message]);
  await writeFile(join(desk.path, 'base'), 'base\nfirst\n');
  await commit('First part');
  await writeFile(join(desk.path, 'base'), 'base\nfirst\nsecond\n');
  await commit('Second part');
  const squashed = await landUpstream(seed, 'base', 'base\nfirst\nsecond\n');
  const synced = await syncOwnerDesk(runtime, 'clippy');
  assert.equal(synced.outcome, 'updated');
  assert.equal((await git(desk.path, ['rev-parse', 'HEAD'])).trim(), squashed);
});


test('session index failure cannot prevent an approved plan from starting', async () => {
  const { runtime } = await fixture();
  await mkdir(runtime.stateDirectory, { recursive: true });
  await writeFile(join(runtime.stateDirectory, 'session-history'), 'unavailable index');
  const { items: [item], opened } = await openPlans(runtime, ['Approved work survives metadata failure']);
  assert.equal(opened.length, 1);
  assert.ok(opened[0].text?.includes(item.id));
  assert.equal(item.session?.sessionID, 'ses_plan_1');
  assert.equal(item.status, 'working');
});


test('draft publication stays draft under a merge grant, across create and merge checkpoint retries', async () => {
  const { runtime, root, remote } = await fixture();
  runtime.declarations.owners.get('clippy')!.grants.push({ to: 'clippy', action: 'merge', target: 'example/clippy' });
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'draft'), 'requires human merge');
  scriptHires(runtime, async () => verdict);
  await fakeGithub(root, remote, async () => {
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, failCreate: true, state: 'OPEN' }));
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Draft', summary: 'Draft', draft: true })).outcome, 'publication-failed');
    await assert.rejects(proposeDeskChanges(runtime, 'clippy', { title: 'Retry', summary: 'Retry', draft: false }), /publication_mode_conflict/);
    assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Retry', summary: 'Retry' })).outcome, 'opened');
    const [published] = await runtime.ledger.list();
    assert.equal(published!.deskPublication!.draft, true);
    assert.equal(published!.publication!.state, 'open');
    assert.equal((await githubState(root)).state, 'OPEN');
    assert.equal((await runtime.requests.list()).length, 0);
    await runtime.ledger.update(published!.id, current => ({ ...current, status: 'failed', deskPublication: { ...current.deskPublication!, stage: 'merge' } }));
    const { advanceDeskPublication } = await import('../src/desk-changes.ts');
    await advanceDeskPublication(runtime, published!.id);
    assert.equal((await githubState(root)).state, 'OPEN');
    assert.equal((await runtime.ledger.get(published!.id)).deskPublication!.publishRequest, undefined);
  });
});

async function externalFixture() {
  const setup = await fixture();
  const { runtime } = setup;
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  const base = (await git(desk.path, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(desk.path, 'external'), 'externally published change');
  await git(desk.path, ['add', '.']);
  await git(desk.path, ['commit', '-qm', 'External change']);
  const head = (await git(desk.path, ['rev-parse', 'HEAD'])).trim();
  await git(desk.path, ['push', '-q', 'origin', 'HEAD:external']);
  await runtime.notebook('bellonda').ensure('# Charter\n');
  const request = await runtime.requests.open('bellonda', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', planWorktree: desk.path, request: request.id,
    planApproval: { by: 'person', at: new Date().toISOString() }, planDocument: { markdown: 'Preserve this plan', digest: 'original' },
    humanNotes: [{ kind: 'approval', by: 'person', at: '', note: 'Keep original goal' }],
    implementations: [{ report, diffStat: 'earlier evidence', verification: [] }],
  });
  await runtime.requests.save({ ...request, workItem: item.id, status: 'work-running' });
  const external = { html_url: 'https://github.com/example/clippy/pull/1', state: 'open', merged: false, draft: true, auto_merge: null,
    head: { ref: 'external', sha: head, repo: { full_name: 'example/clippy' } },
    base: { ref: 'main', sha: base, repo: { full_name: 'example/clippy' } }, merge_commit_sha: null as string | null };
  return { ...setup, desk, head, base, item, request, external };
}

test('external merged PR reconciliation verifies exact source, preserves intent/history and completes the real request once', async () => {
  const { runtime, root, remote, desk, head, base, item, request, external } = await externalFixture();
  await git(desk.path, ['push', '-q', 'origin', 'HEAD:main']);
  external.merged = true;
  external.state = 'closed';
  external.draft = false;
  external.merge_commit_sha = head;
  runtime.repositoryOwner('clippy').domain.verify.push(['sh', '-c', 'test -f external']);
  let reviews = 0;
  scriptHires(runtime, async hired => {
    reviews += 1;
    assert.match(hired.brief, /Complete the change/);
    assert.match(hired.brief, /It completes/);
    assert.match(hired.brief, /externally published change/);
    assert.match(hired.brief, /host-sandbox/);
    assert.match(hired.brief, /no configured checks ran/);
    assert.match(hired.brief, /does not prove deployment/);
    return verdict;
  });
  await fakeGithub(root, remote, async () => {
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, state: 'MERGED', external }));
    const linked = await reconcileExternalPublication(runtime, 'clippy', item.id, external.html_url, 'person');
    assert.equal(linked.publication!.state, 'merged');
    assert.equal(linked.status, 'landed');
    assert.deepEqual(linked.proposal, item.proposal);
    assert.deepEqual(linked.planDocument, item.planDocument);
    assert.deepEqual(linked.humanNotes, item.humanNotes);
    assert.deepEqual(linked.implementations[0], item.implementations[0]);
    assert.equal(linked.implementations.length, 2);
    assert.equal(linked.externalPublication!.head, head);
    assert.equal(linked.externalPublication!.base, base);
    assert.equal(linked.externalPublication!.evidence.tree, (await git(desk.path, ['rev-parse', 'HEAD^{tree}'])).trim());
    assert.equal(linked.externalPublication!.evidence.checks[0]!.exitCode, 0);
    assert.equal(linked.externalPublication!.evidence.checks[0]!.command, 'sh');
    assert.equal(linked.deskPublication, undefined);
    const retried = await reconcileExternalPublication(runtime, 'clippy', item.id, external.html_url, 'person');
    assert.equal(reviews, 1);
    assert.equal(retried.implementations.length, 2);
    const { trackDelegatedWork } = await import('../src/delegation.ts');
    assert.equal((await trackDelegatedWork(runtime, await runtime.requests.get(request.id))).status, 'completed');
    assert.equal((await githubState(root)).created, 0);
  });
});

test('external linkage rejects wrong authority, remote scope, dirty/head changes and unmet review without altering goal or completion', async () => {
  const { runtime, root, remote, desk, item, external } = await externalFixture();
  await fakeGithub(root, remote, async () => {
    const save = async () => writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, state: 'OPEN', external }));
    await save();
    const reconcile = () => reconcileExternalPublication(runtime, 'clippy', item.id, external.html_url, 'person');
    await assert.rejects(reconcileExternalPublication(runtime, 'bellonda', item.id, external.html_url, 'person'), /item_not_yours/);
    await assert.rejects(reconcileExternalPublication(runtime, 'clippy', item.id, 'https://github.com/elsewhere/repo/pull/1', 'person'), /external_pr_repository_mismatch/);
    external.draft = false;
    await save();
    await assert.rejects(reconcile(), /external_pr_requires_draft/);
    external.draft = true;
    await save();
    await writeFile(join(desk.path, 'dirty'), 'dirty');
    await assert.rejects(reconcile(), /external_pr_worktree_dirty/);
    await rm(join(desk.path, 'dirty'));
    const head = external.head.sha;
    external.head.sha = external.base.sha;
    await save();
    await assert.rejects(reconcile(), /external_pr_head_mismatch/);
    external.head.sha = head;
    await save();
    scriptHires(runtime, async () => ({ decision: 'revise', summary: 'Needs correction', findings: [{ severity: 'blocker', file: 'external', issue: 'Missing behavior', suggestion: 'Implement it' }] }));
    await assert.rejects(reconcile(), /external_review_needs_work/);
    const unchanged = await runtime.ledger.get(item.id);
    assert.equal(unchanged.status, 'working');
    assert.equal(unchanged.activeRunner, undefined);
    assert.equal(unchanged.publication, undefined);
    assert.deepEqual(unchanged.proposal, item.proposal);
  });
});


test('external reconciliation refuses approval/runner races and changed PR evidence, then links a draft without completing the request', async () => {
  const { runtime, root, remote, item, request, external } = await externalFixture();
  await fakeGithub(root, remote, async () => {
    const save = () => writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, state: 'OPEN', external }));
    const reconcile = () => reconcileExternalPublication(runtime, 'clippy', item.id, external.html_url, 'person');
    await save();
    await runtime.ledger.update(item.id, current => ({ ...current, activeRunner: process.pid }));
    await assert.rejects(reconcile(), /work_item_active/);
    await runtime.ledger.update(item.id, current => ({ ...current, activeRunner: undefined, planApproval: undefined }));
    await assert.rejects(reconcile(), /external_pr_requires_approved_request/);
    await runtime.ledger.update(item.id, current => ({ ...current, planApproval: item.planApproval }));
    scriptHires(runtime, async () => {
      external.head.sha = external.base.sha;
      await save();
      return verdict;
    });
    const head = external.head.sha;
    await assert.rejects(reconcile(), /external_pr_changed_during_review/);
    assert.equal((await runtime.ledger.get(item.id)).publication, undefined);
    external.head.sha = head;
    await save();
    scriptHires(runtime, async () => verdict);
    const linked = await reconcile();
    assert.equal(linked.publication!.state, 'open');
    const { trackDelegatedWork } = await import('../src/delegation.ts');
    assert.equal((await trackDelegatedWork(runtime, await runtime.requests.get(request.id))).status, 'work-running');
    external.merged = true;
    external.state = 'closed';
    external.draft = false;
    external.merge_commit_sha = head;
    await save();
    const beforeRefusal = await runtime.ledger.get(item.id);
    await assert.rejects(reconcile(), /external_pr_merge_not_in_base/);
    assert.deepEqual(await runtime.ledger.get(item.id), beforeRefusal);
    await git(runtime.repositoryOwner('clippy').workspace, ['push', '-q', 'origin', `${head}:main`]);
    const merged = await reconcile();
    assert.equal(merged.publication!.state, 'merged');
    assert.equal(merged.externalPublication!.mergeCommit, head);
    assert.equal(merged.implementations.length, linked.implementations.length);
    assert.deepEqual(linked.proposal, item.proposal);
    assert.equal((await githubState(root)).created, 0);
  });
});


test('first external reconciliation refuses an unreachable merge without changing the request or work item', async () => {
  const { runtime, root, remote, head, item, request, external } = await externalFixture();
  external.merged = true;
  external.state = 'closed';
  external.draft = false;
  external.merge_commit_sha = head;
  scriptHires(runtime, async () => { throw new Error('ancestry refusal must precede review'); });
  await fakeGithub(root, remote, async () => {
    await writeFile(join(root, 'github.json'), JSON.stringify({ created: 0, state: 'MERGED', external }));
    const priorItem = await runtime.ledger.get(item.id);
    const priorRequest = await runtime.requests.get(request.id);
    await assert.rejects(
      reconcileExternalPublication(runtime, 'clippy', item.id, external.html_url, 'person'),
      /external_pr_merge_not_in_base/,
    );
    assert.deepEqual(await runtime.ledger.get(item.id), priorItem);
    assert.deepEqual(await runtime.requests.get(request.id), priorRequest);
  });
});
||||||| parent of 919b7f6 (feat: expose scoped host evidence in delegated request progress)

test('delegated host checks and review become request-scoped interim evidence without waking or publishing', async () => {
  const { requestProgressDetail, noticeRequestProgress } = await import('../src/request-status.ts');
  const { readRequestWorkEvidence } = await import('../src/request-work-evidence.ts');
  const { agentConfig } = await import('../src/opencode.ts');
  const { runtime } = await fixture();
  const request = await runtime.requests.open('odrade', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none',
    { sessionID: 'odrade-origin', directory: '/fixture/odrade' });
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', request: request.id,
    planDocument: { markdown: 'Approved method', digest: 'original-plan' } });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id }));
  const fail = (_id: string, error: unknown): never => { throw error; };
  await noticeRequestProgress(runtime, fail);
  const owner = runtime.declarations.owners.get('clippy')!;
  if (owner.domain.kind === 'git-repository') owner.domain.verify = [['sh', '-c', 'echo private-test-output; true']];
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'candidate\n');
  let reviews = 0;
  scriptHires(runtime, async hire => {
    reviews++;
    assert.equal(hire.role, 'reviewer');
    const status = await requestProgressDetail(runtime, 'odrade', request.id);
    const evidence = (await readRequestWorkEvidence(runtime, item)).verification!;
    assert.match(status, /Host attempt: reviewing/);
    assert.match(status, /#1 sh exit=0/);
    assert.match(status, /no completed review/);
    assert.ok(status.includes(evidence.tree));
    assert.ok(hire.brief.includes(JSON.stringify(evidence)), 'requester and reviewer see the same host evidence');
    assert.ok(hire.brief.includes(proposal.acceptance[0]!));
    assert.doesNotMatch(status, /private-test-output/);
    assert.equal(await noticeRequestProgress(runtime, fail), 1);
    assert.equal(await noticeRequestProgress(runtime, fail), 0);
    const agents = agentConfig(desk.path, runtime.toolsDirectory, undefined).agent;
    assert.deepEqual(agents['onionsoup-reviewer']!.permission.read, agents['onionsoup-implementer']!.permission.read);
    return revise('A required live prerequisite is missing');
  });
  const outcome = await proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Claim', item: item.id });
  assert.equal(outcome.outcome, 'needs-work');
  const status = await requestProgressDetail(runtime, 'odrade', request.id);
  assert.match(status, /Review by .*: revise/);
  assert.match(status, /\[blocker\].*required live prerequisite/);
  assert.match(status, /current workspace, deployment and goal completion are unknown/);
  assert.equal(await requestProgressDetail(runtime, 'moneo', request.id), 'No visible request with that ID.');
  assert.equal(await noticeRequestProgress(runtime, fail), 1);
  assert.equal(await noticeRequestProgress(runtime, fail), 0);
  assert.equal(reviews, 1);
  assert.equal((await runtime.requests.list()).length, 1);
  assert.equal((await runtime.ledger.get(item.id)).publication, undefined);
  await runtime.ledger.update(item.id, current => ({ ...current, planDocument: { markdown: 'New method', digest: 'new-plan' } }));
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /Host attempt: reviewed; superseded/);
});

test('failed host verification records its blocker without exposing output or hiring a reviewer', async () => {
  const { requestProgressDetail } = await import('../src/request-status.ts');
  const { runtime } = await fixture();
  const request = await runtime.requests.open('odrade', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', request: request.id });
  await runtime.requests.update(request.id, current => ({ ...current, workItem: item.id, status: 'work-running' }));
  const owner = runtime.declarations.owners.get('clippy')!;
  if (owner.domain.kind === 'git-repository') owner.domain.verify = [['sh', '-c', 'echo private-failure-output; echo changed > change; exit 7']];
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'candidate\n');
  runtime.hire = async () => { throw new Error('must_not_hire'); };
  assert.equal((await proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Claim', item: item.id })).outcome, 'needs-work');
  const status = await requestProgressDetail(runtime, 'odrade', request.id);
  assert.match(status, /Host blocker: host_verification_failed/);
  assert.doesNotMatch(status, /verification_changed_source/);
  assert.match(status, /#1 sh exit=7/);
  assert.doesNotMatch(status, /private-failure-output/);
});

test('evidence storage failures preserve successful review and publication outcomes with safe diagnostics', async () => {
  const { requestProgressDetail } = await import('../src/request-status.ts');
  const { runtime, root, remote } = await fixture();
  const request = await runtime.requests.open('odrade', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', request: request.id });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id }));
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'candidate\n');
  await writeFile(join(runtime.stateDirectory, 'request-work-evidence'), 'unavailable storage');
  scriptHires(runtime, async () => verdict);
  await fakeGithub(root, remote, async () => {
    const outcome = await proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Claim', item: item.id });
    assert.equal(outcome.outcome, 'opened');
  });
  const saved = await runtime.ledger.get(item.id);
  assert.equal(saved.verdicts[0]?.decision, 'approve');
  assert.equal(saved.publication?.state, 'open');
  assert.match(await requestProgressDetail(runtime, 'odrade', request.id), /Host tests\/review: unavailable/);
  assert.ok((await journalKinds(runtime, 'clippy')).includes('request_work_evidence_write_failed'));
});

test('evidence storage failure cannot replace the original reviewer error', async () => {
  const { runtime } = await fixture();
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', request: 'r-fixture' });
  const desk = await ensureDesk(runtime.repositoryOwner('clippy'), runtime.desksRoot);
  await writeFile(join(desk.path, 'change'), 'candidate\n');
  await writeFile(join(runtime.stateDirectory, 'request-work-evidence'), 'unavailable storage');
  const original = new Error('fixture_review_transport_failed');
  runtime.hire = async () => { throw original; };
  await assert.rejects(proposeDeskChanges(runtime, 'clippy', { title: 'Patch', summary: 'Claim', item: item.id }), error => error === original);
});
