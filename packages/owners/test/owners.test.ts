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
