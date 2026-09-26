import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config, Plugin } from '@opencode-ai/plugin';
import { bashAction } from '../src/bash-rules.ts';
import { loadDeclarations, OPERATOR_ID } from '../src/declarations.ts';
import { BOOTSTRAP_SKILL, IMPLEMENTER_AGENT, OPERATOR_SKILLS, OPERATOR_SKILLS_DIRECTORY, SKILLS_DIRECTORY } from '../src/owner-agents.ts';
import { OPERATOR_ASK_BASH, operatorChatDirectory } from '../src/operator.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';

const fixture = 'packages/owners/test/fixtures/owners';

/** The test fixture's configuration, copied, with an operator.yaml of the given text. */
async function configWithOperator(operatorYaml: string) {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-operator-config-'));
  await cp(fixture, root, { recursive: true });
  await writeFile(join(root, 'operator.yaml'), operatorYaml);
  return root;
}

const OPERATOR_YAML = 'model: github-copilot/gpt-6-sol\nask: ["systemctl --user stop*"]\n';

test('operator.yaml is optional, and its defaults name a generic operator working in ~/projects', async () => {
  assert.equal((await loadDeclarations(fixture)).operator, undefined, 'no file, no operator');
  const operator = (await loadDeclarations(await configWithOperator('model: github-copilot/gpt-6-sol\n'))).operator;
  assert.deepEqual(operator, {
    name: 'Operator', title: 'Acts for you', icon: 'terminal', model: 'github-copilot/gpt-6-sol', directory: join(homedir(), 'projects'), ask: [],
  });
  const named = (await loadDeclarations(await configWithOperator('name: Duncan Idaho\ntitle: Swordmaster\nicon: shield\nmodel: a/b\ndirectory: ~/work\n'))).operator;
  assert.equal(named?.name, 'Duncan Idaho');
  assert.equal(named?.title, 'Swordmaster');
  assert.equal(named?.icon, 'shield');
  assert.equal(named?.directory, join(homedir(), 'work'), '~ is expanded');
});

test('an invalid operator.yaml is refused with its reason', async () => {
  await assert.rejects(loadDeclarations(await configWithOperator('model: no-provider\n')), /^Error: operator_invalid: operator\.yaml: model: model must be provider\/model/);
  await assert.rejects(loadDeclarations(await configWithOperator('model: a/b\nicon: dragon\n')), /operator_invalid: operator\.yaml: icon/);
});

test('no owner may take the operator\'s id or its name', async () => {
  const root = await configWithOperator('name: Clippy\nmodel: a/b\n');
  await assert.rejects(loadDeclarations(root), /operator_reserved: clippy is called Clippy/);
  const withOwnerId = await configWithOperator(OPERATOR_YAML);
  const homelab = await readFile(join(withOwnerId, 'owners', 'homelab.yaml'), 'utf8');
  await writeFile(join(withOwnerId, 'owners', 'operator.yaml'), homelab.replace('id: homelab', 'id: operator').replace('Miles Teg', 'Other Name'));
  await assert.rejects(loadDeclarations(withOwnerId), /operator_reserved: no owner may have the id operator/);
});

type Agent = { mode?: string; model?: string; prompt?: string; permission?: Record<string, unknown> };

async function operatorHooks(parents: Record<string, string | undefined> = {}) {
  const declarations = await configWithOperator(OPERATOR_YAML);
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-operator-state-'));
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents[path.id] } }) } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  const config: Config = {};
  await hooks.config!(config);
  return { hooks, config, agents: config.agent as Record<string, Agent>, runtime: await Runtime.open({ declarations, state }) };
}

