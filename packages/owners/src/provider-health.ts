import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { redactApiKeys, type DeclaredProviders } from './providers.ts';
import { withRecordLock } from './record-lock.ts';
import type { Runtime } from './runtime.ts';

/**
 * Provider health: when a model provider starts refusing onionsoup's credentials (an expired OpenAI key, a Copilot
 * token that needs re-authorising), every hire and chat on it fails the same way and nobody hears until an owner
 * cannot finish its work. Host code classifies each failed model call; an authentication failure marks its
 * provider failing in `state/provider-health/<provider>.json`, and the next successful call to it clears the mark.
 * The surface shows failing providers in the inbox and as a banner. Detection is reactive: nothing probes.
 */
export const PROVIDER_HEALTH_LIMITS = {
  /** Most recent affected uses kept on a record. */
  affected: 10,
  /** Longest stored error text, after masking. */
  errorChars: 300,
  /** Longest stored affected label (a hire title, an owner id). */
  whatChars: 160,
  /** How long a recovered provider is still shown, as a green confirmation. */
  recoveredShownMs: 10 * 60_000,
};

/** The error opencode puts on an assistant message: the one shape for hires' replies and chats' message events. */
export const AssistantError = z.object({
  name: z.string().optional(),
  data: z.object({ message: z.string().optional(), statusCode: z.number().optional() }).loose().optional(),
}).loose();
export type AssistantError = z.infer<typeof AssistantError>;

/** A failed model call as classification sees it. */
export interface ProviderError {
  name?: string;
  message: string;
  statusCode?: number;
}

export function providerErrorOf(error: AssistantError): ProviderError {
  return { name: error.name, message: error.data?.message ?? '', statusCode: error.data?.statusCode };
}

export type FailureKind = 'auth';

interface FailureSignature {
  kind: FailureKind;
  matches: (error: ProviderError) => boolean;
}

function messageMatches(pattern: RegExp) {
  return (error: ProviderError) => pattern.test(error.message);
}

/**
 * How a failed model call shows that the provider refused the credentials. Each entry is one documented shape; add
 * an entry to recognise another. Rate limits (429), timeouts and model errors are deliberately absent.
 */
export const FAILURE_SIGNATURES: Record<string, FailureSignature> = {
  /** HTTP 401: the credentials were not accepted. */
  httpUnauthorized: { kind: 'auth', matches: error => error.statusCode === 401 },
  /** HTTP 403: the credentials are not allowed to use this API (revoked key, lapsed Copilot seat). */
  httpForbidden: { kind: 'auth', matches: error => error.statusCode === 403 },
  /** opencode's own error when a provider has no usable login. */
  providerAuthError: { kind: 'auth', matches: error => error.name === 'ProviderAuthError' },
  /** OpenAI: "Incorrect API key provided: sk-…". */
  incorrectApiKey: { kind: 'auth', matches: messageMatches(/Incorrect API key/i) },
  /** OpenAI and compatible gateways: the `invalid_api_key` error code. */
  invalidApiKeyCode: { kind: 'auth', matches: messageMatches(/invalid_api_key/i) },
  /** Anthropic, Google and gateways: "API key is invalid", "API key expired", "API key missing". */
  apiKeyState: { kind: 'auth', matches: messageMatches(/API key (?:is |has )?(?:invalid|expired|missing|not valid)/i) },
  /** Most HTTP stacks when the status is only in the text. */
  unauthorized: { kind: 'auth', matches: messageMatches(/\bUnauthori[sz]ed\b/i) },
  /** "authentication failed", "authentication_error" (Anthropic's error type). */
  authenticationFailed: { kind: 'auth', matches: messageMatches(/authentication[ _](?:failed|error)/i) },
  /** GitHub Copilot: an expired or revoked token. */
  tokenExpired: { kind: 'auth', matches: messageMatches(/\btoken (?:has )?expired\b|\bexpired token\b/i) },
  /** GitHub: "Bad credentials". */
  badCredentials: { kind: 'auth', matches: messageMatches(/Bad credentials/i) },
};

/** Which signature a failure matches, or undefined for a failure that is not the provider refusing credentials. */
export function classifyProviderFailure(error: ProviderError) {
  const match = Object.entries(FAILURE_SIGNATURES).find(([, signature]) => signature.matches(error));
  return match && { kind: match[1].kind, signature: match[0] };
}

/** Key-like text: provider keys, GitHub tokens, bearer values, long base64 or hex runs. */
const KEY_LIKE: readonly RegExp[] = [
  /\bsk-[\w*.…-]*[\w*…]/g,
  /\b(?:gh[pousr]_|github_pat_)\w+/g,
  /\bBearer\s+\S+/gi,
  /[A-Za-z0-9+/_=-]{32,}/g,
  /\b[a-f0-9]{24,}\b/gi,
];

