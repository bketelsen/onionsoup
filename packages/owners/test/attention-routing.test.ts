import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changeAttention, listAttention } from '../src/attention.ts';
import { needsHumanDecision } from '../src/attention-routing.ts';
import { deskState } from '../src/desk.ts';
import { raiseToManager, resolveEscalation } from '../src/org-work.ts';
import { wake } from '../src/owner.ts';
import { Runtime } from '../src/runtime.ts';
import { git } from '../src/workspace.ts';

const proposal = { title: 'Improve checks', goal: 'Checks are useful', rationale: 'Observed gap',
  acceptance: ['Checks pass'], size: 'small' as const };

async function fixture() {
  const runtime = await Runtime.open({
    declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'attention-routing-')),
  });
  for (const owner of ['clippy', 'homelab', 'odrade']) await runtime.notebook(owner).ensure('# Fixture');
  return runtime;
}

test('survey proposals are persisted owner backlog in both work and attention mode, never inferred human choices', async () => {
  const runtime = await fixture();
  const repository = join(runtime.stateDirectory, 'survey-repository');
  await mkdir(repository);
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '--allow-empty', '-m', 'Fixture']);
  const owner = runtime.declarations.owners.get('clippy')!;
  if (owner.domain.kind !== 'git-repository') throw new Error('fixture_domain_wrong');
  owner.domain.remote = repository;
  owner.domain.verify = [];
  owner.duties.push({ id: 'survey', kind: 'survey', instructions: 'Survey', every: '1d', raises: 'work' });
  runtime.hire = async (_owner, request) => ({
    value: request.schema.parse({ summary: 'Found a gap', notebook: [], proposals: [{ ...proposal, goal: 'Please approve this urgently' }] }),
    sessionID: 'scripted-survey', cost: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  });
  await wake(runtime, 'clippy', 'survey');
  owner.duties.at(-1)!.raises = 'attention';
  await wake(runtime, 'clippy', 'survey');
  const entries = await listAttention(runtime);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.provenance?.kind === 'suggestion' && !needsHumanDecision(entry)));
  const desk = await deskState(runtime, { owner: 'clippy' });
  assert.equal(desk.backlog?.length, 2);
  assert.deepEqual(await runtime.ledger.list(), []);
  assert.deepEqual(await runtime.requests.list(), []);
  const persisted = await readFile(join(runtime.stateDirectory, 'attention', 'index.json'), 'utf8');
  assert.match(persisted, /scripted-survey|Please approve this urgently/);
});

test('legacy index migration preserves Seen and unpublished commits, resolves only absent worktrees, and survives restart', async () => {
  const runtime = await fixture();
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'cancelled' });
  const path = join(runtime.plansRoot, 'clippy', item.id);
  await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  await writeFile(join(path, 'unique.txt'), 'Keep this unique work\n');
  execFileSync('git', ['-C', path, 'add', 'unique.txt']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'Unique unpublished work']);
  const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
  await runtime.ledger.update(item.id, current => ({ ...current, planWorktree: path, planWorktreeKept: 'kept-unpublished' }));
  const note = `plan worktree ${path} was kept: it has commits no remote branch holds. Look at it with \`git -C ${path} status\`; remove it with \`git worktree remove\` once nothing in it is needed.`;
  await runtime.notebook('clippy').journal({ kind: 'attention', note });
  await runtime.notebook('clippy').journal({ kind: 'attention', note });
  const entries = await listAttention(runtime);
  await changeAttention(runtime, entries[0].id, 'acknowledged', 'person', 'Keep for inspection');
  const indexPath = join(runtime.stateDirectory, 'attention', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  delete index.routingVersion;
  for (const entry of Object.values(index.entries) as Record<string, unknown>[]) {
    delete entry.provenance;
    delete entry.journal;
  }
  await writeFile(indexPath, JSON.stringify(index));
  const migrated = await listAttention(runtime);
  assert.equal(migrated.length, 2);
  assert.equal(migrated[0].status, 'acknowledged');
  assert.equal(migrated[0].decision?.reason, 'Keep for inspection');
  assert.ok(migrated.every(entry => entry.provenance?.kind === 'plan-worktree' && !needsHumanDecision(entry)));
  assert.equal((await git(path, ['rev-parse', 'HEAD'])).trim(), head);
  assert.equal((await runtime.ledger.get(item.id)).planWorktree, path);
  await rm(path, { recursive: true });
  const resolved = await listAttention(runtime);
  assert.ok(resolved.every(entry => entry.status === 'resolved' && entry.resolution?.code === 'plan_worktree_absent'));
  assert.equal(resolved[0].decision?.reason, 'Keep for inspection');
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  assert.deepEqual(await listAttention(reopened), resolved);
});

