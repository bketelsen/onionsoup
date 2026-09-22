import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { createFileAuthStore, type AuthStore } from '@humanlayer/agentlayer-provider-auth';
import { buildCopilotRequest, createCopilotProvider, startDeviceOAuth as copilotLogin } from '@humanlayer/agentlayer-provider-github-copilot';
import { buildCodexHeaders, createCodexSseVendorProvider, resolveCodexAuth, startDeviceOAuth as codexLogin } from '@humanlayer/agentlayer-provider-openai-codex';

export const ProviderId = z.enum(['copilot', 'codex']);
export type ProviderId = z.infer<typeof ProviderId>;

/** One model on one provider subscription. Operator configuration names these; requests never do. */
export const ModelChoice = z.object({
  provider: ProviderId,
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
}).strict();
export type ModelChoice = z.infer<typeof ModelChoice>;

export const CATALOG_LIMITS = { timeoutMs: 15000 };
/** The Codex catalog hides models newer than the client version it is told about. */
const CODEX_CATALOG_CLIENT_VERSION = '1.0.0';

export function authStore() {
  return createFileAuthStore({ filePath: process.env.ONIONSOUP_AUTH_PATH ?? '.local/auth.json' });
}
export function providerName(value = process.env.ONIONSOUP_PROVIDER ?? 'copilot'): ProviderId {
  const parsed = ProviderId.safeParse(value);
  if (!parsed.success) throw new Error('Provider must be copilot or codex');
  return parsed.data;
}
export class ProviderAuthError extends Error {
  constructor(readonly code: 'provider_auth_missing' | 'provider_auth_unreadable') {
    super(code === 'provider_auth_missing'
      ? 'No provider sign-in found. Set ONIONSOUP_AUTH_PATH or run npm run triage -- login copilot (or codex).'
      : 'Cannot read provider authentication. Check ONIONSOUP_AUTH_PATH, permissions and JSON format.');
    this.name = 'ProviderAuthError';
  }
}

async function isSignedIn(store: AuthStore, provider: ProviderId) {
  try {
    return Boolean(await store.get(provider));
  } catch {
    throw new ProviderAuthError('provider_auth_unreadable');
  }
}

const adapters: Record<ProviderId, (store: AuthStore) => { languageModel(modelId: string): LanguageModel }> = {
  copilot: (store) => createCopilotProvider({ authStore: store, version: 'onionsoup/0.1.0' }),
  codex: (store) => createCodexSseVendorProvider({ authStore: store }),
};

export async function liveModel(modelId: string, provider: ProviderId) {
  const store = authStore();
  if (!(await isSignedIn(store, provider))) throw new ProviderAuthError('provider_auth_missing');
  return { provider, modelId, model: adapters[provider](store).languageModel(modelId) };
}
export type ModelAdapter = Awaited<ReturnType<typeof liveModel>>;

/** Opens the model one agent runs on. The agent names itself; operator configuration decides which model that is. */
export type ModelResolver = (agent: string) => Promise<ModelAdapter>;

/** Every agent on one model. */
export function singleModel(choice: ModelChoice): ModelResolver {
  return async () => liveModel(choice.model, choice.provider);
}

/** The one model a CLI or standalone MCP host runs on: ONIONSOUP_MODEL on ONIONSOUP_PROVIDER, or the provider it names. */
export function environmentChoice(provider: ProviderId = providerName()): ModelChoice {
  if (!process.env.ONIONSOUP_MODEL) throw new Error('model_not_configured: set ONIONSOUP_MODEL to a model from `npm run triage -- models`');
  return ModelChoice.parse({ provider, model: process.env.ONIONSOUP_MODEL });
}

/**
 * Workflow records from before per-agent models name one model for every stage. Newer records omit it and
 * each agent run carries the provider and model it ran on.
 */
export type WorkflowExecution = { provider: ProviderId; model: string };
export function isWorkflowExecution(value: unknown): value is WorkflowExecution | undefined {
  return value === undefined || ModelChoice.safeParse(value).success;
}
/** Whether a run matches its workflow's single model, when the workflow names one. */
export function ranOnWorkflowModel(execution: WorkflowExecution | undefined, run: { provider: string; model: string }) {
  return !execution || (run.provider === execution.provider && run.model === execution.model);
}

/** Every agent on the environment's one model, read when an agent first opens it. */
export function environmentModels(provider?: ProviderId): ModelResolver {
  return async (agent) => singleModel(environmentChoice(provider))(agent);
}

