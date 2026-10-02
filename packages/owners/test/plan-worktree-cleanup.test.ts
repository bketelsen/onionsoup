import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { ensurePlanWorktree, removeIdlePlanWorktrees } from '../src/plan-worktrees.ts';
import { rememberSession, sessionHistory } from '../src/session-history.ts';
import { git } from '../src/workspace.ts';
import { listAttention } from '../src/attention.ts';
import { needsHumanDecision } from '../src/attention-routing.ts';
import type { WorkItem } from '../src/ledger.ts';
import { ownerSessionClient, type OwnerSessionClient } from '../src/owner-sessions.ts';
import type { MaintenanceContext } from '../src/maintenance-context.ts';

const proposal = { title: 'Terminal plan', goal: 'Retain intent', rationale: 'Regression', acceptance: ['Safe cleanup'], size: 'small' as const };
const idle = { activity: async () => ({ isBusy: false, updatedAt: 0 }) };
const validation = Array.from({ length: 26 }, (_, index) => `Validation rule ${index + 1}\n`).join('');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-cleanup-'));
  const remote = join(root, 'origin');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  const seed = join(root, 'seed');
  await git(root, ['clone', '-q', remote, seed]);
  await git(seed, ['config', 'user.name', 'Fixture']);
  await git(seed, ['config', 'user.email', 'fixture@example.invalid']);
  await mkdir(join(seed, 'docs'));
  await writeFile(join(seed, 'docs', 'validation.md'), validation);
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-qm', 'Initial validation']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  const owner = runtime.owner('clippy');
  runtime.declarations.owners.set(owner.id, {
    ...owner, workspace: join(root, 'checkout'),
    domain: { kind: 'git-repository', name: 'example/clippy', remote, baseBranch: 'main', verify: [] },
  });
  await runtime.notebook(owner.id).ensure('# Charter\n');
  return { root, runtime, seed };
}

async function plan(runtime: Runtime, status: WorkItem['status'] = 'cancelled') {
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status });
  const { path } = await ensurePlanWorktree(runtime, item);
  await runtime.ledger.update(item.id, current => ({ ...current, session: { sessionID: `ses_${item.id}`, directory: path } }));
  return runtime.ledger.get(item.id);
}

async function commit(path: string, message: string) {
  await git(path, ['add', '-A']);
  await git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]);
  return (await git(path, ['rev-parse', 'HEAD'])).trim();
}

async function cleanup(runtime: Runtime, sessions: Pick<OwnerSessionClient, 'activity'> = idle, now = new Date()) {
  const errors: unknown[] = [];
  await removeIdlePlanWorktrees(runtime, sessions, (_id, error) => errors.push(error), now);
  assert.deepEqual(errors, []);
}

test('squash-contained clean terminal commits need no archive and disappear after retention', async () => {
  const { runtime, seed } = await fixture();
  const item = await plan(runtime);
  const path = item.planWorktree!;
  await writeFile(join(path, 'change'), 'first\n');
  await commit(path, 'First change');
  await writeFile(join(path, 'change'), 'first\nsecond\n');
  const head = await commit(path, 'Second change');
  await writeFile(join(seed, 'change'), 'first\nsecond\n');
  await commit(seed, 'Squash landed');
  await git(seed, ['push', '-q', 'origin', 'main']);
  await git(path, ['fetch', '-q', 'origin']);
  assert.ok((await git(path, ['rev-list', head, '--not', '--remotes'])).trim(), 'no remote holds the source commits');
  await cleanup(runtime);
  const cleaned = await runtime.ledger.get(item.id);
  assert.equal(existsSync(path), false);
  assert.equal(cleaned.planWorktreeArchives, undefined);
  assert.equal((await git(runtime.owner(item.owner).workspace, ['branch', '--list', `plan/${item.id}`])).trim(), '');
  assert.equal((await sessionHistory(runtime, item.owner))[0]?.archived, true);
});

