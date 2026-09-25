import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import { withActiveHooks } from './active-hooks.ts';
import { REPOSITORY_REVIEW } from '../src/repository-writing.ts';

function assertWritingRule(prompt: string) {
  assert.match(prompt, /read as the project's own record/);
  assert.match(prompt, /do not narrate who asked, which owners you consulted/);
  assert.match(prompt, /PR description, commit message and your notebook/);
  assert.match(prompt, /Repository-specific templates, conventions and review rubrics take precedence/);
}

test('configured owner prompts carry repository writing guidance alongside each persona', async () => {
  const state = await mkdtemp('/tmp/onionsoup-writing-plugin-');
  // The config hook is local: fail if prompt generation tries to contact an opencode client.
  const input = new Proxy({} as PluginInput, {
    get(_target, key) { throw new Error(`unexpected_plugin_input: ${String(key)}`); },
  });
  const originalSandbox = process.env.ONIONSOUP_SANDBOX;
  const hooks = await withActiveHooks(input, { declarations: 'packages/owners/test/fixtures/owners', state });
  assert.equal(process.env.ONIONSOUP_SANDBOX, originalSandbox);
  const config: Config = {};
  await hooks.config!(config);
  const owners = Object.values(config.agent ?? {}).filter(
    (agent): agent is NonNullable<typeof agent> => agent !== undefined && !agent.hidden,
  );
  assert.ok(owners.length > 1);
  for (const owner of owners) {
    assertWritingRule(owner.prompt!);
    assert.match(owner.prompt!, /onionsoup_friction \(report reproducible engine behavior/);
    assert.match(owner.prompt!, /onionsoup_request_work \(ask another\s+owner/);
  }
  assert.match(config.agent!.Odrade!.prompt!, /<org>\nYour direct reports: Bellonda/);
  assert.match(config.agent!.Bellonda!.prompt!, /<org>\nYour manager: Odrade/);
  assert.doesNotMatch(config.agent!['Miles Teg']!.prompt!, /<org>/);
  assert.match(config.agent!.Odrade!.prompt!, /draft an initiative with onionsoup_initiative/);
  assert.doesNotMatch(config.agent!.Bellonda!.prompt!, /onionsoup_initiative/);
  const permissions = (name: string) => config.agent![name]!.permission as Record<string, string>;
  assert.equal((config.permission as Record<string, string>).onionsoup_initiative, 'deny', 'hidden from everyone');
  assert.equal(permissions('Odrade').onionsoup_initiative, 'allow', 'shown to owners with direct reports');
  assert.equal(permissions('Bellonda').onionsoup_initiative, undefined);
  assert.match(config.agent!.Bellonda!.prompt!, /Exact\./, 'the persona remains available for conversation');
});

test('the host review brief applies the same rule and says which severities send a change back', () => {
  assertWritingRule(REPOSITORY_REVIEW);
  assert.match(REPOSITORY_REVIEW, /flag violations as review findings/);
  assert.match(REPOSITORY_REVIEW, /Apply repository-specific attribution requirements where declared/);
  assert.match(REPOSITORY_REVIEW, /- blocker: a correctness, safety or factual error[^\n]*Only blockers send the change back/);
  assert.match(REPOSITORY_REVIEW, /- major, minor, nit: worth fixing, but not blocking/);
});
