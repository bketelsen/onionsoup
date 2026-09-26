import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { Verdict } from '../src/artifacts.ts';
import type { ConnectHire, HireSessionClient } from '../src/opencode.ts';
import {
  classifyProviderFailure, FAILURE_SIGNATURES, ProviderHealthRecord, providerHealthViews, recordProviderFailure,
  type ProviderError,
} from '../src/provider-health.ts';
import { ApiKey } from '../src/providers.ts';
import { maskKeyLike } from '../src/secret-shapes.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';

const declarations = 'packages/owners/test/fixtures/owners';
/** The shape of the incident's error, with a whole key in it (OpenAI truncates, a gateway may not). */
const RAW_KEY = 'sk-svcacct-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';
const INCORRECT_KEY: ProviderError = {
  name: 'APIError', statusCode: 401,
  message: `Incorrect API key provided: ${RAW_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
};

async function openRuntime() {
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-provider-health-'));
  return { runtime: await Runtime.open({ declarations, state }), state };
}

async function storedRecord(state: string, provider: string) {
  const text = await readFile(join(state, 'provider-health', `${provider}.json`), 'utf8');
  return { text, record: ProviderHealthRecord.parse(JSON.parse(text)) };
}

/** Everything written to stderr and the console while `body` runs. */
async function capturingLogs(body: () => Promise<void>) {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) console[name] = (...args: unknown[]) => written.push(args.map(arg => inspect(arg)).join(' '));
  try {
    await body();
  } finally {
    process.stderr.write = originalWrite;
    Object.assign(console, originals);
  }
  return written;
}

test('each documented auth signature classifies as auth; rate limits, timeouts and model errors do not', () => {
  const samples: Record<keyof typeof FAILURE_SIGNATURES, ProviderError> = {
    httpUnauthorized: { name: 'APIError', message: 'request failed', statusCode: 401 },
    httpForbidden: { name: 'APIError', message: 'request failed', statusCode: 403 },
    providerAuthError: { name: 'ProviderAuthError', message: 'no credentials for openai' },
    incorrectApiKey: { name: 'APIError', message: 'Incorrect API key provided: sk-svcac***abcd.' },
    invalidApiKeyCode: { message: '{"error":{"code":"invalid_api_key"}}' },
    apiKeyState: { message: 'API key expired. Please renew the API key.' },
    unauthorized: { message: '401 Unauthorized' },
    authenticationFailed: { message: '{"type":"authentication_error","message":"invalid x-api-key"}' },
    tokenExpired: { message: 'IDE token expired: unauthorized: token expired' },
    badCredentials: { message: 'Bad credentials' },
  };
  for (const [signature, error] of Object.entries(samples)) {
    assert.equal(classifyProviderFailure(error)?.kind, 'auth', signature);
  }
  const notAuth: ProviderError[] = [
    { name: 'APIError', message: 'Rate limit reached for gpt-6-sol', statusCode: 429 },
    { name: 'APIError', message: 'Request timed out', statusCode: 504 },
    { name: 'MessageAbortedError', message: 'The operation was aborted.' },
    { name: 'APIError', message: 'tool_choice: type "tool" and "any" are not supported for this model.', statusCode: 400 },
  ];
  for (const error of notAuth) assert.equal(classifyProviderFailure(error), undefined, error.message);
});

test('key-like text is masked: provider keys, GitHub tokens, bearer values, long runs', () => {
  const text = 'sk-svcac****abcd ghu_abcDEF123 github_pat_11AAAA_bbbb Bearer eyJhbGciOi abcdef0123456789abcdef0123456789';
  assert.equal(maskKeyLike(text), '[masked] [masked] [masked] [masked] [masked]');
  assert.equal(maskKeyLike('Incorrect API key provided: sk-svcac***ab12. See the docs.'), 'Incorrect API key provided: [masked]. See the docs.');
});

test('an auth failure is stored masked, and neither the record nor any log line carries the key', async () => {
  const { runtime, state } = await openRuntime();
  const declaredKey = 'halogen-declared-key-value';
  runtime.declarations = { ...runtime.declarations, providers: { halogen: { baseURL: 'http://h/v1', models: { m: {} }, structuredOutput: true, apiKey: new ApiKey(declaredKey) } } };
  const logs = await capturingLogs(async () => {
    await recordProviderFailure(runtime, 'openai', { kind: 'chat', what: 'homelab' }, INCORRECT_KEY);
    await recordProviderFailure(runtime, 'halogen', { kind: 'hire', what: 'w-1: review' }, { message: `Unauthorized: key ${declaredKey} refused` });
  });
  const { text, record } = await storedRecord(state, 'openai');
  assert.equal(record.status, 'failing');
  assert.match(record.lastError, /^APIError: Incorrect API key provided: \[masked\]\./);
  assert.doesNotMatch(text, /Zx9Qw8Er7Ty6/);
  const halogen = await storedRecord(state, 'halogen');
  assert.doesNotMatch(halogen.text, new RegExp(declaredKey));
  assert.ok(logs.some(line => /\[provider\] openai: authentication failing \(chat homelab\)/.test(line)), 'the first failure is logged');
  assert.ok(logs.every(line => !line.includes('Zx9Qw8Er7Ty6') && !line.includes(declaredKey)), 'no key in any log line');
});

type Reply = { data: object };

/** A hire's opencode, scripted: every prompt answers with the next reply. */
function scriptedConnection(replies: Reply[]): ConnectHire {
  const client = {
    session: {
      create: async () => ({ data: { id: 'ses_hire' } }),
      abort: async () => ({ data: true }),
      prompt: async () => replies.shift() ?? { data: {} },
    },
    permission: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
  } as unknown as HireSessionClient;
  return async () => ({ client, close: () => undefined });
}

const REFUSED: Reply = { data: { info: { role: 'assistant', error: { name: 'APIError', data: { message: INCORRECT_KEY.message, statusCode: 401 } } } } };
const APPROVED: Reply = { data: { info: { role: 'assistant', cost: 0, structured: { decision: 'approve', summary: 'Fine', findings: [] } } } };

test('a hire refused for its API key marks the provider failing; a later delivered hire marks it recovered', async () => {
  const { runtime, state } = await openRuntime();
  const request = { role: 'reviewer' as const, model: 'openai/gpt-6-sol', directory: state, title: 'w-1: review', brief: 'Review it.', schema: Verdict };
  runtime.connectHire = scriptedConnection([REFUSED]);
  await capturingLogs(async () => {
    await assert.rejects(runtime.hire('clippy', request), (error: Error) => /^APIError: Incorrect API key provided: \[masked\]/.test(error.message));
  });
  const failing = (await storedRecord(state, 'openai')).record;
  assert.equal(failing.status, 'failing');
  assert.equal(failing.failures, 1);
  assert.deepEqual(failing.affected.map(use => [use.kind, use.what]), [['hire', 'w-1: review']]);
  assert.equal((await providerHealthViews(runtime))[0]?.fix, 'Run `opencode auth login` and choose OpenAI (or replace the API key opencode uses for OpenAI).');

  runtime.connectHire = scriptedConnection([APPROVED]);
  await capturingLogs(async () => {
    assert.equal((await runtime.hire('clippy', request)).value.decision, 'approve');
  });
  const recovered = (await storedRecord(state, 'openai')).record;
  assert.equal(recovered.status, 'ok');
  assert.ok(recovered.recoveredAt);
  assert.equal(recovered.failures, 1, 'the spell it recovered from is kept');
});

function assistantUpdate(sessionID: string, info: Record<string, unknown>) {
  return { event: { type: 'message.updated', properties: { info: { sessionID, role: 'assistant', providerID: 'openai', modelID: 'gpt-5.6-luna', ...info } } } } as never;
}

test('a chat message refused for its API key marks the provider failing; a finished message clears it', async () => {
  const { runtime, state } = await openRuntime();
  const client = { session: { get: async () => ({ data: {} }) } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  await hooks['chat.message']!({ sessionID: 'ses_owner', agent: 'Miles Teg' }, {} as never);
  const error = { name: 'APIError', data: { message: INCORRECT_KEY.message, statusCode: 401 } };
  await capturingLogs(async () => {
    await hooks.event!(assistantUpdate('ses_owner', { error, time: { created: 1, completed: 2 } }));
  });
  const failing = (await storedRecord(state, 'openai')).record;
  assert.equal(failing.status, 'failing');
  assert.deepEqual(failing.affected.map(use => [use.kind, use.what]), [['chat', 'homelab']]);
  assert.equal((await providerHealthViews(runtime)).length, 1);

  await hooks.event!(assistantUpdate('ses_owner', { time: { created: 3 } }));
  assert.equal((await storedRecord(state, 'openai')).record.status, 'failing', 'a message still streaming says nothing yet');
  await capturingLogs(async () => {
    await hooks.event!(assistantUpdate('ses_owner', { time: { created: 3, completed: 4 }, finish: 'stop' }));
  });
  const recovered = (await storedRecord(state, 'openai')).record;
  assert.equal(recovered.status, 'ok');
  assert.ok(recovered.recoveredAt);
});