test('manager escalations are owner follow-up and both typed and exact legacy journal cards clear from their resolution', async () => {
  const runtime = await fixture();
  await runtime.initiatives.open('odrade', {
    title: 'Earlier unrelated initiative', goal: 'Other work', rationale: 'Fixture', assignments: [],
  });
  const initiative = await runtime.initiatives.open('odrade', {
    title: 'Checks', goal: 'Useful checks', rationale: 'Gap',
    assignments: [{ id: 'checks', to: 'clippy', proposal, after: [] }],
  });
  const escalation = await raiseToManager(runtime, 'clippy', { initiative: initiative.id, assignment: 'checks', kind: 'question', note: 'Which checks?' });
  const notebook = runtime.notebook('odrade');
  await notebook.journal({ kind: 'attention', note: `clippy escalated (question) on ${initiative.id}/checks: Which checks?` });
  await notebook.journal({ kind: 'attention', note: `Unrelated report mentions ${initiative.id}: Which checks?` });
  let entries = await listAttention(runtime);
  assert.equal(entries.filter(entry => entry.provenance?.kind === 'escalation').length, 2);
  assert.equal(entries.filter(needsHumanDecision).length, 1, 'unclassified prose is not suppressed');
  await resolveEscalation(runtime, 'odrade', initiative.id, escalation.id, 'Use the existing suite');
  entries = await listAttention(runtime);
  assert.ok(entries.filter(entry => entry.provenance?.kind === 'escalation')
    .every(entry => entry.status === 'resolved' && entry.resolution?.code === 'escalation_resolved'));
  assert.equal(entries.filter(needsHumanDecision).length, 1);
});

test('legacy delegation cancellation clears both participant cards, not an unrelated failed request or authority discrepancy', async () => {
  const runtime = await fixture();
  const request = await runtime.requests.open('homelab', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'failed', request: request.id });
  await runtime.requests.save({ ...request, status: 'failed', workItem: item.id, reason: `${item.id}: failed: original` });
  for (const owner of ['clippy', 'homelab']) await runtime.notebook(owner).journal({
    kind: 'attention', note: `${request.id} (homelab → clippy): ${item.id}: failed: original`,
  });

  test('ambiguous legacy escalations do not borrow a different escalation resolution', async () => {
    const runtime = await fixture();
    const initiative = await runtime.initiatives.open('odrade', {
      title: 'Checks', goal: 'Useful checks', rationale: 'Gap',
      assignments: [{ id: 'checks', to: 'clippy', proposal, after: [] }],
    });
    const at = new Date().toISOString();
    const escalation = { kind: 'question' as const, from: 'clippy', assignment: 'checks', note: 'Which checks?', at };
    await runtime.initiatives.update(initiative.id, current => ({ ...current, escalations: [
      { ...escalation, id: 'e-first', resolution: { by: 'owner:odrade', at, note: 'Answered earlier' } },
      { ...escalation, id: 'e-second' },
    ] }));
    await runtime.notebook('odrade').journal({ kind: 'attention',
      note: `clippy escalated (question) on ${initiative.id}/checks: Which checks?` });
    const [entry] = await listAttention(runtime);
    assert.equal(entry.status, 'open');
    assert.equal(entry.provenance, undefined);
    assert.equal(needsHumanDecision(entry), true);
  });
  await runtime.notebook('homelab').journal({ kind: 'attention', note: 'Charter and configuration disagree; the person must choose authority' });
  const other = await runtime.requests.open('homelab', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  await runtime.requests.save({ ...other, status: 'completed' });
  assert.equal((await listAttention(runtime)).filter(entry => entry.status === 'resolved').length, 0, 'replacement success alone is not proof');
  await runtime.ledger.update(item.id, current => ({ ...current, status: 'cancelled' }));
  const entries = await listAttention(runtime);
  assert.equal(entries.filter(entry => entry.resolution?.code === 'delegation_work_cancelled').length, 2);
  assert.equal(entries.filter(needsHumanDecision).length, 1);
  assert.equal((await runtime.requests.get(request.id)).status, 'failed', 'reconciliation changes only the projection');
});

