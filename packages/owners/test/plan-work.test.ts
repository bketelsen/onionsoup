import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { processRequest } from '../src/brokering.ts';
import { requestWork } from '../src/delegation.ts';
import type { ChatOrigin } from '../src/chat-origin.ts';
import { openNeededSessions, type OwnerSessionClient, type PermissionRule } from '../src/owner-sessions.ts';
import { PLAN_APPROVAL_PERMISSION, submitPlan } from '../src/plan-work.ts';
import { Runtime } from '../src/runtime.ts';
import { approvePlan } from '../src/workflow.ts';
import { git } from '../src/workspace.ts';
import { withActiveHooks } from './active-hooks.ts';

const fixtures = 'packages/owners/test/fixtures/owners';

/** A bare remote with one commit, for owners whose desks must really exist. */
async function remoteRepository(root: string) {
  const remote = join(root, 'origin.git');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  const seed = join(root, 'seed');
  await git(root, ['clone', '-q', remote, seed]);
  await writeFile(join(seed, 'README.md'), 'fleet\n');
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Base']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  return remote;
}

/** The fixture configuration on disk, with Miles Teg's repository replaced by a local one. */
async function configWithLocalFleet() {
  const root = await mkdtemp(join(tmpdir(), 'onionsoup-plans-'));
  const declarations = join(root, 'config');
  await cp(fixtures, declarations, { recursive: true });
  const path = join(declarations, 'owners', 'homelab.yaml');
  const remote = await remoteRepository(root);
  await writeFile(path, (await readFile(path, 'utf8')).replace('https://example.invalid/fleet.git', remote));
  return { declarations, state: join(root, 'home', 'state') };
}

interface CreatedSession { directory: string; title: string; permission: readonly PermissionRule[] }

/** opencode as the plugin sees it: sessions are recorded, prompts are kept, nothing runs. */
function scriptedOpencode() {
  const created: CreatedSession[] = [];
  const prompts: { target: ChatOrigin; agent: string; text: string }[] = [];
  const client = { session: {
    create: async ({ body, query }: { body: { title: string; permission: PermissionRule[] }; query: { directory: string } }) => {
      created.push({ directory: query.directory, title: body.title, permission: body.permission });
      return { data: { id: `ses_opened_${created.length}` } };
    },
    promptAsync: async ({ path, query, body }: { path: { id: string }; query: { directory: string }; body: { agent: string; parts: { text: string }[] } }) => {
      prompts.push({ target: { sessionID: path.id, directory: query.directory }, agent: body.agent, text: body.parts[0]!.text });
      return {};
    },
    delete: async () => ({}),
    get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
  } };
  const sessions: OwnerSessionClient = {
    create: async (directory, title, permission) => (await client.session.create({ body: { title, permission: [...permission] }, query: { directory } })).data.id,
    prompt: async (target, agent, text) => { await client.session.promptAsync({ path: { id: target.sessionID }, query: target, body: { agent, parts: [{ text }] } }); },
    remove: async () => {},
  };
  return { client, sessions, created, prompts };
}

function toolContext(ask: (input: { permission: string; patterns: string[] }) => Promise<void>) {
  return {
    agent: 'Miles Teg', sessionID: 'ses_chat', messageID: 'msg_1', directory: '/desk', worktree: '/desk',
    abort: new AbortController().signal, metadata: () => {}, ask,
  };
}

