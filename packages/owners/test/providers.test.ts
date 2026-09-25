import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test } from 'node:test';
import type { Config, Plugin } from '@opencode-ai/plugin';
import { Verdict } from '../src/artifacts.ts';
import { loadDeclarations } from '../src/declarations.ts';
import { familyOf, pickModel } from '../src/families.ts';
import { agentConfig, hireWithFallback } from '../src/opencode.ts';
import { redactApiKeys } from '../src/providers.ts';
import { withActiveHooks } from './active-hooks.ts';

const fixture = 'packages/owners/test/fixtures/owners';
const HALOGEN_MODEL = 'halogen/halogen-qwen3.8-flash-next';
const API_KEY = 'sk-halogen-test-9f8e7d6c5b4a';

const HALOGEN_YAML = `halogen:
  name: Halogen (selfie)
  baseURL: http://10.0.1.200:8731/v1
  models:
    halogen-qwen3.8-flash-next:
      contextTokens: 78000
`;

/** The test fixture's configuration, copied, with the given providers.yaml and extra files. */
async function configWith(providersYaml: string | undefined, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-providers-config-'));
  await cp(fixture, root, { recursive: true });
  if (providersYaml !== undefined) await writeFile(join(root, 'providers.yaml'), providersYaml);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
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

type ScriptedReply = { format?: unknown; text: string };

/** A hire client whose structured replies fail with `structuredError` and whose text replies answer `textReply`. */
function scriptedClient(prompts: ScriptedReply[], structuredError: string | undefined, textReply: () => object) {
  return {
    session: {
      create: async () => ({ data: { id: `ses_${prompts.length}` } }),
      abort: async () => ({ data: true }),
      prompt: async (options: { format?: unknown; parts: { text: string }[] }) => {
        prompts.push({ format: options.format, text: options.parts[0]!.text });
        if (options.format && structuredError) return { data: { info: { role: 'assistant', error: { name: 'StructuredOutputError', data: { message: structuredError } } } } };
        return { data: textReply() };
      },
    },
    permission: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
  } as unknown as Parameters<typeof hireWithFallback>[0];
}

const APPROVAL = { info: { role: 'assistant', cost: 0 }, parts: [{ type: 'text', text: '{"decision":"approve","summary":"Fine","findings":[]}' }] };

function reviewRequest(model: string) {
  return { role: 'reviewer' as const, model, directory: '/tmp', title: 'w-1: review', brief: 'Review it.', schema: Verdict };
}

test('providers.yaml is optional; a declared provider gets its defaults and validates as a model ref', async () => {
  assert.deepEqual((await loadDeclarations(fixture)).providers, {}, 'no file, no providers');
  const declarations = await loadDeclarations(await configWith(HALOGEN_YAML, { 'operator.yaml': `model: ${HALOGEN_MODEL}\n` }));
  assert.deepEqual(declarations.providers, {
    halogen: { name: 'Halogen (selfie)', baseURL: 'http://10.0.1.200:8731/v1', models: { 'halogen-qwen3.8-flash-next': { contextTokens: 78000 } }, structuredOutput: true },
  });
  assert.equal(declarations.operator?.model, HALOGEN_MODEL);
});

test('an API key is read from secrets/ at load and never prints', async () => {
  const yaml = `${HALOGEN_YAML}  apiKeyFile: secrets/halogen.key\n`;
  const declarations = await loadDeclarations(await configWith(yaml, { 'secrets/halogen.key': `${API_KEY}\n` }));
  const halogen = declarations.providers.halogen!;
  assert.equal(halogen.apiKey?.reveal(), API_KEY);
  assert.equal('apiKeyFile' in halogen, false);
  for (const printed of [JSON.stringify(declarations.providers), inspect(declarations.providers, { depth: 5 }), `${halogen.apiKey}`]) {
    assert.doesNotMatch(printed, new RegExp(API_KEY));
  }
});

test('an invalid providers.yaml is refused with a specific reason', async () => {
  const refusals: [string, Record<string, string>, RegExp][] = [
    ['halogen:\n  baseURL: not a url\n  models: { m: {} }\n', {}, /^Error: providers_invalid: providers\.yaml: halogen\.baseURL: /],
    ['halogen:\n  baseURL: http://10.0.1.200:8731/v1\n  models: {}\n', {}, /providers_invalid: providers\.yaml: halogen\.models: declare at least one model/],
    ['halogen:\n  baseURL: http://h/v1\n  models: { m: { outputTokens: 10 } }\n', {}, /halogen\.models\.m\.outputTokens: outputTokens needs contextTokens/],
    ['openai:\n  baseURL: http://10.0.1.200:8731/v1\n  models: { m: {} }\n', {}, /^Error: provider_reserved: providers\.yaml: openai is a built-in opencode provider/],
    [`${HALOGEN_YAML}  apiKeyFile: ../halogen.key\n`, {}, /^Error: provider_key_outside_secrets: halogen: \.\.\/halogen\.key/],
    [`${HALOGEN_YAML}  apiKeyFile: secrets/missing.key\n`, {}, /^Error: provider_key_unreadable: halogen: secrets\/missing\.key is missing or empty/],
    [`${HALOGEN_YAML}  apiKeyFile: secrets/empty.key\n`, { 'secrets/empty.key': '\n' }, /provider_key_unreadable: halogen: secrets\/empty\.key/],
  ];
  for (const [yaml, files, expected] of refusals) await assert.rejects(loadDeclarations(await configWith(yaml, files)), expected, yaml);
});

test('declared providers reach chats through the plugin config hook and hires through their opencode config alike', async () => {
  const yaml = `${HALOGEN_YAML}  apiKeyFile: secrets/halogen.key\n`;
  const declarationsRoot = await configWith(yaml, { 'secrets/halogen.key': API_KEY, 'operator.yaml': `model: ${HALOGEN_MODEL}\n` });
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-providers-state-'));
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } };
  const config: Config = { provider: { mine: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://mine/v1' } }, halogen: { name: 'stale' } } };
  const logs = await capturingLogs(async () => {
    const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations: declarationsRoot, state });
    await hooks.config!(config);
  });
  const halogen = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Halogen (selfie)',
    options: { baseURL: 'http://10.0.1.200:8731/v1', apiKey: API_KEY },
    models: { 'halogen-qwen3.8-flash-next': { name: 'halogen-qwen3.8-flash-next', limit: { context: 78000, output: 8192 } } },
  };
  assert.deepEqual(config.provider?.halogen, halogen, 'the declared provider wins over the person\'s own of the same id');
  assert.deepEqual(config.provider?.mine, { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://mine/v1' } }, 'the person\'s other providers stay');
  assert.equal((config.agent as Record<string, { model?: string }>).Operator?.model, HALOGEN_MODEL);
  const { providers } = await loadDeclarations(declarationsRoot);
  assert.deepEqual(agentConfig('/tmp', '/tmp', undefined, {}, providers).provider, { halogen });
  assert.deepEqual(agentConfig('/tmp', '/tmp', undefined).provider, {}, 'no declared providers, none in the hire');
  assert.ok(logs.every(line => !line.includes(API_KEY)), 'no API key in any log line');
});