test('the operator agent allows nearly everything, and irreversible commands and person gates ask', async () => {
  const { agents } = await operatorHooks();
  const operator = agents.Operator!;
  assert.equal(operator.mode, 'primary');
  assert.equal(operator.model, 'github-copilot/gpt-6-sol');
  const permission = operator.permission!;
  for (const key of ['edit', 'webfetch', 'websearch', 'external_directory', 'task', 'question']) assert.equal(permission[key], 'allow', key);
  assert.equal(permission.doom_loop, 'ask');
  assert.equal(permission['onionsoup_*'], 'deny', 'no owner tools');
  const bash = permission.bash as Record<string, string>;
  assert.equal(Object.keys(bash)[0], '*', 'the allow comes first, so the asks after it win');
  for (const pattern of [...OPERATOR_ASK_BASH, 'systemctl --user stop*']) assert.equal(bash[pattern], 'ask', pattern);
  const decisions: [string, string][] = [
    ['ls -la', 'allow'], ['npm run verify', 'allow'], ['git push origin main', 'allow'], ['rm file.txt', 'allow'],
    ['git push --force origin main', 'ask'], ['git push origin main -f', 'ask'], ['git reset --hard HEAD~1', 'ask'],
    ['rm -rf /tmp/x', 'ask'], ['sudo zfs destroy tank/data', 'ask'], ['incus delete web', 'ask'],
    ['npm run owners -- approve w-20260925-1a2b3c', 'ask'], ['npm run owners -- ship homelab', 'ask'],
    ['systemctl --user stop onionsoup-surface', 'ask'],
  ];
  for (const [command, expected] of decisions) assert.equal(bashAction(bash, command), expected, command);
  assert.match(operator.prompt!, /ONIONSOUP_CONFIG/);
  assert.match(operator.prompt!, /Never approve or revise an owner's plan/);
});

test('the operator loads the operating skills, and owners and their subagents cannot', async () => {
  const { config, agents } = await operatorHooks();
  assert.deepEqual((config as { skills?: { paths?: string[] } }).skills?.paths, [SKILLS_DIRECTORY, OPERATOR_SKILLS_DIRECTORY]);
  const shipped = (await readdir(OPERATOR_SKILLS_DIRECTORY, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== 'TEMPLATE').map(entry => entry.name);
  assert.deepEqual(shipped.sort(), [...OPERATOR_SKILLS].sort(), 'the denied list follows the skills in .agents/skills');
  assert.deepEqual(agents.Operator!.permission!.skill, { '*': 'allow', [BOOTSTRAP_SKILL]: 'deny' });
  for (const name of ['Miles Teg', IMPLEMENTER_AGENT]) {
    const skill = agents[name]!.permission!.skill as Record<string, string>;
    for (const operating of OPERATOR_SKILLS) assert.equal(skill[operating], 'deny', `${name}: ${operating}`);
  }
});

test('owners cannot reach the operator, and the operator cannot use owner tools', async () => {
  const { hooks, agents } = await operatorHooks();
  const roster = /<roster>([\s\S]*?)<\/roster>/.exec(agents['Miles Teg']!.prompt!)![1]!;
  assert.doesNotMatch(roster, /operator/i);
  const context = (agent: string) => ({
    agent, sessionID: 'ses_1', messageID: 'msg_1', directory: '/tmp', worktree: '/tmp', abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  });
  await assert.rejects(hooks.tool!.onionsoup_status!.execute({}, context('Operator') as never), /onionsoup tools are for owners; Operator is not one/);
  await assert.rejects(hooks.tool!.onionsoup_evidence!.execute({ owner: 'Operator' }, context('Miles Teg') as never), /unknown owner: Operator/);
  await assert.rejects(hooks.tool!.onionsoup_evidence!.execute({ owner: OPERATOR_ID }, context('Miles Teg') as never), /unknown owner: operator/);
});

async function journalLines(runtime: Runtime, id: string) {
  const directory = join(runtime.notebook(id).directory, 'journal');
  const files = await readdir(directory).catch(() => [] as string[]);
  const texts = await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')));
  return texts.join('').split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; stage?: string; note?: string; session?: string });
}

function toolEvent(id: string, sessionID: string, tool: string, input: Record<string, unknown>) {
  const part = { id, sessionID, type: 'tool', tool, state: { status: 'completed', input, output: 'ok' } };
  return { event: { type: 'message.part.updated', properties: { part } } as never };
}

test('the operator\'s commands and edits are journaled to its own journal, its subagents\' too, and never to an owner', async () => {
  const { hooks, runtime } = await operatorHooks({ ses_child: 'ses_operator' });
  await hooks['chat.message']!({ sessionID: 'ses_operator', agent: 'Operator' }, {} as never);
  await hooks.event!(toolEvent('prt_ls', 'ses_operator', 'bash', { command: 'ls -la' }));
  await hooks.event!(toolEvent('prt_edit', 'ses_operator', 'edit', { filePath: '/home/person/notes.md' }));
  await hooks.event!(toolEvent('prt_read', 'ses_operator', 'read', { filePath: '/home/person/notes.md' }));
  await hooks.event!(toolEvent('prt_sub', 'ses_child', 'write', { filePath: '/home/person/new.md' }));
  const entries = await journalLines(runtime, OPERATOR_ID);
  assert.deepEqual(entries.map(entry => [entry.kind, entry.stage, entry.note, entry.session]), [
    ['chat-action', 'bash', 'ls -la', 'ses_operator'],
    ['chat-action', 'edit', '/home/person/notes.md', 'ses_operator'],
    ['subagent-action', 'write', '/home/person/new.md', 'ses_child'],
  ]);
  assert.deepEqual(await journalLines(runtime, 'homelab'), [], 'no owner hears of it');
});

test('an operator session gets no owner bootstrap or owner context, only its memory index', async () => {
  const { hooks } = await operatorHooks();
  await hooks['chat.message']!({ sessionID: 'ses_operator', agent: 'Operator' }, {} as never);
  const messages = { messages: [{ info: { id: 'msg_1', sessionID: 'ses_operator', role: 'user', agent: 'Operator' }, parts: [{ id: 'prt_1', type: 'text', text: 'Hello' }] }] };
  await hooks['experimental.chat.messages.transform']!({}, messages as never);
  assert.equal(messages.messages[0]!.parts.length, 1);
  const system = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_operator' } as never, system);
  assert.equal(system.system.length, 1);
  assert.match(system.system[0]!, /^<your-memory-index>/);
  assert.doesNotMatch(system.system[0]!, /<your-notebook>|<your-open-work>/);
});

test('the operator\'s chat directory is its declared one, made if missing', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'onionsoup-operator-home-')), 'projects');
  const declarations = await loadDeclarations(await configWithOperator(`model: a/b\ndirectory: ${directory}\n`));
  assert.equal(await operatorChatDirectory(declarations.operator!), directory);
  assert.ok(existsSync(directory));
});