test('a submitted plan asks the person in chat; a denial keeps it waiting with their note, an approval opens its execution session', async () => {
  const { declarations, state } = await configWithLocalFleet();
  const opencode = scriptedOpencode();
  const hooks = await withActiveHooks({ client: opencode.client } as unknown as Parameters<Plugin>[0], { declarations, state });
  const submit = hooks.tool!.onionsoup_submit_plan!;
  const asked: { permission: string; patterns: string[] }[] = [];
  const plan = { title: 'Rotate logs', goal: 'Keep the disk free', plan: '# Rotate logs\n\n1. Add logrotate config\n2. Test it' };
  const denial = await submit.execute(plan, toolContext(async input => {
    asked.push(input);
    throw new Error('The user rejected permission to use this specific tool call with the following feedback: Weekly, not daily');
  }) as never);
  const runtime = await Runtime.open({ declarations, state });
  const [item] = await runtime.ledger.list();
  assert.equal(item?.workflow, 'owner-change');
  assert.deepEqual(asked, [{ permission: PLAN_APPROVAL_PERMISSION, patterns: [item!.id], always: [], metadata: { item: item!.id, title: 'Rotate logs', plan: plan.plan } }]);
  assert.match(String(denial), /did not approve plan .*Weekly, not daily/);
  const denied = await runtime.ledger.get(item!.id);
  assert.equal(denied.status, 'awaiting-plan-approval');
  assert.deepEqual(denied.humanNotes.map(note => [note.kind, note.note]), [['plan-feedback', 'Weekly, not daily']]);
  assert.deepEqual(denied.origin, { sessionID: 'ses_chat', directory: '/desk' });
  assert.equal(opencode.created.length, 0, 'nothing runs before approval');

  const revised = { ...plan, plan: '# Rotate logs weekly\n\n1. Add weekly logrotate config', item: item!.id };
  const approval = await submit.execute(revised, toolContext(async () => {}) as never);
  const working = await runtime.ledger.get(item!.id);
  assert.equal(working.status, 'working');
  assert.equal(working.planApproval?.by, userInfo().username);
  assert.equal(working.planDocument?.markdown, revised.plan);
  assert.match(String(approval), /approved plan .* runs in its own session/);
  assert.equal(opencode.created.length, 1);
  assert.equal(opencode.created[0]!.title, `Plan ${item!.id}: Rotate logs`);
  assert.deepEqual(opencode.created[0]!.permission, [{ permission: 'edit', pattern: '*', action: 'allow' }]);
  assert.deepEqual(working.session, { sessionID: 'ses_opened_1', directory: opencode.created[0]!.directory });
  const [prompt] = opencode.prompts;
  assert.equal(prompt?.agent, 'Miles Teg');
  assert.match(prompt!.text, /subagent-driven-development/);
  assert.ok(prompt!.text.includes(`onionsoup_propose_changes with item "${item!.id}"`));
  assert.ok(prompt!.text.includes('Add weekly logrotate config'));
  const journal = await readFile(join(runtime.notebook('homelab').directory, 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.match(journal, /"kind":"plan-approved"/);
  assert.match(journal, /"kind":"owner-session-opened"/);
});

test('a persona must ask for plan approval: the permission is always ask for owners', async () => {
  const { declarations, state } = await configWithLocalFleet();
  const hooks = await withActiveHooks({} as Parameters<Plugin>[0], { declarations, state });
  const config: { agent?: Record<string, { permission?: Record<string, unknown> }> } = {};
  await hooks.config!(config as never);
  assert.equal(config.agent!['Miles Teg']!.permission![PLAN_APPROVAL_PERMISSION], 'ask');
});

test('delegated work opens a planning session, its plan waits for approval outside the chat, and approval opens the work session', async () => {
  const { declarations, state } = await configWithLocalFleet();
  const runtime = await Runtime.open({ declarations, state });
  const homelab = runtime.declarations.owners.get('homelab')!;
  runtime.declarations.owners.set('homelab', { ...homelab, reportsTo: 'odrade' });
  for (const owner of ['odrade', 'homelab']) await runtime.notebook(owner).ensure('# Charter\n');
  const proposal = { title: 'Patch the fleet', goal: 'Apply the patch', rationale: 'Security', acceptance: ['Patched'], size: 'small' as const };
  const request = await requestWork(runtime, 'odrade', 'homelab', proposal);
  await processRequest(runtime, request.id);
  const itemId = (await runtime.requests.get(request.id)).workItem!;
  const opencode = scriptedOpencode();
  const errors: unknown[] = [];
  const onError = (_itemId: string, error: unknown) => { errors.push(error); };
  await openNeededSessions(runtime, opencode.sessions, onError);
  await openNeededSessions(runtime, opencode.sessions, onError);
  assert.deepEqual(errors, []);
  assert.deepEqual(opencode.created.map(session => session.title), [`Request ${request.id}: Patch the fleet`], 'one planning session, opened once');
  const planning = await runtime.ledger.get(itemId);
  assert.equal(planning.origin?.sessionID, 'ses_opened_1');
  assert.ok(opencode.prompts[0]!.text.includes(`onionsoup_submit_plan with item "${itemId}"`));
  assert.match(opencode.prompts[0]!.text, /Nobody is in this chat/);

  const submitted = await submitPlan(runtime, 'homelab', { title: 'Patch the fleet', goal: 'Apply the patch', plan: '1. Patch', item: itemId }, planning.origin!);
  assert.equal(submitted.status, 'awaiting-plan-approval');
  await openNeededSessions(runtime, opencode.sessions, onError);
  assert.equal(opencode.created.length, 1, 'a waiting plan opens nothing');
  await approvePlan(runtime, itemId, 'person');
  await openNeededSessions(runtime, opencode.sessions, onError);
  assert.deepEqual(opencode.created.map(session => session.title).at(-1), `Plan ${itemId}: Patch the fleet`);
  assert.equal((await runtime.ledger.get(itemId)).session?.sessionID, 'ses_opened_2');
});
