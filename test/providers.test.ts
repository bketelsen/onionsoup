import assert from 'node:assert/strict';
import test from 'node:test';
import { providerName, selectToolModels } from '../src/providers.ts';

test('discovery skips catalog entries without supported tool and streaming capabilities', () => {
  const valid = { id: 'available', model_picker_enabled: true,
    capabilities: { supports: { tool_calls: true, streaming: true } } };
  assert.deepEqual(selectToolModels({ data: [valid, { id: 'new-media-type' },
    { ...valid, id: 'disabled', policy: { state: 'disabled' } }, null,
    { ...valid, id: 'hidden', model_picker_enabled: false }] }), ['available']);
  assert.throws(() => selectToolModels({}), /Invalid model catalog/);
});

test('provider configuration fails closed instead of silently switching subscriptions', () => {
  assert.equal(providerName('copilot'), 'copilot');
  assert.equal(providerName('codex'), 'codex');
  assert.throws(() => providerName('claude'));
});
