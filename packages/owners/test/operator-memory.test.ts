import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { Config, Plugin } from '@opencode-ai/plugin';
import { OPERATOR_ID } from '../src/declarations.ts';
import { ENGINE_REPOSITORY } from '../src/operator.ts';
import {
  decideMemoryNudge, editsUnder, freshActivity, MEMORY_INDEX, MEMORY_NUDGE_TEXT, OPERATOR_MEMORY_LIMITS, type OperatorActivity,
} from '../src/operator-memory.ts';
import { Runtime } from '../src/runtime.ts';
import { withActiveHooks } from './active-hooks.ts';

const run = promisify(execFile);
const fixture = 'packages/owners/test/fixtures/owners';

interface PostedPrompt { sessionID: string; directory: string; agent: string; text: string }
interface PromptRequest { path: { id: string }; query: { directory: string }; body: { agent: string; parts: { text: string }[] } }

/** The plugin with an operator, over a scripted opencode client that records every prompt it is asked to send. */
async function memoryHooks(parents: Record<string, string> = {}) {
  const declarations = await mkdtemp(join(tmpdir(), 'onionsoup-memory-config-'));
  await cp(fixture, declarations, { recursive: true });
  await writeFile(join(declarations, 'operator.yaml'), 'model: github-copilot/gpt-6-sol\n');
  const state = await mkdtemp(join(tmpdir(), 'onionsoup-memory-state-'));
  const posted: PostedPrompt[] = [];
  const session = {
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents[path.id], directory: `/chats/${path.id}` } }),
    promptAsync: async ({ path, query, body }: PromptRequest) => {
      posted.push({ sessionID: path.id, directory: query.directory, agent: body.agent, text: body.parts[0]!.text });
      return { data: {} };
    },
    messages: async () => ({ data: [] }),
  };
  const hooks = await withActiveHooks({ client: { session } } as unknown as Parameters<Plugin>[0], { declarations, state });
  const config: Config = {};
  await hooks.config!(config);
  const runtime = await Runtime.open({ declarations, state });
  const notebook = runtime.notebook(OPERATOR_ID);
  return { hooks, config, posted, declarations, state, notebook, memory: join(notebook.directory, 'memory') };
}

type Hooks = Awaited<ReturnType<typeof memoryHooks>>['hooks'];

async function say(hooks: Hooks, sessionID: string, agent: string, text: string) {
  await hooks['chat.message']!({ sessionID, agent }, { parts: [{ type: 'text', text }] } as never);
}

let partCount = 0;
async function toolCall(hooks: Hooks, sessionID: string, tool: string, input: Record<string, unknown>) {
  partCount += 1;
  const part = { id: `prt_${partCount}`, sessionID, type: 'tool', tool, state: { status: 'completed', input, output: 'ok' } };
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part } } as never });
}

async function commands(hooks: Hooks, sessionID: string, count: number) {
  for (let index = 0; index < count; index++) await toolCall(hooks, sessionID, 'bash', { command: `echo ${index}` });
}

/** opencode reports idle twice at the end of a turn: once as a status, once as the older idle event. */
async function idle(hooks: Hooks, sessionID: string) {
  await hooks.event!({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } as never });
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID } } as never });
}

async function systemFor(hooks: Hooks, sessionID: string) {
  const output = { system: [] as string[] };
  await hooks['experimental.chat.system.transform']!({ sessionID } as never, output);
  return output.system;
}

async function commitSubjects(root: string) {
  return (await run('git', ['-C', root, 'log', '--format=%s'])).stdout.trim().split('\n');
}

