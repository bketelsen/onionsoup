import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Plugin } from '@opencode-ai/plugin';
import { canChange, loadDeclarations } from '../src/declarations.ts';
import { checkOwnerChatNames, ownerChatAgent, observationChatPermission, OBSERVATION_TOOLS } from '../src/owner-chat.ts';
import { withActiveHooks } from './active-hooks.ts';
import { Runtime } from '../src/runtime.ts';
import { setReminder, openDueReminders } from '../src/reminder-work.ts';
import { chatDirectory } from '../src/chats.ts';

test('fallback identity does not change repository authority or existing persona agent names', async () => {
  const declarations = await loadDeclarations('packages/owners/test/fixtures/owners');
  const owner = declarations.owners.get('clippy')!;
  assert.equal(ownerChatAgent(owner), 'Clippy');
  assert.equal(canChange(owner), true);
  owner.persona = undefined;
  assert.equal(ownerChatAgent(owner), 'onionsoup-owner-clippy');
  assert.equal(canChange(owner), false);
  const other = declarations.owners.get('bellonda')!;
  other.persona!.name = 'Onionsoup-owner-clippy';
  assert.throws(() => checkOwnerChatNames(declarations.owners), /owner_chat_agent_collision/);
  other.persona!.name = 'Bellonda';
  assert.throws(() => checkOwnerChatNames(declarations.owners, { name: 'Onionsoup-owner-clippy', model: 'fixture/model',
    directory: '/fixture', title: 'Operator', icon: 'terminal', ask: [] }), /owner_chat_agent_collision/);
});

test('registered fallback denies writes, shell, subagents, MCP and direct effect tool calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-chat-'));
  const declarations = join(root, 'config');
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  const path = join(declarations, 'owners/clippy.yaml');
  const contents = await readFile(path, 'utf8');
  await writeFile(path, contents.replace(/^persona:.*\n/m, '') + '\nconversation: { edit: allow, bash: { "*": allow }, webfetch: allow }\nmcp:\n  unsafe:\n    command: [/bin/false]\n    rules: { "*": allow }\n');
  const state = join(root, 'state');
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  const config: Config = {};
  await hooks.config!(config);
  const agents = config.agent as Record<string, { permission: Record<string, unknown>; prompt: string }>;
  assert.deepEqual(agents['onionsoup-owner-clippy'].permission, observationChatPermission());
  assert.equal(agents.Bellonda.permission.edit, 'allow', 'declared repository personas can work locally');
  assert.equal(agents['onionsoup-reviewer-clippy'], undefined);
  assert.ok(agents['onionsoup-reviewer-bellonda']);
  assert.doesNotMatch(JSON.stringify(config.mcp), /unsafe/);
  assert.match(agents['onionsoup-owner-clippy'].prompt, /cannot request follow-up work/);
  const context = { agent: 'onionsoup-owner-clippy', sessionID: 'fixture', messageID: 'message', directory: root,
    abort: new AbortController().signal, metadata() {}, ask: async () => {} };
  const allowed = new Set<string>(OBSERVATION_TOOLS);
  const effectTools = Object.entries(hooks.tool!).filter(([name]) => !allowed.has(name));
  assert.ok(effectTools.some(([name]) => name === 'onionsoup_wiki'));
  assert.ok(effectTools.some(([name]) => name === 'onionsoup_submit_plan'));
  for (const [name, definition] of effectTools) {
    // Deliberately omit arguments: host identity denial must precede parsing, dispatch or effects.
    await assert.rejects(definition.execute({}, context as never), /owner_chat_observation_only/, name);
  }
  await assert.rejects(hooks.tool!.onionsoup_ask.execute({ owner: 'bellonda', question: 'Fix it', followUp: true }, context as never), /observation_only/);
  await assert.rejects(hooks.tool!.onionsoup_record_fact.execute({ fact: 'No', source: 'No' }, context as never), /observation_only/);
  const notebook = await hooks.tool!.onionsoup_notebook.execute({ register: 'all' }, context as never);
  assert.equal(typeof notebook, 'string');
  const runtime = await Runtime.open({ declarations, state });
  assert.equal((await runtime.requests.list()).length, 0);
  assert.equal((await runtime.ledger.list()).length, 0);
  const directory = await chatDirectory(runtime, 'clippy');
  assert.equal(directory, runtime.owner('clippy').workspace);
  assert.deepEqual(await readdir(directory), [], 'opening fallback chat never clones or creates a writable desk');
  const reminder = await setReminder(runtime, 'clippy', { after: '1d', prompt: 'Legacy pending reminder' });
  await openDueReminders(runtime, { create: async () => { throw new Error('fallback reminder must not wake'); },
    prompt: async () => { throw new Error('fallback reminder must not prompt'); }, remove: async () => {},
    activity: async () => ({ isBusy: false, updatedAt: undefined }) }, (_id, error) => { throw error; },
  new Date(Date.now() + 2 * 86_400_000));
  assert.equal((await runtime.reminders.get(reminder.id)).status, 'pending');
  runtime.close();
});


test('fallback collision checks do not introduce new rejection of existing persona names', async () => {
  const declarations = await loadDeclarations('packages/owners/test/fixtures/owners');
  const clippy = declarations.owners.get('clippy')!;
  const bellonda = declarations.owners.get('bellonda')!;
  clippy.persona!.name = 'Existing-name';
  bellonda.persona!.name = 'Existing-Name';
  assert.doesNotThrow(() => checkOwnerChatNames(declarations.owners));
  clippy.persona!.name = 'Onionsoup-watcher';
  bellonda.persona!.name = 'Onionsoup-implementer';
  assert.doesNotThrow(() => checkOwnerChatNames(declarations.owners));
  clippy.persona = undefined;
  bellonda.persona!.name = 'Onionsoup-owner-clippy';
  assert.throws(() => checkOwnerChatNames(declarations.owners), /owner_chat_agent_collision/);
});
