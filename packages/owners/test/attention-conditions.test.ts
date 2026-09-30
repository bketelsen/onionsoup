import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runtime } from '../src/runtime.ts';
import { changeAttention, listAttention } from '../src/attention.ts';

async function fixture() {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'attention-conditions-')) });
  await runtime.notebook('clippy').ensure('# Fixture');
  return runtime;
}

test('host condition deduplicates observations, preserves Seen, and resolves only with positive evidence', async () => {
  const runtime = await fixture();
  const notebook = runtime.notebook('clippy');
  const condition = { key: 'cleanup:item-1', state: 'open' as const };
  await notebook.journal({ kind: 'attention-condition', condition, note: 'Dirty checkout' });
  const [entry] = await listAttention(runtime);
  await changeAttention(runtime, entry.id, 'acknowledged', 'Brian', 'Seen');
  await notebook.journal({ kind: 'attention-condition', condition, note: 'Still dirty' });
  let entries = await listAttention(runtime);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'acknowledged');
  assert.equal(entries[0].note, 'Still dirty');
  await notebook.journal({ kind: 'attention-condition', condition: { ...condition, state: 'resolved' }, note: 'Verified removed' });
  entries = await listAttention(runtime);
  assert.equal(entries[0].status, 'resolved');
  assert.equal(entries[0].decision?.reason, 'Seen');
  await notebook.journal({ kind: 'attention-condition', condition, note: 'Delayed duplicate' });
  assert.equal((await listAttention(runtime))[0].status, 'resolved');
  assert.equal((await listAttention(runtime))[0].note, 'Verified removed');
  assert.equal((await runtime.requests.list()).length, 0);
});

test('terminal tombstones prevent late discovery from reviving cleared conditions and do not infer legacy closure', async () => {
  const runtime = await fixture();
  const notebook = runtime.notebook('clippy');
  await notebook.journal({ kind: 'attention', note: 'Dirty checkout' });
  await notebook.journal({ kind: 'attention', note: 'Dirty checkout' });
  await notebook.journal({ kind: 'attention-condition', condition: { key: 'cleanup:item-2', state: 'resolved' }, note: 'Already removed' });
  await notebook.journal({ kind: 'attention-condition', condition: { key: 'cleanup:item-2', state: 'open' }, note: 'Delayed failure' });
  await notebook.journal({ kind: 'attention-condition', condition: { key: 'cleanup:item-3', state: 'open' }, note: 'Different generation' });
  const entries = await listAttention(runtime);
  assert.equal(entries.filter(entry => !entry.condition && entry.status === 'open').length, 2);
  assert.equal(entries.find(entry => entry.condition?.key === 'cleanup:item-2')?.status, 'resolved');
  assert.equal(entries.find(entry => entry.condition?.key === 'cleanup:item-3')?.status, 'open');
  const path = join(runtime.stateDirectory, 'attention', 'index.json');
  const index = JSON.parse(await readFile(path, 'utf8'));
  index.cursors = {};
  await writeFile(path, JSON.stringify(index));
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  assert.equal((await listAttention(reopened)).length, entries.length, 'cursor replay and restart preserve identities');
});
