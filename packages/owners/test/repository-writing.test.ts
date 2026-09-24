import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import { withActiveHooks } from './active-hooks.ts';
import { Runtime } from '../src/runtime.ts';
import { Plan } from '../src/artifacts.ts';
import { implementBrief, reviewBrief } from '../src/briefs.ts';

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

test('implementation and review briefs apply the same rule without discarding the project rubric', async () => {
  const runtime = await Runtime.open({
    declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp('/tmp/onionsoup-writing-brief-'),
  });
  const item = await runtime.ledger.create('clippy', 'change', {
    title: 'Record the retention decision', goal: 'Update the ADR', rationale: 'Approved policy',
    acceptance: ['Follow the ADR template'], size: 'small',
  });
  const plan = Plan.parse({
    summary: 'Revise the ADR', steps: [{ description: 'Update the record', files: ['docs/decision.md'] }],
    tests: ['Check the template'], risks: [], outOfScope: [], questionsForOwner: [],
  });
  const rubric = 'The project ADR template requires a Decision owner attribution field.';
  const implementation = implementBrief(item, plan, 'Use docs/decisions/TEMPLATE.md.', rubric);
  const review = reviewBrief(item, plan, 'ADR changes', [], '', rubric);
  for (const brief of [implementation, review]) {
    assertWritingRule(brief);
    assert.ok(brief.includes(rubric));
  }
  assert.match(review, /flag violations as review findings/);
  assert.match(review, /Apply repository-specific attribution requirements where declared/);
});
