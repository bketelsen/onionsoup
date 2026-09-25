import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config, Plugin } from '@opencode-ai/plugin';
import { recentJournal } from '../src/chat-context.ts';
import { familyOf } from '../src/families.ts';
import { BOOTSTRAP_SKILL, IMPLEMENTER_AGENT, reviewerAgent, SKILLS_DIRECTORY } from '../src/owner-agents.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';

const declarations = 'packages/owners/test/fixtures/owners';

async function configured() {
  const state = await mkdtemp('/tmp/onionsoup-agents-');
  const hooks = await withActiveHooks({} as Parameters<Plugin>[0], { declarations, state });
  const config: Config = {};
  await hooks.config!(config);
  return { config, agents: config.agent as Record<string, { mode?: string; hidden?: boolean; model?: string; permission?: Record<string, unknown> }> };
}

test('the config hook registers the skills and defines an implementer and, per owner, a reviewer from another family', async () => {
  const { config, agents } = await configured();
  const runtime = await Runtime.open({ declarations, state: await mkdtemp('/tmp/onionsoup-agents-runtime-') });
  assert.deepEqual((config as { skills?: { paths?: string[] } }).skills?.paths, [SKILLS_DIRECTORY]);
  const implementer = agents[IMPLEMENTER_AGENT]!;
  assert.equal(implementer.mode, 'subagent');
  assert.equal(implementer.hidden, true);
  assert.equal(implementer.model, runtime.declarations.freelancers.get('implementation')!.models[0]);
  assert.equal(implementer.permission!.edit, 'allow');
  assert.equal(implementer.permission!['onionsoup_*'], 'deny', 'subagents never reach onionsoup tools');
  for (const owner of [...runtime.declarations.owners.values()].filter(candidate => candidate.persona)) {
    const reviewer = agents[reviewerAgent(owner.id)]!;
    assert.equal(reviewer.mode, 'subagent');
    assert.equal(reviewer.permission!.edit, 'deny');
    assert.notEqual(familyOf(runtime.declarations.families, reviewer.model!), familyOf(runtime.declarations.families, owner.model), owner.id);
  }
});

test('a persona may start only its own implementer and reviewer, and its prompt names them', async () => {
  const { agents } = await configured();
  const milesTeg = agents['Miles Teg']!;
  assert.deepEqual(milesTeg.permission!.task, { '*': 'deny', [IMPLEMENTER_AGENT]: 'allow', [reviewerAgent('homelab')]: 'allow' });
  assert.match(String((milesTeg as { prompt?: string }).prompt), new RegExp(`subagent_type "${reviewerAgent('homelab')}"`));
});

interface FakeMessage { info: { id: string; sessionID: string; role: string; agent: string }; parts: { id: string; type: string; text: string }[] }

function chat(sessionID: string, agent: string): { messages: FakeMessage[] } {
  return { messages: [{ info: { id: `msg_${sessionID}`, sessionID, role: 'user', agent }, parts: [{ id: `prt_${sessionID}`, type: 'text', text: 'Hello' }] }] };
}

async function sessionHooks(parents: Record<string, string | undefined>) {
  const state = await mkdtemp('/tmp/onionsoup-agents-sessions-');
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents[path.id] } }) } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  return { hooks, state };
}

test('the skills bootstrap goes into an owner\'s top-level session once, never into a child or another agent\'s session', async () => {
  const { hooks } = await sessionHooks({ ses_child: 'ses_owner' });
  const transform = hooks['experimental.chat.messages.transform']!;
  const owner = chat('ses_owner', 'Miles Teg');
  await transform({}, owner as never);
  await transform({}, owner as never);
  const bootstrapped = owner.messages[0]!.parts.filter(part => part.text.includes('<onionsoup-skills>'));
  assert.equal(bootstrapped.length, 1);
  assert.match(bootstrapped[0]!.text, new RegExp(`The ${BOOTSTRAP_SKILL} skill is below and already loaded`));
  const child = chat('ses_child', 'Miles Teg');
  await transform({}, child as never);
  assert.equal(child.messages[0]!.parts.length, 1, 'a child session is not bootstrapped');
  const implementer = chat('ses_other', IMPLEMENTER_AGENT);
  await transform({}, implementer as never);
  assert.equal(implementer.messages[0]!.parts.length, 1, 'a subagent is not bootstrapped');
});

test('a subagent\'s edits are journaled to the owner whose session started it', async () => {
  const { hooks, state } = await sessionHooks({ ses_child: 'ses_owner' });
  const runtime = await Runtime.open({ declarations, state });
  await runtime.notebook('homelab').ensure('# Charter\n');
  await hooks['chat.message']!({ sessionID: 'ses_owner', agent: 'Miles Teg' }, {} as never);
  const part = { id: 'prt_edit', sessionID: 'ses_child', type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: 'src/x.ts' }, output: 'ok' } };
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part } } as never });
  const entry = (await recentJournal(runtime, 'homelab')).find(candidate => candidate.kind === 'subagent-action');
  assert.equal(entry?.note, 'src/x.ts');
  assert.equal(entry?.session, 'ses_child');
});

test('the vendored skills carry their notice, and each skill is named after its directory', async () => {
  const notice = await readFile(join(SKILLS_DIRECTORY, 'NOTICE'), 'utf8');
  assert.match(notice, /obra\/superpowers/);
  assert.match(notice, /Copyright \(c\) 2025 Jesse Vincent/);
  const skills = (await readdir(SKILLS_DIRECTORY, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const expected of [BOOTSTRAP_SKILL, 'brainstorming', 'writing-plans', 'subagent-driven-development', 'systematic-debugging']) assert.ok(skills.includes(expected), expected);
  for (const skill of skills) {
    const text = await readFile(join(SKILLS_DIRECTORY, skill, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\n(?:.*\\n)*?name: ${skill}\\n`), skill);
  }
  assert.ok(existsSync(join(SKILLS_DIRECTORY, 'subagent-driven-development', 'implementer-prompt.md')));
});
