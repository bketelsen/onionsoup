import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth';
import { catalog, catalogs, copilotModels, codexModels, environmentChoice, providerName, ranOnWorkflowModel } from '../src/index.ts';

const codexAuth = { kind: 'oauth' as const, accessToken: 'codex-token', accountId: 'account' };

test('copilot discovery keeps enabled tool-calling streaming models and skips entries of other shapes', () => {
  const valid = { id: 'available', name: 'Available', vendor: 'Example', model_picker_enabled: true,
    capabilities: { supports: { tool_calls: true, streaming: true } } };
  assert.deepEqual(copilotModels({ data: [valid, { id: 'new-media-type' },
    { ...valid, id: 'disabled', policy: { state: 'disabled' } }, null,
    { ...valid, id: 'hidden', model_picker_enabled: false }] }), [{ id: 'available', name: 'Available', vendor: 'Example' }]);
  assert.throws(() => copilotModels({}));
});

test('codex discovery keeps listed API models only', () => {
  assert.deepEqual(codexModels({ models: [
    { slug: 'gpt-listed', display_name: 'Listed', visibility: 'list', supported_in_api: true },
    { slug: 'gpt-hidden', visibility: 'hide', supported_in_api: true },
    { slug: 'gpt-app-only', visibility: 'list', supported_in_api: false },
    'unexpected',
  ] }), [{ id: 'gpt-listed', name: 'Listed', vendor: 'OpenAI' }]);
});

test('catalogs report each provider: listed models, signed out, or unavailable without transport detail', async (t) => {
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ models: [{ slug: 'gpt-listed', visibility: 'list', supported_in_api: true }] }), { status: 200 });
  });
  const listings = await catalogs(createMemoryAuthStore({ codex: codexAuth }));
  assert.deepEqual(listings, [
    { provider: 'copilot', status: 'signed_out' },
    { provider: 'codex', status: 'ok', models: [{ id: 'gpt-listed', name: 'gpt-listed', vendor: 'OpenAI' }] },
  ]);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/);

  t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream detail', { status: 503 }));
  assert.deepEqual(await catalog('codex', createMemoryAuthStore({ codex: codexAuth })), { provider: 'codex', status: 'unavailable', reason: 'catalog_http_503' });
});

test('the environment names one model and fails with a reason when it does not', (t) => {
  const saved = process.env.ONIONSOUP_MODEL;
  t.after(() => { if (saved === undefined) delete process.env.ONIONSOUP_MODEL; else process.env.ONIONSOUP_MODEL = saved; });
  delete process.env.ONIONSOUP_MODEL;
  assert.throws(() => environmentChoice('codex'), /model_not_configured/);
  process.env.ONIONSOUP_MODEL = 'gpt-listed';
  assert.deepEqual(environmentChoice('codex'), { provider: 'codex', model: 'gpt-listed' });
});

test('provider configuration fails closed instead of silently switching subscriptions', () => {
  assert.equal(providerName('copilot'), 'copilot');
  assert.equal(providerName('codex'), 'codex');
  assert.throws(() => providerName('claude'));
});

test('workflow records from before per-agent models still bind every run to their one model', () => {
  const run = { provider: 'copilot', model: 'gpt-5.6-terra' };
  assert.equal(ranOnWorkflowModel(undefined, run), true);
  assert.equal(ranOnWorkflowModel({ provider: 'copilot', model: 'gpt-5.6-terra' }, run), true);
  assert.equal(ranOnWorkflowModel({ provider: 'codex', model: 'gpt-5.6-terra' }, run), false);
});
