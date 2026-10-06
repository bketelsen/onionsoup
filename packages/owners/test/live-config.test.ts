import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { PLUGIN_LIMITS } from '../src/plugin.ts';
import { withActiveHooks } from './active-hooks.ts';

async function liveChat(agent: string) {
  const declarations = await mkdtemp(join(tmpdir(), 'onionsoup-live-config-'));
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-live-state-'));
  const client = { session: {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
    status: async () => ({ data: {} }),
    children: async () => ({ data: [] }),
  } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  await hooks['chat.message']!({ sessionID: 'person', agent } as never, {} as never);
  const context = async () => {
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']!({ sessionID: 'person' } as never, output);
    return output.system.join('\n');
  };
  return { declarations, context };
}

test('a charter or reporting-line edit reaches a live chat on its next turn, without a restart', async context => {
  const previous = PLUGIN_LIMITS.declarationsMs;
  context.after(() => { PLUGIN_LIMITS.declarationsMs = previous; });
  PLUGIN_LIMITS.declarationsMs = 0;
  const chat = await liveChat('Odrade');
  const before = await chat.context();
  assert.match(before, /<charter>/);
  assert.match(before, /<roster>/);
  assert.match(before, /<org>\nYour direct reports: Bellonda/);
  await writeFile(join(chat.declarations, 'charters', 'odrade.md'), '# Charter: odrade\n\nNow also owns snowkit.\n');
  const bellonda = join(chat.declarations, 'owners', 'bellonda.yaml');
  await writeFile(bellonda, (await readFile(bellonda, 'utf8')).replace(/^reportsTo: odrade\n/m, ''));
  const after = await chat.context();
  assert.match(after, /Now also owns snowkit\./);
  assert.match(after, /<org>\nYour direct reports: /);
  assert.doesNotMatch(after, /Your direct reports: [^\n]*Bellonda/);
});