test('Homelab-style post-landing deletion of 26 validation lines is unique intent, not landed containment', async () => {
  const { runtime, seed } = await fixture();
  const item = await plan(runtime, 'landed');
  const path = item.planWorktree!;
  await writeFile(join(path, 'landed'), 'approved change\n');
  await commit(path, 'Approved change');
  await writeFile(join(seed, 'landed'), 'approved change\n');
  const landed = await commit(seed, 'Landed squash (07c38a06 shape)');
  await git(seed, ['push', '-q', 'origin', 'main']);
  await git(path, ['fetch', '-q', 'origin']);
  await rm(join(path, 'docs', 'validation.md'));
  const unique = await commit(path, 'Delete 26 validation lines (a3cb8f7 shape)');
  await runtime.ledger.update(item.id, current => ({ ...current, landedCommit: landed }));
  await rememberSession(runtime, {
    id: item.session!.sessionID, owner: item.owner, directory: path, title: 'Homelab rollout notes', time: { created: 1, updated: 2 },
  });
  await cleanup(runtime);
  const cleaned = await runtime.ledger.get(item.id);
  const archive = cleaned.planWorktreeArchives?.find(saved => saved.commit === unique);
  assert.ok(archive, 'unique clean intent must have a named durable archive');
  assert.equal(archive.base, landed);
  assert.match(archive.ref, /^refs\/onionsoup\/archive\/plans\/clippy\//);
  assert.equal(existsSync(path), false);
  assert.equal(cleaned.session?.directory, path);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  assert.deepEqual((await reopened.ledger.get(item.id)).planWorktreeArchives, cleaned.planWorktreeArchives);
  const workspace = runtime.owner(item.owner).workspace;
  await git(workspace, ['reflog', 'expire', '--expire=now', '--all']);
  await git(workspace, ['gc', '--prune=now']);
  assert.equal((await git(workspace, ['rev-parse', archive.ref])).trim(), unique);
  assert.match(await git(workspace, ['show', '--format=', '--numstat', archive.ref]), /0\t26\tdocs\/validation.md/);
  assert.equal((await git(workspace, ['show', `${archive.base}:docs/validation.md`])), validation);
  const history = await sessionHistory(reopened, item.owner);
  assert.equal(history[0]?.title, 'Homelab rollout notes');
  assert.equal(history[0]?.archived, true);
});

test('remote-held unique commits are archived too; remote reachability alone cannot authorize removal', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  await writeFile(join(item.planWorktree!, 'unique'), 'not on main\n');
  const head = await commit(item.planWorktree!, 'Unique but published');
  await git(item.planWorktree!, ['push', '-q', 'origin', 'HEAD:published']);
  await cleanup(runtime);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeArchives?.[0]?.commit, head);
});

test('a separate unique plan branch tip is archived before branch removal even when the current HEAD is contained', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  await writeFile(join(item.planWorktree!, 'branch-intent'), 'unique plan branch\n');
  const planTip = await commit(item.planWorktree!, 'Original plan intent');
  await git(item.planWorktree!, ['checkout', '-qb', `owners/${item.id}`, 'origin/main']);
  await cleanup(runtime);
  const cleaned = await runtime.ledger.get(item.id);
  assert.equal(cleaned.planWorktreeArchives?.[0]?.commit, planTip);
  const workspace = runtime.owner(item.owner).workspace;
  assert.equal((await git(workspace, ['branch', '--list', `plan/${item.id}`])).trim(), '');
  assert.equal(await git(workspace, ['show', `${cleaned.planWorktreeArchives![0]!.ref}:branch-intent`]), 'unique plan branch\n');
});

test('unknown base and a newly active generation keep the workspace with concrete owner evidence', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  const changed = { activity: async () => {
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'working' }));
    return { isBusy: false, updatedAt: 0 };
  } };
  await cleanup(runtime, changed);
  assert.equal(existsSync(item.planWorktree!), true);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeKept, 'failed');
  assert.match((await listAttention(runtime))[0]!.note, /plan_worktree_cleanup_scope_changed/);
  await runtime.ledger.update(item.id, current => ({ ...current, status: 'cancelled', planWorktreeKept: undefined }));
  await git(item.planWorktree!, ['update-ref', '-d', 'refs/remotes/origin/main']);
  await cleanup(runtime);
  assert.equal(existsSync(item.planWorktree!), true);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeArchives, undefined);
});

test('a workspace generation changed before the final ledger write cannot be forgotten by stale cleanup', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  const update = runtime.ledger.update.bind(runtime.ledger);
  runtime.ledger.update = async (id, change) => {
    const current = await runtime.ledger.get(id);
    const candidate = change(current);
    if (current.planWorktree && candidate.planWorktree === undefined) {
      await update(id, saved => ({ ...saved, planWorktreeGeneration: 'new-generation' }));
    }
    return update(id, change);
  };
  await cleanup(runtime);
  const kept = await runtime.ledger.get(item.id);
  assert.equal(kept.planWorktree, item.planWorktree);
  assert.equal(kept.planWorktreeGeneration, 'new-generation');
  assert.equal(kept.planWorktreeKept, 'failed');
});