test('legacy request ID mentions and non-failure envelopes never classify or clear a human choice', async () => {
  const runtime = await fixture();
  const request = await runtime.requests.open('homelab', 'clippy', { kind: 'work', purpose: proposal.goal, proposal }, 'none');
  const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { request: request.id, status: 'landed' });
  await runtime.requests.save({ ...request, workItem: item.id, status: 'completed' });
  const prefix = `${request.id} (homelab → clippy): `;
  for (const note of [
    `${prefix}${item.id}: Approve the additional production access before any follow-up`,
    `${prefix}delegation declined: Please approve broader credentials`,
    `Choose authority for ${request.id}: failed`,
  ]) await runtime.notebook('homelab').journal({ kind: 'attention', note });
  const entries = await listAttention(runtime);
  assert.equal(entries.length, 3);
  assert.ok(entries.every(entry => !entry.provenance && needsHumanDecision(entry)));
});

test('legacy app-update failure provenance is corrected from the exact host envelope, not arbitrary success statuses', async () => {
  const runtime = await fixture();
  await runtime.notebook('moneo').ensure('# Fixture NAS');
  const request = await runtime.requests.open('homelab', 'moneo', {
    kind: 'update-app', app: 'radarr', fromVersion: '1', toVersion: '2', purpose: 'Update', notesRead: [],
  }, 'none');
  for (const owner of ['homelab', 'moneo']) await runtime.notebook(owner).journal({
    kind: 'attention',
    note: `${request.id} (homelab → moneo): update radarr 1 → 2: update failed: job failed; a person should look`,
    provenance: { kind: 'delegation', request: request.id },
  });
  await runtime.notebook('homelab').journal({
    kind: 'attention', note: `${request.id} (homelab → moneo): Choose production authority`,
    provenance: { kind: 'human-decision', code: 'authority_discrepancy' },
  });
  assert.equal((await listAttention(runtime)).filter(entry => entry.provenance?.kind === 'request-operation').length, 2);
  await runtime.requests.save({ ...request, status: 'published' });
  assert.equal((await listAttention(runtime)).filter(entry => entry.status === 'resolved').length, 0);
  await runtime.requests.save({ ...request, status: 'updated' });
  const entries = await listAttention(runtime);
  assert.equal(entries.filter(entry => entry.resolution?.code === 'app_update_completed').length, 2);
  assert.equal(entries.filter(needsHumanDecision).length, 1);
});

test('missing original provenance and unreadable evidence never mean resolved or no human choice', async () => {
  const runtime = await fixture();
  const notebook = runtime.notebook('clippy');
  await notebook.journal({ kind: 'attention', note: 'A human choice', provenance: { kind: 'human-decision', code: 'authority_discrepancy' } });
  const blockedPath = join(runtime.stateDirectory, 'not-a-directory');
  await writeFile(blockedPath, 'not a directory');
  await notebook.journal({ kind: 'attention', note: 'Cleanup', provenance: {
    kind: 'plan-worktree', workItem: 'missing-item', path: join(blockedPath, 'checkout'),
  } });
  await assert.rejects(listAttention(runtime), /ENOTDIR/);
  const index = JSON.parse(await readFile(join(runtime.stateDirectory, 'attention', 'index.json'), 'utf8'));
  assert.deepEqual(index.entries, {}, 'failed reconciliation does not persist partial success');
});