export async function login(provider: ProviderId) {
  const auth = await (provider === 'copilot' ? copilotLogin : codexLogin)({ store: authStore() });
  console.error(`Visit ${auth.url} and enter ${auth.userCode}`);
  const result = await auth.complete();
  if (result.kind !== 'success') throw new Error('Sign-in did not complete');
  console.error(`${provider} connected`);
}

export const CatalogModel = z.object({ id: z.string(), name: z.string(), vendor: z.string().optional() }).strict();
export type CatalogModel = z.infer<typeof CatalogModel>;
export const ProviderCatalog = z.discriminatedUnion('status', [
  z.object({ provider: ProviderId, status: z.literal('ok'), models: z.array(CatalogModel) }).strict(),
  z.object({ provider: ProviderId, status: z.literal('signed_out') }).strict(),
  z.object({ provider: ProviderId, status: z.literal('unavailable'), reason: z.string() }).strict(),
]);
export type ProviderCatalog = z.infer<typeof ProviderCatalog>;

// AgentLayer 0.0.36's full catalog schema rejects newer non-chat entries, so each catalog is read
// here with only the fields model selection needs, and entries of any other shape are skipped.
const entries = <T>(entry: z.ZodType<T>, raw: unknown[]) => raw.flatMap((item) => {
  const parsed = entry.safeParse(item);
  return parsed.success ? [parsed.data] : [];
});
const CopilotCatalog = z.object({ data: z.array(z.unknown()) });
const CopilotEntry = z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    vendor: z.string().optional(),
    model_picker_enabled: z.boolean().optional(),
    policy: z.looseObject({ state: z.string().optional() }).optional(),
    capabilities: z.looseObject({ supports: z.looseObject({ tool_calls: z.boolean().optional(), streaming: z.boolean().optional() }).optional() }).optional(),
});
const CodexCatalog = z.object({ models: z.array(z.unknown()) });
const CodexEntry = z.looseObject({
  slug: z.string(),
  display_name: z.string().optional(),
  visibility: z.string().optional(),
  supported_in_api: z.boolean().optional(),
});

/** Copilot models that can stream tool calls and are enabled for this subscription. */
export function copilotModels(raw: unknown): CatalogModel[] {
  return entries(CopilotEntry, CopilotCatalog.parse(raw).data)
    .filter((m) => m.model_picker_enabled === true && m.policy?.state !== 'disabled' && m.capabilities?.supports?.tool_calls === true && m.capabilities?.supports?.streaming === true)
    .map((m) => ({ id: m.id, name: m.name ?? m.id, ...(m.vendor ? { vendor: m.vendor } : {}) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Codex models listed for this subscription and usable through the API. */
export function codexModels(raw: unknown): CatalogModel[] {
  return entries(CodexEntry, CodexCatalog.parse(raw).models)
    .filter((m) => m.visibility === 'list' && m.supported_in_api === true)
    .map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, vendor: 'OpenAI' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchCatalog(input: string, init: RequestInit) {
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(CATALOG_LIMITS.timeoutMs) });
  if (!response.ok) throw new Error(`catalog_http_${response.status}`);
  return response.json();
}

const catalogReaders: Record<ProviderId, (store: AuthStore) => Promise<CatalogModel[]>> = {
  copilot: async (store) => {
    const request = await buildCopilotRequest({ input: 'https://api.githubcopilot.com/models', authStore: store, providerId: 'copilot', init: {} });
    return copilotModels(await fetchCatalog(String(request.input), request.init ?? {}));
  },
  codex: async (store) => {
    const auth = await resolveCodexAuth(store, 'codex', fetch, Date.now);
    const url = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`;
    return codexModels(await fetchCatalog(url, { headers: buildCodexHeaders({ auth }) }));
  },
};

/** The models one provider offers this subscription, or why they cannot be listed. Transport details never leak. */
export async function catalog(provider: ProviderId, store: AuthStore = authStore()): Promise<ProviderCatalog> {
  if (!(await isSignedIn(store, provider))) return { provider, status: 'signed_out' };
  try {
    return { provider, status: 'ok', models: await catalogReaders[provider](store) };
  } catch (error) {
    const reason = error instanceof Error && /^catalog_http_\d+$/.test(error.message) ? error.message : 'catalog_unreadable';
    return { provider, status: 'unavailable', reason };
  }
}

/** Every provider's catalog, signed in or not. */
export async function catalogs(store: AuthStore = authStore()): Promise<ProviderCatalog[]> {
  return Promise.all(ProviderId.options.map((provider) => catalog(provider, store)));
}