test('a hire on a provider without structured output starts in text mode', async () => {
  const { providers } = await loadDeclarations(await configWith(`${HALOGEN_YAML}  structuredOutput: false\n`));
  const prompts: ScriptedReply[] = [];
  const hired = await hireWithFallback(scriptedClient(prompts, 'unexpected', () => APPROVAL), reviewRequest(HALOGEN_MODEL), providers);
  assert.equal(hired.value.decision, 'approve');
  assert.equal(prompts.length, 1, 'no structured round to fail first');
  assert.equal(prompts[0]!.format, undefined);
  assert.match(prompts[0]!.text, /matches this JSON Schema/);
});

test('a model that answers without structured output is retried once in text mode, and remembered', async () => {
  const prompts: ScriptedReply[] = [];
  const client = scriptedClient(prompts, 'Model did not produce structured output', () => APPROVAL);
  const request = reviewRequest('halogen/answers-in-prose');
  const logs = await capturingLogs(async () => {
    assert.equal((await hireWithFallback(client, request)).value.decision, 'approve');
  });
  assert.deepEqual(prompts.map(prompt => Boolean(prompt.format)), [true, false]);
  assert.ok(logs.some(line => /halogen\/answers-in-prose did not produce structured output; asking for the JSON in its reply instead/.test(line)));
  await hireWithFallback(client, request);
  assert.equal(prompts.length, 3, 'its next hire starts in text mode');
  assert.equal(prompts[2]!.format, undefined);
});

test('a text-mode retry that fails too surfaces its failure; there is no third round', async () => {
  const prompts: ScriptedReply[] = [];
  const failing = { info: { role: 'assistant', error: { name: 'APIError', data: { message: 'upstream_down' } } } };
  const client = scriptedClient(prompts, 'Model did not produce structured output', () => failing);
  await capturingLogs(async () => {
    await assert.rejects(hireWithFallback(client, reviewRequest('halogen/fails-twice')), /APIError: upstream_down/);
  });
  assert.equal(prompts.length, 2);
});

test('server output quoted in a hire error has every declared API key redacted', async () => {
  const yaml = `${HALOGEN_YAML}  apiKeyFile: secrets/halogen.key\n`;
  const { providers } = await loadDeclarations(await configWith(yaml, { 'secrets/halogen.key': API_KEY }));
  assert.equal(redactApiKeys(`config error near "apiKey":"${API_KEY}"`, providers), 'config error near "apiKey":"[redacted]"');
});

test('a declared provider\'s models join cross-family review once families.yaml names their family', async () => {
  const families = { families: [{ family: 'anthropic', match: ['github-copilot/claude-*'] }, { family: 'qwen', match: ['halogen/*'] }] };
  assert.equal(familyOf(families, HALOGEN_MODEL), 'qwen');
  assert.deepEqual(pickModel(families, ['github-copilot/claude-sonnet-5', HALOGEN_MODEL], ['anthropic']), { model: HALOGEN_MODEL, family: 'qwen' });
  assert.throws(() => familyOf({ families: [] }, HALOGEN_MODEL), /unknown_model_family: halogen\/halogen-qwen3\.8-flash-next; add a family whose match covers it to families\.yaml/);
});