/** Text with every key-like run masked. Used where the declared keys are not at hand. */
export function maskKeyLike(text: string) {
  return KEY_LIKE.reduce((masked, pattern) => masked.replace(pattern, '[masked]'), text);
}

/** Text safe to store and show: declared keys redacted, then anything key-like masked. */
export function maskCredentials(text: string, providers: DeclaredProviders) {
  return maskKeyLike(redactApiKeys(text, providers));
}

/** What was using the provider when it failed. */
export const AffectedUse = z.object({
  kind: z.enum(['hire', 'chat', 'watcher']),
  /** A hire's title, or the owner whose chat or watcher it was. */
  what: z.string().max(PROVIDER_HEALTH_LIMITS.whatChars),
  at: z.string(),
});
export type AffectedUse = z.infer<typeof AffectedUse>;
export type ProviderUse = Omit<AffectedUse, 'at'>;

/** opencode provider ids; anything else (a path, an empty id) is never used as a file name. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const ProviderHealthRecord = z.object({
  provider: z.string().regex(PROVIDER_ID),
  status: z.enum(['failing', 'ok']),
  /** When the current (or last) failing spell began. */
  since: z.string(),
  lastFailureAt: z.string(),
  /** Authentication failures in the current (or last) failing spell. */
  failures: z.number().int().nonnegative(),
  affected: z.array(AffectedUse).max(PROVIDER_HEALTH_LIMITS.affected),
  /** Masked and clipped: never a key. */
  lastError: z.string().max(PROVIDER_HEALTH_LIMITS.errorChars),
  recoveredAt: z.string().optional(),
});
export type ProviderHealthRecord = z.infer<typeof ProviderHealthRecord>;

/** One record per provider, written under a cross-process lock (daemon, plugin, CLI), replaced atomically. */
export class ProviderHealthStore {
  constructor(readonly directory: string) {}

  async get(provider: string) {
    const text = await readFile(this.path(provider), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    return text === undefined ? undefined : ProviderHealthRecord.parse(JSON.parse(text));
  }

  async list() {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    const records = await Promise.allSettled(names.map(name => this.get(name.slice(0, -'.json'.length))));
    return records.flatMap((record, index) => {
      if (record.status === 'fulfilled' && record.value) return [record.value];
      if (record.status === 'rejected') console.warn(`provider_health_record_unreadable: ${names[index]}`);
      return [];
    });
  }

  /** Change a provider's record under its lock; `change` returns undefined to leave it as it is. */
  async update(provider: string, change: (current: ProviderHealthRecord | undefined) => ProviderHealthRecord | undefined) {
    return withRecordLock(`${this.path(provider)}.lock`, async () => {
      const current = await this.get(provider);
      const next = change(current);
      if (next) await this.write(ProviderHealthRecord.parse(next));
      return { previous: current, current: next ?? current };
    });
  }

  private async write(record: ProviderHealthRecord) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path(record.provider)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, this.path(record.provider));
  }

  private path(provider: string) {
    return join(this.directory, `${provider}.json`);
  }
}

/** The provider of a model ref `provider/model`. */
export function providerOf(model: string) {
  return model.split('/')[0] ?? '';
}

function failingRecord(current: ProviderHealthRecord | undefined, provider: string, use: AffectedUse, lastError: string): ProviderHealthRecord {
  const continuing = current?.status === 'failing' ? current : undefined;
  return {
    provider,
    status: 'failing',
    since: continuing?.since ?? use.at,
    lastFailureAt: use.at,
    failures: (continuing?.failures ?? 0) + 1,
    affected: [...(continuing?.affected ?? []), use].slice(-PROVIDER_HEALTH_LIMITS.affected),
    lastError,
  };
}

function isStartOfFailure(previous: ProviderHealthRecord | undefined) {
  return previous?.status !== 'failing';
}

/**
 * Note a failed model call. An authentication failure marks its provider failing (and says so once, in the log, when
 * the spell begins); anything else is left alone. Never throws: a failed record must not hide the call's own error.
 */
