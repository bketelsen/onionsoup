import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changeAttention, humanAttentionActor, listAttention, ownerAttentionActor } from '../src/attention.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';
import type { Plugin } from '@opencode-ai/plugin';

test('owners cannot acknowledge, resolve or reopen human decisions or ambiguous legacy entries, including Seen', async context => {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners',
    state: await mkdtemp(join(tmpdir(), 'attention-actors-')) });
  context.after(() => rm(runtime.stateDirectory, { recursive: true, force: true }));
  const notebook = runtime.notebook('clippy');
  await notebook.ensure('# Fixture');
  for (const code of ['ci_person', 'desk_review_exhausted']) await notebook.journal({
    kind: 'attention', note: 'Real person choice', provenance: { kind: 'human-decision', code },
  });
  await notebook.journal({ kind: 'attention', note: 'Legacy choice without host provenance' });
  const entries = await listAttention(runtime);
  const owner = ownerAttentionActor(runtime, 'clippy');
  for (const entry of entries) {
    for (const status of ['acknowledged', 'resolved', 'open'] as const) {
      await assert.rejects(changeAttention(runtime, entry.id, status, owner, 'Owner prose says human'), /human_decision_required/);
      await assert.rejects(changeAttention(runtime, entry.id, status, { by: userInfo().username }, 'Fake person label'), /actor_required/);
    }
    await changeAttention(runtime, entry.id, 'acknowledged', humanAttentionActor(), 'Seen');
    await assert.rejects(changeAttention(runtime, entry.id, 'resolved', owner, 'Seen by owner'), /human_decision_required/);
  }
  const persisted = JSON.parse(await readFile(join(runtime.stateDirectory, 'attention/index.json'), 'utf8'));
  assert.ok(Object.values(persisted.entries).every((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'status' in entry && entry.status === 'acknowledged'));
  assert.ok((await listAttention(runtime)).every(entry => entry.decision?.by === userInfo().username));
  assert.deepEqual(await runtime.requests.list(), []);
});

test('typed owner-housekeeping remains freely mutable, bound to runtime and authenticated owner', async context => {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners',
    state: await mkdtemp(join(tmpdir(), 'attention-housekeeping-')) });
  context.after(() => rm(runtime.stateDirectory, { recursive: true, force: true }));
  await runtime.notebook('clippy').ensure('# Fixture');
  await runtime.notebook('clippy').journal({ kind: 'attention', note: 'Ordinary maintenance',
    provenance: { kind: 'maintenance', code: 'fixture-maintenance' } });
  const [entry] = await listAttention(runtime);
  const actor = ownerAttentionActor(runtime, 'clippy');
  for (const status of ['acknowledged', 'resolved', 'open'] as const) {
    assert.equal((await changeAttention(runtime, entry.id, status, actor, 'Recorded housekeeping')).status, status);
  }
  await assert.rejects(changeAttention(runtime, entry.id, 'resolved', ownerAttentionActor(runtime, 'homelab'), 'Foreign owner'), /not_yours/);
  const reopened = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: runtime.stateDirectory });
  await assert.rejects(changeAttention(reopened, entry.id, 'resolved', actor, 'Foreign runtime'), /not_yours/);
  assert.equal((await listAttention(reopened))[0].status, 'open');
});

test('actual owner plugin tool rejects human/legacy mutations without trusting supplied actor labels', async context => {
  const declarations = 'packages/owners/test/fixtures/owners';
  const state = await mkdtemp(join(tmpdir(), 'attention-plugin-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const runtime = await Runtime.open({ declarations, state });
  await runtime.notebook('homelab').ensure('# Fixture');
  await runtime.notebook('homelab').journal({ kind: 'attention', note: 'Real CI decision',
    provenance: { kind: 'human-decision', code: 'ci_person' } });
  await runtime.notebook('homelab').journal({ kind: 'attention', note: 'Legacy person choice' });
  await runtime.notebook('homelab').journal({ kind: 'attention', note: 'Housekeeping',
    provenance: { kind: 'maintenance', code: 'fixture' } });
  const hooks = await withActiveHooks({ client: {} } as unknown as Parameters<Plugin>[0], { declarations, state });
  const tool = hooks.tool!.onionsoup_attention!;
  const toolContext = { agent: 'Miles Teg', sessionID: 'fixture', messageID: 'fixture', directory: '/desk' };
  for (const entry of await listAttention(runtime)) {
    for (const action of ['acknowledge', 'resolve', 'reopen'] as const) {
      const mutation = tool.execute({ action, id: entry.id, reason: 'Owner says person', by: userInfo().username } as never,
        toolContext as never);
      if (entry.provenance?.kind === 'maintenance') await mutation;
      else await assert.rejects(mutation, /human_decision_required/);
    }
  }
  assert.ok((await listAttention(runtime)).every(entry => entry.status === 'open'));
});
