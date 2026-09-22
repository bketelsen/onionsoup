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
  await ledger.save({ ...running, status: 'implementing' });
  const waiting = await ledger.create('clippy', 'change', proposal);
  await ledger.save({ ...waiting, status: 'awaiting-plan-approval' });
  assert.equal(await ledger.markInterrupted(), 1);
  assert.equal((await ledger.get(running.id)).status, 'interrupted');
  assert.equal((await ledger.get(waiting.id)).status, 'awaiting-plan-approval');
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
  await assert.rejects(rejectPlan(runtime, second.id, 'bjk', 'again'), /not_awaiting_plan_approval: rejected/);
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
