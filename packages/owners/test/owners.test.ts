import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { editSection, familyOf, Ledger, loadDeclarations, pickModel } from '@onionsoup/owners';

const families = {
  families: [
    { family: 'anthropic', match: ['github-copilot/claude-*'] },
    { family: 'openai', match: ['openai/*', 'github-copilot/gpt-*'] },
  ],
};

test('review model is picked outside the implementer family', () => {
  assert.equal(familyOf(families, 'github-copilot/claude-sonnet-5'), 'anthropic');
  const pick = pickModel(families, ['github-copilot/claude-sonnet-5', 'openai/gpt-5.6-sol'], ['anthropic']);
  assert.deepEqual(pick, { model: 'openai/gpt-5.6-sol', family: 'openai' });
  assert.throws(() => pickModel(families, ['github-copilot/claude-sonnet-5'], ['anthropic']), /no_model_outside_families/);
  assert.throws(() => familyOf(families, 'mystery/model'), /unknown_model_family/);
});

test('notebook edits append to or replace one section', () => {
  const start = '# Wisdom\n\n## Testing\n\nUse table tests.\n\n## Style\n\ngofmt.\n';
  const appended = editSection(start, { register: 'WISDOM', mode: 'append', section: 'Testing', text: 'Golden images live in testdata.' });
  assert.match(appended, /Use table tests\.\n\nGolden images live in testdata\.\n\n## Style/);
  const replaced = editSection(appended, { register: 'WISDOM', mode: 'replace-section', section: 'Style', text: 'gofmt and go vet.' });
  assert.match(replaced, /## Style\n\ngofmt and go vet\.\n$/);
  const added = editSection(start, { register: 'WISDOM', mode: 'append', section: 'Releases', text: 'GoReleaser on tags.' });
  assert.match(added, /## Releases\n\nGoReleaser on tags\.\n$/);
});

test('work stranded mid-stage is marked interrupted, not replayed', async () => {
  const ledger = new Ledger(await mkdtemp(join(tmpdir(), 'owners-')));
  const proposal = { title: 't', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const running = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...running, status: 'implementing', activeRunner: 424242 });
  const queued = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...queued, status: 'implementing' });
  const waiting = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...waiting, status: 'awaiting-plan-approval' });
  assert.equal(await ledger.markInterrupted(), 1);
  assert.equal((await ledger.get(running.id)).status, 'interrupted');
  assert.equal((await ledger.get(waiting.id)).status, 'awaiting-plan-approval');
  assert.equal((await ledger.get(queued.id)).status, 'implementing', 'approved but never started stays queued');
});

test('example declarations load and reference known models', async () => {
  const declarations = await loadDeclarations('examples/owners');
  const clippy = declarations.owners.get('clippy');
  assert.ok(clippy);
  for (const freelancer of declarations.freelancers.values()) {
    for (const model of freelancer.models) familyOf(declarations.families, model);
  }
  familyOf(declarations.families, clippy.model);
});

test('a person can send a plan back with feedback, or reject it, and both are recorded', async () => {
  const { Runtime, revisePlan, rejectPlan } = await import('@onionsoup/owners');
  const runtime = await Runtime.open({ declarations: 'examples/owners', state: await mkdtemp(join(tmpdir(), 'owners-state-')) });
  await runtime.notebook('clippy').ensure('# Charter\n');
  const proposal = { title: 't', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const plan = { summary: 's', steps: [{ description: 'd', files: ['main.go'] }], tests: ['t'], risks: [], outOfScope: [], questionsForOwner: [] };
  const first = await runtime.ledger.create('clippy', 'change', proposal);
  await runtime.ledger.save({ ...first, status: 'awaiting-plan-approval', plan });
  const revised = await revisePlan(runtime, first.id, 'bjk', 'also bound -font-size');
  assert.equal(revised.status, 'planning');
  assert.deepEqual(revised.humanNotes.map(note => [note.kind, note.note]), [['plan-feedback', 'also bound -font-size']]);
  const second = await runtime.ledger.create('clippy', 'change', proposal);
  await runtime.ledger.save({ ...second, status: 'awaiting-plan-approval', plan });
  const rejected = await rejectPlan(runtime, second.id, 'bjk', 'busywork');
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(rejectPlan(runtime, second.id, 'bjk', 'again'), /not_rejectable: rejected/);
});

test('survey context says when landed work is not yet on the base branch', async () => {
  const { workSoFarText } = await import('../src/briefs.ts');
  const base = { owner: 'clippy', workflow: 'change', implementations: [], verdicts: [], replans: 0, hires: [], humanNotes: [], createdAt: '', updatedAt: '' };
  const proposal = { title: 'Alignment tests', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
  const text = workSoFarText([
    { ...base, id: 'w-1', proposal, status: 'landed', branch: 'owners/w-1' },
    { ...base, id: 'w-2', proposal: { ...proposal, title: 'Clipboard note' }, status: 'rejected', reason: 'busywork' },
  ]);
  assert.match(text, /Alignment tests \[w-1\]: landed on local branch owners\/w-1, NOT yet on the base branch/);
  assert.match(text, /Clipboard note \[w-2\]: plan rejected by a person: busywork/);
});

async function incusRuntime() {
  const { Runtime } = await import('@onionsoup/owners');
  const runtime = await Runtime.open({ declarations: 'examples/owners', state: await mkdtemp(join(tmpdir(), 'owners-incus-')) });
  const calls: string[][] = [];
  runtime.incus = { run: async args => { calls.push([...args]); return args[0] === 'list' || args[1] === 'list' ? '[]' : ''; } };
  for (const ownerId of ['clippy', 'homelab', 'moneo']) await runtime.notebook(ownerId).ensure('# Charter\n');
  return { runtime, calls };
}

test('an approved lease creates, runs the follow-up, and deletes without a second prompt', async () => {
  const { approveCreate, processRequests, FOLLOW_UPS } = await import('../src/brokering.ts');
  const { runtime, calls } = await incusRuntime();
  FOLLOW_UPS['test-follow-up'] = async (_runtime, request) => ({ ok: true, summary: `used ${request.instance!.name}` });
  const ask = { kind: 'instance' as const, image: 'images:debian/13', purpose: 'smoke test', expectedMinutes: 10 };
  const opened = await runtime.requests.open('clippy', 'homelab', ask, 'test-follow-up');
  const decision = { decision: 'accept' as const, reply: 'ok', remote: 'minideb', image: 'images:debian/13', nameSuffix: 'clippy-smoke' };
  await runtime.requests.save({ ...opened, status: 'awaiting-create-approval', decision });
  await approveCreate(runtime, opened.id, 'bjk', true);
  await processRequests(runtime);
  const done = await runtime.requests.get(opened.id);
  assert.equal(done.status, 'deleted');
  assert.equal(done.followUpResult?.summary, 'used onionsoup-clippy-smoke');
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['launch', 'images:debian/13'], ['delete', '--force']]);
  assert.deepEqual(await runtime.managed.list('homelab'), []);
});

