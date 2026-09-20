import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth';
import { buildCopilotRequest, createCopilotProvider, startDeviceOAuth as copilotLogin } from '@humanlayer/agentlayer-provider-github-copilot';
import { createCodexSseVendorProvider, startDeviceOAuth as codexLogin } from '@humanlayer/agentlayer-provider-openai-codex';

export function authStore() {
  return createFileAuthStore({ filePath: process.env.ONIONSOUP_AUTH_PATH ?? '.local/auth.json' });
}
export function providerName(value = process.env.ONIONSOUP_PROVIDER ?? 'copilot'): 'copilot' | 'codex' {
  if (value !== 'copilot' && value !== 'codex') throw new Error('Provider must be copilot or codex');
  return value;
}
export class ProviderAuthError extends Error {
  constructor(readonly code: 'provider_auth_missing' | 'provider_auth_unreadable') {
    super(code === 'provider_auth_missing'
      ? 'No provider sign-in found. Set ONIONSOUP_AUTH_PATH or run npm run triage -- login copilot (or codex).'
      : 'Cannot read provider authentication. Check ONIONSOUP_AUTH_PATH, permissions and JSON format.');
    this.name = 'ProviderAuthError';
  }
}
export async function liveModel(modelId = process.env.ONIONSOUP_MODEL, provider = providerName()) {
  if (!modelId) throw new Error('Set ONIONSOUP_MODEL to a model available on your subscription');
  const store = authStore();
  let configured: boolean;
  try { configured = Boolean(await store.get(provider)); }
  catch { throw new ProviderAuthError('provider_auth_unreadable'); }
  if (!configured) throw new ProviderAuthError('provider_auth_missing');
  const adapter = provider === 'copilot'
    ? createCopilotProvider({ authStore: store, version: 'onionsoup/0.1.0' })
    : createCodexSseVendorProvider({ authStore: store });
  return { provider, modelId, model: adapter.languageModel(modelId) };
}
export async function login(provider: 'copilot' | 'codex') {
  const auth = await (provider === 'copilot' ? copilotLogin : codexLogin)({ store: authStore() });
  console.error(`Visit ${auth.url} and enter ${auth.userCode}`);
  const result = await auth.complete();
  if (result.kind !== 'success') throw new Error('Sign-in did not complete');
  console.error(`${provider} connected`);
}
export async function models() {
  // AgentLayer 0.0.36's full catalog schema rejects newer non-chat entries.
  // Project only the fields needed here, without inventing missing capabilities.
  const request = await buildCopilotRequest({ input: 'https://api.githubcopilot.com/models',
    authStore: authStore(), providerId: 'copilot', init: {} });
  const response = await fetch(request.input, { ...request.init, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);
  console.log(JSON.stringify(selectToolModels(await response.json()), null, 2));
}

export function selectToolModels(raw: unknown): string[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Invalid model catalog');
  return data.filter(m => m && typeof m.id === 'string' && m.model_picker_enabled === true &&
    m.policy?.state !== 'disabled' && m.capabilities?.supports?.tool_calls === true &&
    m.capabilities?.supports?.streaming === true).map(m => m.id).sort();
}
