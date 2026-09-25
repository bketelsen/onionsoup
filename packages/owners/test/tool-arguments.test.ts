import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import { z } from 'zod';
import { withActiveHooks } from './active-hooks.ts';

test('the active plugin makes omitted webfetch defaults encodable without changing approval rules', async () => {
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-webfetch-'));
  const hooks = await withActiveHooks({} as PluginInput, {
    declarations: 'packages/owners/test/fixtures/owners', state,
  });
  const config: Config = {};
  await hooks.config!(config);
  const permissionBefore = structuredClone(config.agent!['Miles Teg']!.permission);
  const args: Record<string, unknown> = { url: 'https://example.com/docs' };
  await hooks['tool.execute.before']!({ tool: 'webfetch', sessionID: 'person', callID: 'fetch' }, { args });
  // Reproduce the upstream metadata construction before serialization, where undefined is rejected.
  const metadata = { url: args.url, format: args.format, timeout: args.timeout };
  assert.deepEqual(z.json().parse(metadata), {
    url: 'https://example.com/docs', format: 'markdown', timeout: 30,
  });
  assert.deepEqual(config.agent!['Miles Teg']!.permission, permissionBefore);
  assert.equal((permissionBefore as { webfetch: string }).webfetch, 'ask');

  const explicit = { url: 'https://example.com', format: 'text', timeout: 90 };
  await hooks['tool.execute.before']!({ tool: 'webfetch', sessionID: 'person', callID: 'explicit' }, { args: explicit });
  assert.deepEqual(explicit, { url: 'https://example.com', format: 'text', timeout: 90 });
  const unrelated = { command: 'true' };
  await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 'person', callID: 'other' }, { args: unrelated });
  assert.deepEqual(unrelated, { command: 'true' });
});