test('dirty tracked and nested untracked work stay with an owner reason, not a housekeeping gate', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  await writeFile(join(item.planWorktree!, 'docs', 'validation.md'), 'unfinished tracked edit\n');
  await mkdir(join(item.planWorktree!, 'notes'));
  await writeFile(join(item.planWorktree!, 'notes', 'intent'), 'unfinished untracked intent\n');
  await cleanup(runtime);
  await cleanup(runtime);
  const kept = await runtime.ledger.get(item.id);
  assert.equal(kept.planWorktreeKept, 'kept-uncommitted');
  assert.equal(kept.planWorktreeArchives, undefined);
  assert.equal(await readFile(join(item.planWorktree!, 'notes', 'intent'), 'utf8'), 'unfinished untracked intent\n');
  const attention = await listAttention(runtime);
  assert.equal(attention.length, 1);
  assert.equal(needsHumanDecision(attention[0]!), false);
  assert.match(attention[0]!.note, /Owner maintenance.*uncommitted/);
});

test('ordinary Git removal deletes ignored data; public cleanup retains ignored private notes', async () => {
  const { root, runtime, seed } = await fixture();
  const ignoredCaches = ['.ansible', '.pytest_cache', '__pycache__'];
  await writeFile(join(seed, '.gitignore'), ['.env', 'private-notes/', ...ignoredCaches.map(name => `${name}/`)].join('\n') + '\n');
  await commit(seed, 'Ignore private local files');
  await git(seed, ['push', '-q', 'origin', 'main']);
  const item = await plan(runtime);
  const workspace = runtime.owner(item.owner).workspace;
  const disposable = join(root, 'ordinary-removal');
  await git(workspace, ['worktree', 'add', '-q', '--detach', disposable, 'origin/main']);
  await writeFile(join(disposable, '.env'), 'fixture-only private intent\n');
  assert.equal((await git(disposable, ['status', '--porcelain', '--untracked-files=all'])).trim(), '');
  await git(workspace, ['worktree', 'remove', disposable]);
  assert.equal(existsSync(disposable), false, 'ordinary Git removal does not protect ignored files');

  const path = item.planWorktree!;
  await writeFile(join(path, 'unique'), 'unique terminal intent\n');
  await commit(path, 'Unique terminal intent before ignored files');
  await writeFile(join(path, '.env'), 'fixture-only private intent\n');
  await mkdir(join(path, 'private-notes'));
  await writeFile(join(path, 'private-notes', 'intent'), 'keep these local notes\n');
  for (const directory of ignoredCaches) {
    await mkdir(join(path, directory));
    await writeFile(join(path, directory, 'x'), 'keep ignored local data\n');
  }
  await cleanup(runtime);
  const kept = await runtime.ledger.get(item.id);
  assert.equal(kept.planWorktree, path);
  assert.equal(kept.planWorktreeKept, 'kept-uncommitted');
  assert.equal(kept.planWorktreeArchives, undefined, 'ignored data blocks cleanup before unique-commit archival');
  assert.equal((await git(path, ['for-each-ref', '--format=%(refname)', 'refs/onionsoup/archive/plans'])).trim(), '');
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'fixture-only private intent\n');
  assert.equal(await readFile(join(path, 'private-notes', 'intent'), 'utf8'), 'keep these local notes\n');
  for (const directory of ignoredCaches) {
    assert.equal(await readFile(join(path, directory, 'x'), 'utf8'), 'keep ignored local data\n');
  }
  assert.equal((await sessionHistory(runtime, item.owner))[0]?.archived, false);
  const attention = await listAttention(runtime);
  assert.equal(attention.length, 1);
  assert.equal(needsHumanDecision(attention[0]!), false);
});

