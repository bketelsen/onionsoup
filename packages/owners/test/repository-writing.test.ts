import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-writing-plugin-'));
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
    assert.match(owner.prompt!, /onionsoup_friction \(report reproducible engine\s+behavior/);
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
  const milesTeg = config.agent!['Miles Teg']!.prompt!;
  assert.match(milesTeg, /Skills drive how you work/);
  assert.match(milesTeg, /Small, clear changes: edit your desk, run the verification commands, and end with\s+onionsoup_propose_changes/);
  assert.match(milesTeg, /submit it with\s+onionsoup_submit_plan\. The person approves it here/);
  assert.match(milesTeg, /onionsoup_checkout_pr/);
  assert.match(milesTeg, /onionsoup_record_fact: they come back to you word\s+for word/);
  assert.doesNotMatch(milesTeg, /freelancer|onionsoup_open_work/);
  assert.doesNotMatch(config.agent!.Moneo!.prompt!, /onionsoup_submit_plan/, 'an owner that only observes is not told to plan changes');
  assert.match(config.agent!.Moneo!.prompt!, /You do not change your domain yourself/);
  assert.match(config.agent!.Odrade!.prompt!, /you are woken here when it submits a plan/);
  assert.match(config.agent!.Bellonda!.prompt!, /Work it assigns opens a session where you plan it alone/);
});

test('the host review brief applies the same rule and says which severities send a change back', () => {
  assertWritingRule(REPOSITORY_REVIEW);
  assert.match(REPOSITORY_REVIEW, /process narration and flag it as a minor finding/);
  assert.match(REPOSITORY_REVIEW, /process narration in documents are minor at most; they never block/);
  assert.match(REPOSITORY_REVIEW, /Apply repository-specific attribution requirements where declared/);
  assert.match(REPOSITORY_REVIEW, /- blocker: a correctness, safety or factual error[^\n]*Only blockers send the change back/);
  assert.match(REPOSITORY_REVIEW, /- major, minor, nit: worth fixing, but not blocking/);
});