test('the memory directory is made with a seeded index, and an existing index is kept', async () => {
  const { memory, declarations, state, config } = await memoryHooks();
  const prompt = (config.agent as Record<string, { prompt: string }>).Operator!.prompt;
  assert.ok(prompt.includes(`Your memory lives in ${memory}`), 'the prompt names the memory directory');
  assert.match(prompt, /never store secrets or\s+credentials/);
  const seeded = await readFile(join(memory, MEMORY_INDEX), 'utf8');
  assert.match(seeded, /^# Memory index/);
  assert.equal(seeded.trim().split('\n').length, 1, 'a one-line header');
  await writeFile(join(memory, MEMORY_INDEX), '- [NAS](nas.md) — the pool layout\n');
  await withActiveHooks({} as Parameters<Plugin>[0], { declarations, state });
  assert.equal(await readFile(join(memory, MEMORY_INDEX), 'utf8'), '- [NAS](nas.md) — the pool layout\n');
});

test('an operator chat reads its memory index each turn, and an owner chat does not', async () => {
  const { hooks, memory } = await memoryHooks();
  await writeFile(join(memory, MEMORY_INDEX), '# Memory\n- [NAS](nas.md) — the pool layout and its snapshots\n');
  await say(hooks, 'ses_operator', 'Operator', 'Hello');
  await say(hooks, 'ses_owner', 'Miles Teg', 'Hello');
  const [block, ...rest] = await systemFor(hooks, 'ses_operator');
  assert.deepEqual(rest, []);
  assert.match(block!, /^<your-memory-index>\n/);
  assert.ok(block!.includes(`These are links to topic files in ${memory}. Read the ones the current task needs before acting.`));
  assert.ok(block!.includes('- [NAS](nas.md) — the pool layout and its snapshots'));
  assert.doesNotMatch(block!, /clipped/);
  const ownerSystem = (await systemFor(hooks, 'ses_owner')).join('\n');
  assert.match(ownerSystem, /<your-notebook>/, 'the owner keeps its own context');
  assert.doesNotMatch(ownerSystem, /your-memory-index/);
});

test('an index over the limit is clipped, with a request to consolidate it', async () => {
  const { hooks, memory } = await memoryHooks();
  const line = '- [Topic](topic.md) — a hook that goes on for a while to fill the index\n';
  const index = line.repeat(Math.ceil(OPERATOR_MEMORY_LIMITS.indexChars / line.length) + 5);
  await writeFile(join(memory, MEMORY_INDEX), index);
  await say(hooks, 'ses_operator', 'Operator', 'Hello');
  const [block] = await systemFor(hooks, 'ses_operator');
  assert.ok(block!.includes(index.slice(0, OPERATOR_MEMORY_LIMITS.indexChars).trimEnd()));
  assert.ok(!block!.includes(index.slice(0, OPERATOR_MEMORY_LIMITS.indexChars + 1)), 'nothing past the limit');
  assert.match(block!, /was clipped here\. Consolidate it/);
});

function activity(changes: Partial<OperatorActivity>): OperatorActivity {
  return { ...freshActivity('sig-1'), ...changes };
}

test('the nudge decision: work since memory changed, a setup edit, memory changes and the answering turn', () => {
  const threshold = OPERATOR_MEMORY_LIMITS.nudgeAfterToolCalls;
  const below = decideMemoryNudge(activity({ toolCalls: threshold - 1 }), 'sig-1');
  assert.deepEqual([below.shouldNudge, below.reason, below.activity.toolCalls], [false, 'too_little_work', threshold - 1], 'the count carries on');
  const at = decideMemoryNudge(activity({ toolCalls: threshold }), 'sig-1');
  assert.deepEqual([at.shouldNudge, at.reason], [true, 'enough_work']);
  assert.deepEqual(at.activity, freshActivity('sig-1', true), 'a nudge resets the count and starts the answering turn');
  const setup = decideMemoryNudge(activity({ toolCalls: 1, hasChangedSetup: true }), 'sig-1');
  assert.deepEqual([setup.shouldNudge, setup.reason], [true, 'setup_changed']);
  const remembered = decideMemoryNudge(activity({ toolCalls: threshold + 5, hasChangedSetup: true }), 'sig-2');
  assert.deepEqual([remembered.shouldNudge, remembered.reason], [false, 'memory_changed']);
  assert.deepEqual(remembered.activity, freshActivity('sig-2'), 'counting starts over from the new memory');
  const answering = decideMemoryNudge(activity({ toolCalls: threshold + 5, hasChangedSetup: true, isAnsweringNudge: true }), 'sig-2');
  assert.deepEqual([answering.shouldNudge, answering.reason], [false, 'answering_nudge']);
  assert.deepEqual(answering.activity, freshActivity('sig-2', true), 'still answering until the person speaks');
  assert.equal(decideMemoryNudge(at.activity, 'sig-1').shouldNudge, false, 'no second nudge without more work');
});

test('an edit counts as a setup change only under the configuration or the engine repository', () => {
  const roots = ['/home/person/.config/onionsoup', ENGINE_REPOSITORY];
  assert.equal(editsUnder('edit', { filePath: '/home/person/.config/onionsoup/owners/nas.yaml' }, roots, '/home/person/projects'), true);
  assert.equal(editsUnder('write', { filePath: join(ENGINE_REPOSITORY, 'docs/gaps.md') }, roots, '/home/person/projects'), true);
  assert.equal(editsUnder('write', { filePath: 'notes.md' }, roots, '/home/person/.config/onionsoup'), true, 'relative to where the chat runs');
  assert.equal(editsUnder('edit', { filePath: '/home/person/projects/other/README.md' }, roots, '/home/person/projects'), false);
  assert.equal(editsUnder('edit', { filePath: '/home/person/.config/onionsoup-old/x' }, roots, '/'), false, 'a sibling with the same prefix');
  const patch = '*** Begin Patch\n*** Update File: /tmp/a.txt\n@@\n*** Add File: /home/person/.config/onionsoup/charters/nas.md\n+x\n*** End Patch';
  assert.equal(editsUnder('apply_patch', { patchText: patch }, roots, '/'), true);
  assert.equal(editsUnder('read', { filePath: '/home/person/.config/onionsoup/operator.yaml' }, roots, '/'), false, 'reads change nothing');
});

test('an idle operator chat is nudged exactly once after enough work, and not by the turn that answers it', async () => {
  const { hooks, posted, memory, notebook } = await memoryHooks();
  await say(hooks, 'ses_operator', 'Operator', 'Tidy the NAS snapshots');
  await commands(hooks, 'ses_operator', OPERATOR_MEMORY_LIMITS.nudgeAfterToolCalls - 1);
  await idle(hooks, 'ses_operator');
  assert.deepEqual(posted, [], 'below the threshold');
  await say(hooks, 'ses_operator', 'Operator', 'And the old ones too');
  await commands(hooks, 'ses_operator', 1);
  await idle(hooks, 'ses_operator');
  assert.deepEqual(posted, [{ sessionID: 'ses_operator', directory: '/chats/ses_operator', agent: 'Operator', text: MEMORY_NUDGE_TEXT }]);

  // The answer to the nudge writes memory with many tool calls and must not be nudged again.
  await say(hooks, 'ses_operator', 'Operator', MEMORY_NUDGE_TEXT);
  await writeFile(join(memory, 'nas.md'), '# NAS\nSnapshots are pruned by the tank/snap task.\n');
  await writeFile(join(memory, MEMORY_INDEX), '# Memory\n- [NAS](nas.md) — snapshot pruning\n');
  await toolCall(hooks, 'ses_operator', 'write', { filePath: join(memory, 'nas.md') });
  await toolCall(hooks, 'ses_operator', 'edit', { filePath: join(memory, MEMORY_INDEX) });
  await commands(hooks, 'ses_operator', OPERATOR_MEMORY_LIMITS.nudgeAfterToolCalls);
  await idle(hooks, 'ses_operator');
  assert.equal(posted.length, 1, 'the answering turn is never nudged');

  const subjects = await commitSubjects(notebook.root);
  assert.equal(subjects[0], 'operator: memory: INDEX.md, nas.md', 'memory is committed on idle under its own message');
  const journalCommit = subjects.indexOf('operator: chat-action');
  assert.ok(journalCommit > 0);
  const journalFiles = (await run('git', ['-C', notebook.root, 'log', '--name-only', '--format=', '--grep=chat-action'])).stdout;
  assert.doesNotMatch(journalFiles, /memory\//, 'journal commits leave memory alone');

  // The person's next request starts a new stretch; work below the threshold is not nudged.
  await say(hooks, 'ses_operator', 'Operator', 'Thanks. Now check the backups.');
  await commands(hooks, 'ses_operator', 3);
  await idle(hooks, 'ses_operator');
  assert.equal(posted.length, 1);
});

test('a config or engine edit, by the chat or its subagent, is nudged without waiting for the threshold', async () => {
  const { hooks, posted, declarations } = await memoryHooks({ ses_child: 'ses_operator' });
  await say(hooks, 'ses_operator', 'Operator', 'Give the NAS owner a new duty');
  await toolCall(hooks, 'ses_child', 'edit', { filePath: join(declarations, 'owners', 'nas.yaml') });
  await idle(hooks, 'ses_operator');
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.text, MEMORY_NUDGE_TEXT);
});

test('work that already changed memory is not nudged, and owner chats never are', async () => {
  const { hooks, posted, memory } = await memoryHooks();
  await say(hooks, 'ses_operator', 'Operator', 'Set up the new host');
  await commands(hooks, 'ses_operator', OPERATOR_MEMORY_LIMITS.nudgeAfterToolCalls + 2);
  await writeFile(join(memory, 'hosts.md'), '# Hosts\n');
  await idle(hooks, 'ses_operator');
  await say(hooks, 'ses_owner', 'Miles Teg', 'Hello');
  await commands(hooks, 'ses_owner', OPERATOR_MEMORY_LIMITS.nudgeAfterToolCalls + 2);
  await idle(hooks, 'ses_owner');
  assert.deepEqual(posted, []);
});