test('a late ignored edit retains live session metadata after archiving the terminal commit', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  const path = item.planWorktree!;
  await writeFile(join(path, 'unique'), 'preserve terminal intent\n');
  await writeFile(join(path, '.gitignore'), '.pytest_cache/\n');
  const head = await commit(path, 'Unique terminal work');
  await rememberSession(runtime, {
    id: item.session!.sessionID, owner: item.owner, directory: path,
    title: 'Still-live rollout', time: { created: 1, updated: 2 },
  });
  await rememberSession(runtime, {
    id: 'ses_live_child', parentID: item.session!.sessionID, owner: item.owner, directory: path,
    title: 'Still-live child', time: { created: 1, updated: 2 },
  });
  const update = runtime.ledger.update.bind(runtime.ledger);
  let hasWrittenLateNote = false;
  runtime.ledger.update = async (id, change) => {
    const saved = await update(id, change);
    if (saved.planWorktreeArchives?.length && !hasWrittenLateNote) {
      hasWrittenLateNote = true;
      await mkdir(join(path, '.pytest_cache'));
      await writeFile(join(path, '.pytest_cache', 'x'), 'new ignored intent\n');
    }
    return saved;
  };
  await cleanup(runtime);
  const kept = await runtime.ledger.get(item.id);
  assert.equal(kept.planWorktreeKept, 'kept-uncommitted');
  assert.equal(kept.planWorktreeArchives?.[0]?.commit, head);
  assert.equal(await readFile(join(path, '.pytest_cache', 'x'), 'utf8'), 'new ignored intent\n');
  const history = await sessionHistory(runtime, item.owner);
  assert.equal(history.length, 2);
  assert.ok(history.every(session => !session.archived));
  assert.deepEqual(history.map(session => session.title).sort(), ['Still-live child', 'Still-live rollout']);
  let activityCalls = 0;
  await cleanup(runtime, { activity: async () => {
    activityCalls += 1;
    return { isBusy: true, updatedAt: 0 };
  } });
  assert.equal(activityCalls, 1, 'retained execution remains eligible for real activity observation');
});

test('a refused Git worktree removal preserves live metadata until successful retirement', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  const path = item.planWorktree!;
  const workspace = runtime.owner(item.owner).workspace;
  await writeFile(join(path, 'unique'), 'preserve intent through failed removal\n');
  const head = await commit(path, 'Unique terminal work');
  await git(workspace, ['worktree', 'lock', '--reason', 'Fixture removal veto', path]);
  await cleanup(runtime);
  const kept = await runtime.ledger.get(item.id);
  assert.equal(kept.planWorktreeKept, 'failed');
  assert.equal(kept.planWorktreeArchives?.[0]?.commit, head);
  assert.equal(existsSync(path), true);
  assert.equal((await sessionHistory(runtime, item.owner))[0]?.archived, false);
  assert.equal(needsHumanDecision((await listAttention(runtime))[0]!), false);
  let activityCalls = 0;
  await cleanup(runtime, { activity: async target => {
    assert.equal(target.directory, path);
    activityCalls += 1;
    return { isBusy: true, updatedAt: 0 };
  } });
  assert.equal(activityCalls, 1, 'failed removal cannot suppress the next real busy-session probe');
  assert.equal(existsSync(path), true);
  await git(workspace, ['worktree', 'unlock', path]);
  await cleanup(runtime);
  assert.equal(existsSync(path), false);
  assert.equal((await sessionHistory(runtime, item.owner))[0]?.archived, true);
  assert.equal((await runtime.ledger.get(item.id)).planWorktree, undefined);
});

test('a failed branch-removal checkpoint cannot retire metadata after only the directory was removed', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  const path = item.planWorktree!;
  await writeFile(join(path, 'unique'), 'preserve terminal branch intent\n');
  await commit(path, 'Unique terminal branch intent');
  const context: MaintenanceContext = {
    signal: new AbortController().signal,
    check: () => {
      if (!existsSync(path)) throw new Error('fixture_branch_removal_not_admitted');
    },
    phase: async (_name, operation) => operation(),
  };
  await removeIdlePlanWorktrees(runtime, idle, () => {}, new Date(), context);
  assert.equal(existsSync(path), false);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeKept, 'failed');
  assert.equal((await sessionHistory(runtime, item.owner))[0]?.archived, false);
  const workspace = runtime.owner(item.owner).workspace;
  assert.equal(await git(workspace, ['show', `refs/heads/plan/${item.id}:unique`]), 'preserve terminal branch intent\n');
});

