import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Model providers the person declares once (providers.yaml), for every agent: owner chats and the operator get them
 * through the plugin's config hook, sandboxed hires through their per-hire opencode config. Each is an
 * OpenAI-compatible endpoint (a local Qwen server, a hosted gateway) that opencode reaches through the AI SDK.
 */
export const PROVIDERS_FILE = 'providers.yaml';

/** API key files live here, under the config directory, and nowhere else. */
export const SECRETS_DIRECTORY = 'secrets';

/** The AI SDK package opencode loads for every declared provider. */
export const OPENAI_COMPATIBLE_PACKAGE = '@ai-sdk/openai-compatible';

/**
 * opencode's own providers: a declared provider with one of these ids would silently replace the person's
 * authenticated one (and every model ref that names it), so it is refused.
 */
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'openai', 'anthropic', 'github-copilot', 'google', 'google-vertex', 'amazon-bedrock', 'azure', 'opencode', 'openrouter',
  'mistral', 'groq', 'xai', 'deepseek', 'vercel',
]);

export const ProviderModel = z.object({
  name: z.string().min(1).optional(),
  /** Context window in tokens; with it, opencode knows when to compact. */
  contextTokens: z.number().int().positive().optional(),
  /** Longest reply in tokens; only meaningful beside contextTokens. */
  outputTokens: z.number().int().positive().optional(),
}).refine(model => model.outputTokens === undefined || model.contextTokens !== undefined, {
  message: 'outputTokens needs contextTokens', path: ['outputTokens'],
});
export type ProviderModel = z.infer<typeof ProviderModel>;

export const ProviderDeclaration = z.object({
  name: z.string().min(1).optional(),
  baseURL: z.url({ protocol: /^https?$/ }),
  models: z.record(z.string().min(1), ProviderModel).refine(models => Object.keys(models).length > 0, 'declare at least one model'),
  /** A file under the config directory's secrets/ holding the API key; read at load, never logged. */
  apiKeyFile: z.string().min(1).optional(),
  /** Whether the endpoint honours forced tool choice (opencode's structured output). False: hires ask for JSON in text. */
  structuredOutput: z.boolean().default(true),
});
export type ProviderDeclaration = z.infer<typeof ProviderDeclaration>;

export const ProvidersFile = z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'provider id must be lowercase letters, digits and dashes'), ProviderDeclaration);

/** An API key that prints, serialises and inspects as redacted: only `reveal` gives the value, to opencode's config. */
export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal() {
    return this.#value;
  }

  toString() {
    return '[redacted]';
  }

  toJSON() {
    return '[redacted]';
  }

  [inspect.custom]() {
    return '[redacted]';
  }
}

/** A declared provider as the runtime uses it: its key read from secrets/, the file name gone. */
export type DeclaredProvider = Omit<ProviderDeclaration, 'apiKeyFile'> & { apiKey?: ApiKey };
export type DeclaredProviders = Readonly<Record<string, DeclaredProvider>>;

function issuesText(error: z.ZodError) {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function checkNotBuiltIn(providerId: string) {
  if (BUILT_IN_PROVIDER_IDS.has(providerId)) throw new Error(`provider_reserved: ${PROVIDERS_FILE}: ${providerId} is a built-in opencode provider; choose another id`);
}

/** The key file's contents; the path must stay inside secrets/, and the error never carries the contents. */
async function readApiKey(root: string, providerId: string, keyFile: string) {
  const secrets = join(root, SECRETS_DIRECTORY);
  const path = resolve(root, keyFile);
  if (!path.startsWith(secrets + sep)) throw new Error(`provider_key_outside_secrets: ${providerId}: ${keyFile} is not under ${SECRETS_DIRECTORY}/`);
  const text = await readFile(path, 'utf8').catch(() => undefined);
  const key = text?.trim();
  if (!key) throw new Error(`provider_key_unreadable: ${providerId}: ${relative(root, path)} is missing or empty`);
  return new ApiKey(key);
}

async function resolveProvider(root: string, providerId: string, declaration: ProviderDeclaration): Promise<DeclaredProvider> {
  checkNotBuiltIn(providerId);
  const { apiKeyFile, ...provider } = declaration;
  if (!apiKeyFile) return provider;
  return { ...provider, apiKey: await readApiKey(root, providerId, apiKeyFile) };
}

/** providers.yaml, if the person wrote one; absent, no providers. */
export async function loadProviders(root: string): Promise<DeclaredProviders> {
  const text = await readFile(join(root, PROVIDERS_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return {};
  const parsed = ProvidersFile.safeParse(parse(text) ?? {});
  if (!parsed.success) throw new Error(`providers_invalid: ${PROVIDERS_FILE}: ${issuesText(parsed.error)}`);
  const entries = await Promise.all(Object.entries(parsed.data).map(async ([id, declaration]) => [id, await resolveProvider(root, id, declaration)] as const));
  return Object.fromEntries(entries);
}

/** The shape opencode's config takes under `provider.<id>`. */
export interface OpencodeProvider {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey?: string };
  models: Record<string, { name: string; limit?: { context: number; output: number } }>;
}

/** Longest reply opencode assumes for a model declared with a context window but no output limit. */
export const PROVIDER_DEFAULTS = { outputTokens: 8_192 };

function opencodeModel(modelId: string, model: ProviderModel) {
  const name = model.name ?? modelId;
  if (model.contextTokens === undefined) return { name };
  return { name, limit: { context: model.contextTokens, output: model.outputTokens ?? PROVIDER_DEFAULTS.outputTokens } };
}

function opencodeProvider(providerId: string, provider: DeclaredProvider): OpencodeProvider {
  const apiKey = provider.apiKey?.reveal();
  return {
    npm: OPENAI_COMPATIBLE_PACKAGE,
    name: provider.name ?? providerId,
    options: { baseURL: provider.baseURL, ...(apiKey ? { apiKey } : {}) },
    models: Object.fromEntries(Object.entries(provider.models).map(([modelId, model]) => [modelId, opencodeModel(modelId, model)])),
  };
}

/**
 * The one conversion from declared providers to opencode's `provider` config, used by the plugin's config hook
 * (chats, the operator) and by every sandboxed hire's OPENCODE_CONFIG_CONTENT.
 */
export function opencodeProviders(providers: DeclaredProviders): Record<string, OpencodeProvider> {
  return Object.fromEntries(Object.entries(providers).map(([providerId, provider]) => [providerId, opencodeProvider(providerId, provider)]));
}

/** Whether a model ref names a declared provider that cannot do forced tool choice, so its hires start in text mode. */
export function lacksStructuredOutput(providers: DeclaredProviders, model: string) {
  const providerId = model.split('/')[0]!;
  return providers[providerId]?.structuredOutput === false;
}

/** Text with every declared API key replaced, for errors and logs that quote a process's output. */
export function redactApiKeys(text: string, providers: DeclaredProviders) {
  const keys = Object.values(providers).flatMap(provider => provider.apiKey ? [provider.apiKey.reveal()] : []);
  return keys.reduce((redacted, key) => redacted.replaceAll(key, '[redacted]'), text);
}