export async function recordProviderFailure(runtime: Runtime, provider: string, use: ProviderUse, error: ProviderError) {
  if (!PROVIDER_ID.test(provider) || !classifyProviderFailure(error)) return undefined;
  const providers = runtime.declarations.providers;
  const lastError = maskCredentials(`${error.name ? `${error.name}: ` : ''}${error.message}`, providers).slice(0, PROVIDER_HEALTH_LIMITS.errorChars);
  const affected = { kind: use.kind, what: maskCredentials(use.what, providers).slice(0, PROVIDER_HEALTH_LIMITS.whatChars), at: new Date().toISOString() };
  try {
    const { previous, current } = await runtime.providerHealth.update(provider, existing => failingRecord(existing, provider, affected, lastError));
    if (isStartOfFailure(previous)) console.error(`[provider] ${provider}: authentication failing (${affected.kind} ${affected.what}): ${lastError}`);
    return current;
  } catch (failure) {
    console.warn(`provider_health_write_failed: ${provider}: ${failure instanceof Error ? failure.message : String(failure)}`);
    return undefined;
  }
}

function recoveredRecord(current: ProviderHealthRecord | undefined): ProviderHealthRecord | undefined {
  if (current?.status !== 'failing') return undefined;
  return { ...current, status: 'ok', recoveredAt: new Date().toISOString() };
}

/**
 * Note a successful model call: a failing provider is marked recovered. Cheap when the provider is fine (one read, no
 * lock, no write), since chats call this for every finished message. Never throws.
 */
export async function recordProviderSuccess(runtime: Runtime, provider: string) {
  if (!PROVIDER_ID.test(provider)) return;
  try {
    if ((await runtime.providerHealth.get(provider))?.status !== 'failing') return;
    const { previous, current } = await runtime.providerHealth.update(provider, recoveredRecord);
    if (previous?.status === 'failing' && current?.status === 'ok') console.log(`[provider] ${provider}: authentication recovered after ${current.failures} failures`);
  } catch (failure) {
    console.warn(`provider_health_write_failed: ${provider}: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}

/** What the person runs to fix a provider's credentials, for providers opencode logs in to itself. */
export const PROVIDER_FIX_HINTS: Record<string, string> = {
  openai: 'Run `opencode auth login` and choose OpenAI (or replace the API key opencode uses for OpenAI).',
  'github-copilot': 'Run `opencode auth login` and choose GitHub Copilot to re-authorise.',
};

const DECLARED_PROVIDER_HINT = 'Check the endpoint and the key file named for this provider in providers.yaml.';

/** Names people know providers by. */
const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI', 'github-copilot': 'GitHub Copilot', anthropic: 'Anthropic', google: 'Google', openrouter: 'OpenRouter',
};

export function providerFixHint(provider: string, declared: DeclaredProviders) {
  const declaredHint = declared[provider] ? DECLARED_PROVIDER_HINT : undefined;
  return PROVIDER_FIX_HINTS[provider] ?? declaredHint ?? `Run \`opencode auth login\` and choose ${provider}.`;
}

export function providerName(provider: string, declared: DeclaredProviders) {
  return PROVIDER_NAMES[provider] ?? declared[provider]?.name ?? provider;
}

/** A provider's health as the surface shows it: the record, its display name and the fix. */
export type ProviderHealthView = ProviderHealthRecord & { name: string; fix: string };

function isShown(record: ProviderHealthRecord, now: number) {
  if (record.status === 'failing') return true;
  return Boolean(record.recoveredAt) && now - Date.parse(record.recoveredAt!) < PROVIDER_HEALTH_LIMITS.recoveredShownMs;
}

/** Failing providers, and those recovered recently enough to confirm it, failing first. */
export async function providerHealthViews(runtime: Runtime, now = Date.now()): Promise<ProviderHealthView[]> {
  const declared = runtime.declarations.providers;
  const shown = (await runtime.providerHealth.list()).filter(record => isShown(record, now));
  const views = shown.map(record => ({ ...record, name: providerName(record.provider, declared), fix: providerFixHint(record.provider, declared) }));
  return views.sort((left, right) => left.status.localeCompare(right.status) || left.provider.localeCompare(right.provider));
}

/** An assistant message update from opencode's event stream, as provider health and friction read it. */
export const AssistantMessageEvent = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    info: z.object({
      sessionID: z.string(),
      role: z.literal('assistant'),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      error: AssistantError.optional(),
      time: z.object({ completed: z.number().optional() }).loose().optional(),
    }).loose(),
  }),
});
export type AssistantMessageInfo = z.infer<typeof AssistantMessageEvent>['properties']['info'];

/** What an assistant message says about its provider: failed, finished cleanly, or nothing yet (still streaming). */
export function assistantOutcome(info: AssistantMessageInfo) {
  if (info.error) return { outcome: 'failed' as const, error: providerErrorOf(info.error) };
  if (info.time?.completed) return { outcome: 'succeeded' as const };
  return undefined;
}