test('archive or history persistence failure retains the tree; a retry reuses the exact durable ref', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  await writeFile(join(item.planWorktree!, 'unique'), 'retain through failed metadata\n');
  const head = await commit(item.planWorktree!, 'Unique work');
  await writeFile(join(runtime.stateDirectory, 'session-history'), 'index unavailable');
  const historyErrors: unknown[] = [];
  await removeIdlePlanWorktrees(runtime, idle, (_id, error) => historyErrors.push(error));
  assert.equal(historyErrors.length, 1);
  const kept = await runtime.ledger.get(item.id);
  assert.equal(kept.planWorktreeKept, 'failed');
  assert.equal(existsSync(item.planWorktree!), true);
  // The initial history read fails closed before any cleanup side effects.
  assert.equal(kept.planWorktreeArchives, undefined);
  await rm(join(runtime.stateDirectory, 'session-history'));
  const update = runtime.ledger.update.bind(runtime.ledger);
  runtime.ledger.update = async (id, change) => update(id, current => {
    const next = change(current);
    if (next.planWorktreeArchives?.length) throw new Error('archive_metadata_unavailable');
    return next;
  });
  await cleanup(runtime);
  assert.equal(existsSync(item.planWorktree!), true);
  const workspace = runtime.owner(item.owner).workspace;
  assert.match(await git(workspace, ['for-each-ref', '--format=%(objectname)', 'refs/onionsoup/archive/plans']), new RegExp(head));
  runtime.ledger.update = update;
  await cleanup(runtime);
  assert.equal(existsSync(item.planWorktree!), false);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeArchives?.length, 1);
});

test('ten recent terminal trees are ordinary retention; busy, unknown and resumable work are not removed', async () => {
  const { runtime } = await fixture();
  const items = await Promise.all(Array.from({ length: 10 }, async () => {
    // Git worktree registration is serialized in normal host use.
    return runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'cancelled' });
  }));
  for (const item of items) await ensurePlanWorktree(runtime, item);
  const recent = { activity: async () => ({ isBusy: false, updatedAt: Date.now() }) };
  await cleanup(runtime, recent);
  assert.equal((await runtime.ledger.list()).filter(item => item.planWorktree).length, 10);
  assert.deepEqual(await listAttention(runtime), []);
  const failed = await plan(runtime, 'failed');
  const busy = await plan(runtime);
  const sessions = { activity: async () => ({ isBusy: true, updatedAt: 0 }) };
  await cleanup(runtime, sessions);
  assert.equal(existsSync(busy.planWorktree!), true);
  assert.equal(existsSync(failed.planWorktree!), true);
  const unknown = { activity: async () => { throw new Error('owner_session_status_failed'); } };
  const errors: unknown[] = [];
  await removeIdlePlanWorktrees(runtime, unknown, (_id, error) => errors.push(error));
  assert.ok(errors.length);
  assert.equal(existsSync(busy.planWorktree!), true);
});

test('absent or already archived workspaces never enter the activity SDK or revive a retired directory', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  await rememberSession(runtime, {
    id: item.session!.sessionID, directory: item.planWorktree!, owner: item.owner, archived: true,
    title: 'Retired execution', time: { created: 1, updated: 1 },
  });
  const neverProbe = { activity: async () => { throw new Error('retired_directory_probed'); } };
  await runtime.ledger.update(item.id, current => ({ ...current, updatedAt: '2000-01-01T00:00:00.000Z' }));
  await cleanup(runtime, neverProbe, new Date('2100-01-01T00:00:00.000Z'));
  assert.equal(existsSync(item.planWorktree!), false);
  const missing = await plan(runtime);
  await git(runtime.owner(item.owner).workspace, ['worktree', 'remove', missing.planWorktree!]);
  await cleanup(runtime, neverProbe, new Date('2100-01-01T00:00:00.000Z'));
  assert.equal((await runtime.ledger.get(missing.id)).planWorktree, undefined);
});

test('the public SDK cleanup seam keeps busy children and unknown directory activity, not only the idle parent', async () => {
  const { runtime } = await fixture();
  const item = await plan(runtime);
  let directoryStatus: Record<string, { type: string }> | undefined = { ses_child: { type: 'retry' } };
  const sdk = { session: {
    status: async () => ({ data: directoryStatus }),
    get: async () => ({ data: { time: { updated: 0 } } }),
  } } as unknown as Parameters<typeof ownerSessionClient>[0];
  const sessions = ownerSessionClient(sdk);
  await cleanup(runtime, sessions);
  assert.equal(existsSync(item.planWorktree!), true);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeKept, undefined);
  directoryStatus = { ses_child: { type: 'unrecognized' } };
  const errors: unknown[] = [];
  await removeIdlePlanWorktrees(runtime, sessions, (_id, error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.equal((await runtime.ledger.get(item.id)).planWorktreeKept, 'failed');
  assert.match((await listAttention(runtime))[0]!.note, /owner_session_status_invalid/);
  directoryStatus = {};
  await cleanup(runtime, sessions);
  assert.equal((await runtime.ledger.get(item.id)).planWorktree, undefined);
  assert.equal((await sessionHistory(runtime, item.owner))[0]?.archived, true);
});