test('without a lease the release waits for a delete approval', async () => {
  const { approveCreate, approveDelete, processRequests, FOLLOW_UPS } = await import('../src/brokering.ts');
  const { runtime } = await incusRuntime();
  FOLLOW_UPS['test-follow-up'] = async () => ({ ok: true, summary: 'fine' });
  const ask = { kind: 'instance' as const, image: 'images:debian/13', purpose: 'p', expectedMinutes: 5 };
  const opened = await runtime.requests.open('clippy', 'homelab', ask, 'test-follow-up');
  await runtime.requests.save({ ...opened, status: 'awaiting-create-approval', decision: { decision: 'accept', reply: 'ok', remote: 'minideb', image: 'images:debian/13', nameSuffix: 'x' } });
  await approveCreate(runtime, opened.id, 'bjk', false);
  await processRequests(runtime);
  assert.equal((await runtime.requests.get(opened.id)).status, 'awaiting-delete-approval');
  await approveDelete(runtime, opened.id, 'bjk');
  await processRequests(runtime);
  assert.equal((await runtime.requests.get(opened.id)).status, 'deleted');
});

test('create and delete guards hold regardless of what an owner decides', async () => {
  const { checkCreate, deleteInstance } = await import('../src/incus.ts');
  const { runtime, calls } = await incusRuntime();
  const owner = runtime.incusOwner('homelab');
  await assert.rejects(checkCreate(owner, runtime.managed, { remote: 'selfie', image: 'images:debian/13', nameSuffix: 'x' }), /remote_forbids_create: selfie/);
  await assert.rejects(checkCreate(owner, runtime.managed, { remote: 'minideb', image: 'images:alpine/edge', nameSuffix: 'x' }), /image_not_allowed/);
  await assert.rejects(checkCreate(owner, runtime.managed, { remote: 'minideb', image: 'images:debian/13', nameSuffix: 'Bad Name' }), /bad_instance_name/);
  await assert.rejects(deleteInstance(runtime.incus, owner, runtime.managed, 'minideb', 'onionsoup-not-mine'), /not_managed_by_onionsoup/);
  await assert.rejects(deleteInstance(runtime.incus, owner, runtime.managed, 'selfie', 'bobsled'), /remote_forbids_delete: selfie/);
  assert.deepEqual(calls, []);
});

test('a publish request from an owner that is not the site source is refused before anyone is asked', async () => {
  const { runtime } = await incusRuntime();
  await runtime.notebook('moneo').ensure('# Charter\n');
  const { requestPublish, decide } = await import('../src/brokering.ts');
  const request = await requestPublish(runtime, 'clippy', 'homelab-wiki', 'try to publish a site it does not own');
  const decided = await decide(runtime, request.id);
  assert.equal(decided.status, 'declined');
  assert.match(decided.reason ?? '', /clippy is not the source of homelab-wiki/);
  await assert.rejects(requestPublish(runtime, 'bellonda', 'no-such-site', 'x'), /no owner hosts site no-such-site/);
});

test('an app update Moneo decided is approved by his standing grant without a person', async () => {
  const { runtime } = await incusRuntime();
  await runtime.notebook('moneo').ensure('# Charter\n');
  const { decide } = await import('../src/brokering.ts');
  const ask = { kind: 'update-app' as const, app: 'radarr', fromVersion: '1.4.15', toVersion: '1.4.17', purpose: 'patch release, no breaking changes', notesRead: [] };
  const request = await runtime.requests.open('moneo', 'moneo', ask, 'none');
  const decided = await decide(runtime, request.id);
  assert.equal(decided.status, 'create-approved');
  assert.match(decided.approvals.at(-1)!.by, /standing grant in moneo's declaration \(update-app \* for moneo\)/);
});
