import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OPERATOR_ID, OperatorDeclaration, Runtime, approveInitiative, armDeployment, beginDrain, draftInitiative, listAdmissions,
  recordProviderFailure, recordProviderSuccess, releaseDrain, reportFriction, setReminder,
  submitInitiative,
} from '@onionsoup/owners';
import { SurfaceState, surfaceServer, type OpencodeApi } from '@onionsoup/surface';
import { DEFAULT_RELEASE_MANIFEST, readReleaseBuildId } from '../src/deployment-view.ts';

test('state API reads pending deployment dynamically while retaining the installed build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-build-'));
  const oldRelease = join(root, 'old');
  const newRelease = join(root, 'new');
  await mkdir(oldRelease);
  await mkdir(newRelease);
  await writeFile(join(oldRelease, 'release.json'), JSON.stringify({ buildId: 'installed-123' }));
  await writeFile(join(newRelease, 'release.json'), JSON.stringify({ buildId: 'next-456' }));
  const current = join(root, 'current');
  await symlink(oldRelease, current);
  const manifestPath = join(current, 'release.json');
  const { runtime, server, call } = await start(undefined, undefined, manifestPath);
  try {
    assert.deepEqual((await call('GET', '/api/state')).body.deployment, { buildId: 'installed-123', isPending: false });
    await mkdir(join(runtime.stateDirectory, 'deploy'), { recursive: true });
    await writeFile(join(runtime.stateDirectory, 'deploy', 'pending.json'), JSON.stringify({ status: 'draining', targetBuildId: 'next-456' }));
    await symlink(newRelease, join(root, 'next-pointer'));
    await rename(join(root, 'next-pointer'), current);
    assert.deepEqual((await call('GET', '/api/state')).body.deployment, {
      buildId: 'installed-123', isPending: true, pending: { status: 'draining', targetBuildId: 'next-456' },
    });
    const replacement = await start(undefined, undefined, manifestPath);
    try {
      assert.deepEqual((await replacement.call('GET', '/api/state')).body.deployment, { buildId: 'next-456', isPending: false });
    } finally {
      replacement.server.close();
    }
  } finally {
    server.close();
  }
});

function fakeOpencode() {
  const calls: unknown[][] = [];
  const answeredPermissions = new Set<string>();
  const api: OpencodeApi = {
    listSessions: async directory => directory.includes('worktrees')
      ? [{ id: 'ses_impl', title: 'w-1: implement 1', directory, time: { created: 2, updated: 3 } }, { id: 'ses_x', title: 'w-2: plan', directory, time: { created: 1, updated: 1 } }]
      : [{ id: 'ses_1', title: 'hello', directory, time: { created: 0, updated: 0 } }, { id: 'ses_plan', title: 'w-1: plan', directory, time: { created: 1, updated: 1 } }],
    createSession: async (directory, title, agent) => { calls.push(['create', directory, title, agent]); return { id: 'ses_2', title }; },
    renameSession: async (_directory, sessionID, title) => ({ id: sessionID, title }),
    messages: async () => [{ info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }],
    prompt: async (directory, sessionID, agent, text) => { calls.push(['prompt', directory, sessionID, agent, text]); },
    abort: async () => {},
    status: async () => ({}),
    health: async () => ({ ok: true }),
    permissions: async directory => directory.endsWith('bellonda') ? [
      { id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['docs/x.md'], metadata: {}, always: [] },
      { id: 'per_2', sessionID: 'ses_other', permission: 'bash', patterns: ['rm -rf x'], metadata: {}, always: [] },
    ].filter(entry => !answeredPermissions.has(entry.id)) : [],
    replyPermission: async (directory, requestID, reply) => { calls.push(['permission', directory, requestID, reply]); answeredPermissions.add(requestID); },
    questions: async () => [],
    replyQuestion: async (directory, requestID, answers) => { calls.push(['question', directory, requestID, answers]); },
    rejectQuestion: async (directory, requestID) => { calls.push(['reject-question', directory, requestID]); },
    events: async () => {},
  };
  return { api, calls };
}

test('drain refuses new surface writes and retains an in-flight prompt lease until the HTTP request completes', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const { runtime, server, call, calls } = await start(api => {
    api.prompt = async (directory, sessionID, agent, text) => {
      calls.push(['prompt', directory, sessionID, agent, text]);
      entered();
      await held;
    };
  });
  const target = 'build-next';
  try {
    const pending = call('POST', '/api/owners/bellonda/sessions/ses_1/prompt', { text: 'first' });
    await started;
    await armDeployment(runtime.stateDirectory, target);
    const admissions = await beginDrain(runtime.stateDirectory, target);
    assert.equal(admissions.length, 1);
    assert.match(admissions[0]!.kind, /^surface:POST:.*\/prompt$/);
    assert.equal(admissions[0]!.alive, true);
    await assert.rejects(releaseDrain(runtime.stateDirectory, target, 'completed'), /deployment_admissions_active/);

    const blocked = [
      ['POST', '/api/owners/bellonda/sessions', {}],
      ['POST', '/api/owners/bellonda/sessions/ses_1/prompt', { text: 'second' }],
      ['POST', '/api/owners/bellonda/sessions/ses_1/abort', {}],
      ['POST', '/api/owners/bellonda/permissions/per_1', { reply: 'once' }],
      ['POST', '/api/owners/bellonda/questions/question-1', { reject: true }],
      ['POST', '/api/decide', { action: 'launch', id: 'x' }],
      ['PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: true }],
      ['PATCH', '/api/owners/bellonda/sessions/ses_1', { title: 'new title' }],
      ['POST', '/api/owners/bellonda/memory', {}],
    ] as const;
    for (const [method, path, body] of blocked) {
      assert.deepEqual(await call(method, path, body), { status: 503, body: { error: 'deployment_draining' } });
    }
    assert.equal(calls.length, 1, 'no rejected request reached opencode');
    assert.equal((await call('GET', '/api/state')).status, 200);
    assert.equal((await listAdmissions(runtime.stateDirectory)).length, 1);

    finish();
    assert.deepEqual(await pending, { status: 200, body: { outcome: 'sent' } });
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
    await releaseDrain(runtime.stateDirectory, target, 'completed');
    assert.equal((await call('POST', '/api/owners/bellonda/sessions', {})).status, 200);
  } finally {
    finish();
    server.close();
  }
});

test('a pending permission remains answerable while deployment is waiting before drain', async () => {
  const { runtime, server, call, calls } = await start();
  try {
    await armDeployment(runtime.stateDirectory, 'build-next');
    const { markDeploymentWaiting } = await import('@onionsoup/owners');
    await markDeploymentWaiting(runtime.stateDirectory, 'build-next');
    assert.deepEqual(await call('POST', '/api/owners/bellonda/permissions/per_1', { reply: 'once' }),
      { status: 200, body: { outcome: 'once' } });
    assert.deepEqual(calls.at(-1), ['permission', '/desks/bellonda', 'per_1', 'once']);
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);
  } finally {
    server.close();
  }
});

test('a failed mutation releases its admission and an unreadable deployment intent fails closed', async () => {
  const { runtime, server, call, calls } = await start();
  try {
    assert.equal((await call('POST', '/api/owners/bellonda/sessions/ses_1/prompt', { text: '' })).status, 400);
    assert.deepEqual(await listAdmissions(runtime.stateDirectory), []);

    await mkdir(join(runtime.stateDirectory, 'deploy'), { recursive: true });
    await writeFile(join(runtime.stateDirectory, 'deploy', 'pending.json'), '{broken');
    const refused = await call('POST', '/api/owners/bellonda/sessions', {});
    assert.deepEqual(refused, { status: 500, body: { error: 'deployment_invalid_pending' } });
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test('the surface queues notebook maintenance alongside a running daemon and exposes failures', async () => {
  const { server, runtime, call } = await start();
  const { distill, memoryStatus } = await import('@onionsoup/owners');
  const unlock = await runtime.lock();
  try {
    await runtime.notebook('clippy').ensure('# Charter\nTest owner\n');
    await runtime.notebook('clippy').journal({ kind: 'chat-decision', note: 'remember this' });
    const queued = await call('POST', '/api/owners/clippy/memory', {});
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queued, true);
    assert.equal((await memoryStatus(runtime, 'clippy')).queued, true);
    runtime.hire = async () => { throw new Error('provider_unavailable'); };
    await assert.rejects(distill(runtime, 'clippy'), /provider_unavailable/);
    const status = await call('GET', '/api/owners/clippy/memory');
    assert.equal(status.body.status, 'failed');
    assert.match(String(status.body.error), /provider_unavailable/);
    assert.equal(status.body.queued, true);
    assert.equal((await call('GET', '/api/owners/nobody/memory')).status, 404);
    assert.equal((await call('POST', '/api/owners/nobody/memory', {})).status, 404);
  } finally {
    await unlock();
    server.close();
  }
});

async function start(
  configure?: (api: OpencodeApi) => void,
  directory: (runtime: Runtime, ownerId: string) => Promise<string> = async (_runtime, ownerId) => `/desks/${ownerId}`,
  manifestPath?: string,
) {
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: await mkdtemp(join(tmpdir(), 'surface-')) });
  const { api, calls } = fakeOpencode();
  configure?.(api);
  const hireSessions = (prefix: string) => [
    { id: 'ses_plan', title: 'w-1: plan', directory: '/checkouts/clippy', time: { created: 1, updated: 1 } },
    { id: 'ses_impl', title: 'w-1: implement 1', directory: '/worktrees/clippy/w-1', time: { created: 2, updated: 3 } },
    { id: 'ses_x', title: 'w-2: plan', directory: '/checkouts/clippy', time: { created: 1, updated: 1 } },
  ].filter(session => session.title.startsWith(prefix));
  const state = new SurfaceState(runtime, api, directory, undefined,
    sessionID => [{ info: { id: 'msg_1', sessionID, role: 'assistant' }, parts: [] }], hireSessions);
  const buildId = await readReleaseBuildId(manifestPath ?? DEFAULT_RELEASE_MANIFEST);
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', by: 'tester', buildId });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { runtime, server, call, calls };
}

test('the surface lists owners with what waits on the person, and chat permissions land in the inbox', async () => {
  const { runtime, server, call } = await start();
  try {
    const clippy = runtime.declarations.owners.get('clippy')!;
    runtime.declarations.owners.set('clippy', { ...clippy, persona: undefined });
    await runtime.ledger.create('clippy', 'owner-change', { title: 'Fix it', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' }, { status: 'awaiting-plan-approval', request: 'r-1' });
    const { status, body } = await call('GET', '/api/state');
    assert.equal(status, 200);
    const inbox = body.inbox as { kind: string; owner: string; title: string }[];
    assert.deepEqual(inbox.map(entry => [entry.kind, entry.owner]).sort(), [['permission', 'bellonda'], ['permission', 'bellonda'], ['plan', 'clippy']]);
    const owners = body.owners as { id: string; chat: boolean; waiting: number }[];
    assert.equal(owners.find(owner => owner.id === 'clippy')?.chat, false);
    assert.equal(owners.find(owner => owner.id === 'bellonda')?.waiting, 2);
  } finally {
    server.close();
  }
});

function failWhile<Value>(read: (directory: string) => Promise<Value>, hasFailure: () => boolean) {
  return async (directory: string) => {
    if (hasFailure() && directory.endsWith('homelab')) throw new Error('transport contains private credentials');
    return read(directory);
  };
}

test('a failed chat directory remains visible and retries without losing other owners', async () => {
  let hasFailure = true;
  const { server, call } = await start(undefined, async (_runtime, ownerId) => {
    if (ownerId === 'homelab' && hasFailure) throw new Error('private directory details');
    return `/desks/${ownerId}`;
  });
  try {
    const failed = await call('GET', '/api/state');
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.body.inboxErrors, [{ owner: 'homelab', code: 'chat_directory_failed' }]);
    assert.doesNotMatch(JSON.stringify(failed.body), /private directory details/);
    assert.ok((failed.body.inbox as { id: string }[]).some(entry => entry.id === 'per_1'));
    hasFailure = false;
    const recovered = await call('GET', '/api/state');
    assert.deepEqual(recovered.body.inboxErrors, []);
  } finally {
    server.close();
  }
});

for (const [method, code] of [['permissions', 'permission_list_failed'], ['questions', 'question_list_failed']] as const) {
  test(`a failed ${method} list preserves other owners and persisted gates, and a later refresh clears the error`, async () => {
    let hasFailure = true;
    const { runtime, server, call } = await start(api => {
      api.permissions = failWhile(api.permissions, () => hasFailure && method === 'permissions');
      api.questions = failWhile(api.questions, () => hasFailure && method === 'questions');
    });
    try {
      const item = await runtime.ledger.create('clippy', 'owner-change', {
        title: 'Needs approval', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small',
      }, { status: 'awaiting-plan-approval', request: 'r-1' });
      const failed = await call('GET', '/api/state');
      assert.equal(failed.status, 200);
      assert.deepEqual(failed.body.inboxErrors, [{ owner: 'homelab', code }]);
      assert.doesNotMatch(JSON.stringify(failed.body), /private credentials/);
      const available = failed.body.inbox as { id: string; kind: string }[];
      assert.ok(available.some(entry => entry.id === item.id && entry.kind === 'plan'));
      assert.ok(available.some(entry => entry.id === 'per_1' && entry.kind === 'permission'));
      hasFailure = false;
      const recovered = await call('GET', '/api/state');
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.body.inboxErrors, []);
      const inbox = recovered.body.inbox as { id: string; kind: string }[];
      assert.ok(inbox.some(entry => entry.id === item.id && entry.kind === 'plan'));
      assert.ok(inbox.some(entry => entry.id === 'per_1' && entry.kind === 'permission'));
      assert.equal((await runtime.ledger.get(item.id)).status, 'awaiting-plan-approval');
    } finally {
      server.close();
    }
  });
}

test('HTTP friction views show bounded safe records and the originating chat without internal directory', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.notebook('bellonda').ensure('# Test');
    const base = { owner: 'bellonda', origin: { sessionID: 'ses_original', directory: '/secret/desk' },
      model: 'provider/model', commit: 'a'.repeat(40), failures: [{ tool: 'bash', input: 'arguments withheld', error: 'permission denied' }],
      input: { summary: '<script>alert(1)</script>', expected: 'Success', actual: 'Permission failure' } };
    const first = await reportFriction(runtime, { ...base, submissionID: 'first' });
    await reportFriction(runtime, { ...base, submissionID: 'second' });
    const second = await reportFriction(runtime, { ...base, submissionID: 'third', failures: [],
      input: { summary: 'A different problem', expected: 'Success', actual: 'Unexpected response' } });
    assert.notEqual(first.id, second.id);
    const snapshot = (await call('GET', '/api/state')).body;
    assert.equal(snapshot.frictionCount, 2);
    const listing = (await call('GET', '/api/friction')).body as unknown as { id: string; count: number; sessionID: string }[];
    assert.equal(listing.length, 2);
    assert.equal(listing.find(entry => entry.id === first.id)?.count, 2);
    assert.equal(listing.find(entry => entry.id === first.id)?.sessionID, 'ses_original');
    const detail = await call('GET', `/api/friction/${first.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.summary, '<script>alert(1)</script>');
    assert.doesNotMatch(JSON.stringify([listing, detail.body]), /secret\/desk|command|\.env/);
    assert.deepEqual(await call('GET', '/api/friction/not-an-id'), { status: 400, body: { error: 'friction_invalid_id' } });
    assert.deepEqual(await call('GET', '/api/friction/fr_aaaaaaaaaaaaaaaaaaaaaaaa'), { status: 404, body: { error: 'friction_not_found' } });
    await writeFile(join(runtime.stateDirectory, 'friction', 'records', 'fr_aaaaaaaaaaaaaaaaaaaaaaaa.json'), '{bad');
    assert.deepEqual(await call('GET', '/api/friction/fr_aaaaaaaaaaaaaaaaaaaaaaaa'), { status: 422, body: { error: 'friction_invalid_record' } });
    assert.equal(((await call('GET', '/api/friction')).body as unknown as unknown[]).length, 2);
  } finally {
    server.close();
  }
});

test('chats go to the owner\'s directory with its persona as the agent; bad input is refused', async () => {
  const { server, call, calls, runtime } = await start();
  try {
    assert.equal((await call('POST', '/api/owners/bellonda/sessions/ses_1/prompt', { text: 'publish the wiki' })).status, 200);
    assert.deepEqual(calls.at(-1), ['prompt', '/desks/bellonda', 'ses_1', 'Bellonda', 'publish the wiki']);
    assert.equal((await call('POST', '/api/owners/bellonda/permissions/per_1', { reply: 'once' })).status, 200);
    assert.deepEqual(calls.at(-1), ['permission', '/desks/bellonda', 'per_1', 'once']);
    assert.equal((await call('POST', '/api/owners/bellonda/permissions/per_1', { reply: 'sure' })).status, 400);
    const clippy = runtime.declarations.owners.get('clippy')!;
    runtime.declarations.owners.set('clippy', { ...clippy, persona: undefined });
    assert.match(String((await call('POST', '/api/owners/clippy/sessions', {})).body.error), /no_chat: clippy/);
    assert.equal((await call('GET', '/api/owners/nobody/sessions')).status, 404);
    assert.match(String((await call('POST', '/api/decide', { action: 'launch', id: 'x' })).body.error), /unknown_decision|not found|ENOENT/);
  } finally {
    server.close();
  }
});

test('the operator has a chat of its own in its directory, apart from the owners, with its prompts in the inbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surface-operator-'));
  const { server, call, calls, runtime } = await start(api => {
    api.permissions = async candidate => candidate === directory
      ? [{ id: 'per_op', sessionID: 'ses_op', permission: 'bash', patterns: ['git push --force'], metadata: {}, always: [] }]
      : [];
  });
  try {
    assert.equal((await call('POST', '/api/owners/operator/sessions', {})).status, 404, 'no operator.yaml, no operator chat');
    assert.equal((await call('GET', '/api/state')).body.operator, undefined);
    runtime.declarations.operator = OperatorDeclaration.parse({ name: 'Operator', title: 'Acts for you', model: 'github-copilot/gpt-6-sol', directory });
    const state = (await call('GET', '/api/state')).body as { operator: Record<string, unknown>; owners: { id: string }[]; inbox: { id: string; owner: string }[] };
    assert.deepEqual(state.operator, {
      id: OPERATOR_ID, name: 'Operator', title: 'Acts for you', source: '', icon: 'terminal', color: 'primary', model: 'github-copilot/gpt-6-sol',
      domain: directory, chat: true, hasDesk: false, waiting: 1, running: 0, runtimeWork: [], activity: 'waiting',
    });
    assert.ok(!state.owners.some(owner => owner.id === OPERATOR_ID), 'the operator is not an owner');
    assert.ok(state.inbox.some(entry => entry.id === 'per_op' && entry.owner === OPERATOR_ID));
    await call('POST', '/api/owners/operator/sessions', {});
    assert.deepEqual(calls.at(-1), ['create', directory, undefined, 'Operator']);
    await call('POST', '/api/owners/operator/sessions/ses_op/prompt', { text: 'check the daemon' });
    assert.deepEqual(calls.at(-1), ['prompt', directory, 'ses_op', 'Operator', 'check the daemon']);
    assert.equal((await call('GET', '/api/owners/operator/sessions')).body.directory, directory);
    await call('POST', '/api/owners/operator/permissions/per_op', { reply: 'reject' });
    assert.deepEqual(calls.at(-1), ['permission', directory, 'per_op', 'reject']);
  } finally {
    server.close();
  }
});

test('a plan\'s work session is listed, prompted and answered in the plan\'s own worktree', async () => {
  const planWorktree = '/plans/bellonda/w-plan';
  const { server, call, calls, runtime } = await start(api => {
    const listSessions = api.listSessions;
    api.listSessions = async directory => directory === planWorktree
      ? [{ id: 'ses_work', title: 'Plan w-plan: Wiki page', directory, time: { created: 5, updated: 6 } }]
      : listSessions(directory);
    api.permissions = async directory => directory === planWorktree
      ? [{ id: 'per_work', sessionID: 'ses_work', permission: 'bash', patterns: ['make test'], metadata: {}, always: [] }]
      : [];
  });
  try {
    await runtime.ledger.create('bellonda', 'owner-change', { title: 'Wiki page', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' }, {
      status: 'working', planWorktree, session: { sessionID: 'ses_work', directory: planWorktree },
    });
    const listed = (await call('GET', '/api/owners/bellonda/sessions')).body as { directory: string; directories: string[]; sessions: { id: string; directory: string }[] };
    assert.equal(listed.directory, '/desks/bellonda');
    assert.deepEqual(listed.directories, ['/desks/bellonda', planWorktree]);
    assert.deepEqual(listed.sessions.find(session => session.id === 'ses_work')?.directory, planWorktree);
    const inbox = (await call('GET', '/api/state')).body.inbox as { id: string; owner: string }[];
    assert.ok(inbox.some(entry => entry.id === 'per_work' && entry.owner === 'bellonda'), 'its prompts wait in the inbox');
    await call('POST', '/api/owners/bellonda/sessions/ses_work/prompt', { text: 'use the wiki template' });
    assert.deepEqual(calls.at(-1), ['prompt', planWorktree, 'ses_work', 'Bellonda', 'use the wiki template']);
    await call('POST', '/api/owners/bellonda/permissions/per_work', { reply: 'once' });
    assert.deepEqual(calls.at(-1), ['permission', planWorktree, 'per_work', 'once']);
    await call('POST', '/api/owners/bellonda/sessions/ses_1/prompt', { text: 'hello' });
    assert.deepEqual(calls.at(-1), ['prompt', '/desks/bellonda', 'ses_1', 'Bellonda', 'hello'], 'other chats stay on the desk');
  } finally {
    server.close();
  }
});

test('a merged plan whose session is still working is listed in its worktree, with its status', async () => {
  const planWorktree = '/plans/bellonda/w-rollout';
  const { server, call, runtime } = await start(api => {
    const listSessions = api.listSessions;
    api.listSessions = async directory => directory === planWorktree
      ? [{ id: 'ses_rollout', title: 'Plan w-rollout: Roll out', directory, time: { created: 5, updated: 6 } }]
      : listSessions(directory);
    api.status = async directory => directory === planWorktree ? { ses_rollout: { type: 'busy' } } : {};
  });
  try {
    await runtime.ledger.create('bellonda', 'owner-change', { title: 'Roll out', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' }, {
      status: 'landed', planWorktree, session: { sessionID: 'ses_rollout', directory: planWorktree },
      publication: { url: 'https://github.com/example/wiki/pull/7', branch: 'owners/w-rollout', by: 'bellonda', at: '2026-09-25T00:00:00Z', state: 'merged' },
    });
    const listed = (await call('GET', '/api/owners/bellonda/sessions')).body as { directories: string[]; sessions: { id: string }[]; status: Record<string, unknown> };
    assert.deepEqual(listed.directories, ['/desks/bellonda', planWorktree]);
    assert.ok(listed.sessions.some(session => session.id === 'ses_rollout'), 'the merged plan\'s session is still listed');
    assert.deepEqual(listed.status.ses_rollout, { type: 'busy' });
  } finally {
    server.close();
  }
});

type ActivityRead = { owners: { id: string; activity: string }[]; operator?: { activity: string } };

test('an owner\'s rail activity: busy desk or plan sessions work, pending prompts or questions wait, else idle', async () => {
  const planWorktree = '/plans/clippy/w-busy';
  const operatorDirectory = await mkdtemp(join(tmpdir(), 'surface-activity-'));
  const busy = new Map<string, Record<string, unknown>>([
    ['/desks/bellonda', { ses_1: { type: 'busy' } }],
    [planWorktree, { ses_sub: { type: 'retry', attempt: 2, message: 'rate limited', next: 1 } }],
    [operatorDirectory, { ses_op: { type: 'busy' } }],
  ]);
  const { server, call, runtime } = await start(api => {
    api.status = async directory => {
      if (directory.endsWith('homelab')) throw new Error('status_failed');
      return busy.get(directory) ?? { ses_idle: { type: 'idle' } };
    };
    api.questions = async directory => directory === operatorDirectory
      ? [{ id: 'que_op', sessionID: 'ses_op', questions: [{ question: 'Restart?', header: 'Restart', options: [] }] }]
      : [];
  });
  try {
    await runtime.ledger.create('clippy', 'owner-change', { title: 'Busy plan', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' }, {
      status: 'working', planWorktree, session: { sessionID: 'ses_work', directory: planWorktree },
    });
    runtime.declarations.operator = OperatorDeclaration.parse({ name: 'Operator', title: 'Acts for you', model: 'github-copilot/gpt-6-sol', directory: operatorDirectory });
    const { status, body } = await call('GET', '/api/state');
    assert.equal(status, 200, 'a failed status read does not fail the state');
    const read = body as ActivityRead;
    const activity = Object.fromEntries(read.owners.map(owner => [owner.id, owner.activity]));
    assert.equal(activity.bellonda, 'waiting', 'a pending prompt outranks a busy desk session');
    assert.equal(activity.clippy, 'working', 'a subagent retrying in a plan worktree counts as working');
    assert.equal(activity.homelab, 'idle', 'an unreadable status is idle');
    assert.equal(activity.moneo, 'idle');
    assert.equal(read.operator?.activity, 'waiting', 'a pending question stops the operator on the person');

    busy.delete(planWorktree);
    busy.delete(operatorDirectory);
    const settled = (await call('GET', '/api/state')).body as ActivityRead;
    assert.equal(settled.owners.find(owner => owner.id === 'clippy')?.activity, 'idle');
  } finally {
    server.close();
  }
});

test('an owner whose only busy session is on its desk is working, and the operator works without a prompt', async () => {
  const operatorDirectory = await mkdtemp(join(tmpdir(), 'surface-activity-'));
  const { server, call, runtime } = await start(api => {
    api.permissions = async () => [];
    api.status = async directory => [operatorDirectory, '/desks/bellonda'].includes(directory) ? { ses_1: { type: 'busy' } } : {};
  });
  try {
    runtime.declarations.operator = OperatorDeclaration.parse({ name: 'Operator', title: 'Acts for you', model: 'github-copilot/gpt-6-sol', directory: operatorDirectory });
    const read = (await call('GET', '/api/state')).body as ActivityRead;
    assert.equal(read.owners.find(owner => owner.id === 'bellonda')?.activity, 'working');
    assert.equal(read.operator?.activity, 'working');
  } finally {
    server.close();
  }
});

test('work a runner holds is listed under its owner and makes it work, though its chats are idle', async () => {
  const { server, call, runtime } = await start(api => {
    api.permissions = async () => [];
    api.status = async () => ({ ses_idle: { type: 'idle' } });
  });
  try {
    const proposal = { goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const rebase = await runtime.ledger.create('homelab', 'maintain-prs', { ...proposal, title: 'Rebase #12 onto the current base' }, {
      status: 'implementing', activeRunner: process.pid,
    });
    await runtime.ledger.create('homelab', 'maintain-prs', { ...proposal, title: 'Finished rebase' }, { status: 'landed', activeRunner: process.pid });
    await runtime.ledger.create('homelab', 'owner-change', { ...proposal, title: 'Queued work' }, { status: 'implementing' });
    const read = (await call('GET', '/api/state')).body as { owners: { id: string; activity: string; runtimeWork: unknown[] }[] };
    const homelab = read.owners.find(owner => owner.id === 'homelab');
    assert.deepEqual(homelab?.runtimeWork, [{ id: rebase.id, title: 'Rebase #12 onto the current base', status: 'implementing' }]);
    assert.equal(homelab?.activity, 'working', 'runtime work counts as working with every chat idle');
    assert.equal(read.owners.find(owner => owner.id === 'moneo')?.activity, 'idle');

    await runtime.ledger.update(rebase.id, current => ({ ...current, activeRunner: undefined }));
    const settled = (await call('GET', '/api/state')).body as typeof read;
    assert.deepEqual(settled.owners.find(owner => owner.id === 'homelab')?.runtimeWork, []);
    assert.equal(settled.owners.find(owner => owner.id === 'homelab')?.activity, 'idle');
  } finally {
    server.close();
  }
});

test('the person\'s owner order is kept by the server and new owners follow it', async () => {
  const { ordered } = await import('@onionsoup/surface');
  assert.deepEqual(ordered([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], ['c', 'a']).map(owner => owner.id), ['c', 'a', 'b', 'd']);
  const { server, call } = await start();
  try {
    assert.equal((await call('PUT', '/api/settings/owner-order', { order: 'moneo' })).status, 400);
    assert.equal((await call('PUT', '/api/settings/owner-order', { order: ['moneo', 'bellonda'] })).status, 200);
    const owners = (await call('GET', '/api/state')).body.owners as { id: string }[];
    assert.deepEqual(owners.slice(0, 2).map(owner => owner.id), ['moneo', 'bellonda']);
  } finally {
    server.close();
  }
});

test('a chat can be renamed through the surface', async () => {
  const { server, call } = await start();
  try {
    const renamed = await call('PATCH', '/api/owners/bellonda/sessions/ses_1', { title: 'Wiki publishing' });
    assert.deepEqual(renamed.body, { id: 'ses_1', title: 'Wiki publishing' });
    assert.equal((await call('PATCH', '/api/owners/bellonda/sessions/ses_1', { title: '  ' })).status, 400);
  } finally {
    server.close();
  }
});

test('auto-accept answers the prompts of that chat and no other, including ones already waiting', async () => {
  const { server, call, calls } = await start();
  try {
    assert.equal((await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: 'yes' })).status, 400);
    const enabled = await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: true });
    assert.deepEqual(enabled.body, { enabled: true, answered: 1 });
    assert.deepEqual(calls.filter(entry => entry[0] === 'permission'), [['permission', '/desks/bellonda', 'per_1', 'once']]);
    assert.deepEqual((await call('GET', '/api/owners/bellonda/sessions')).body.autoAccept, { ses_1: true });
    await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: false });
    assert.deepEqual((await call('GET', '/api/owners/bellonda/sessions')).body.autoAccept, {});
  } finally {
    server.close();
  }
});

test('auto-accept never answers a plan approval, and only delegated plans wait in the inbox', async () => {
  const { runtime, server, call, calls } = await start(api => {
    api.permissions = async directory => directory.endsWith('bellonda') ? [
      { id: 'per_plan', sessionID: 'ses_1', permission: 'onionsoup_plan_approval', patterns: ['w-plan'], metadata: { item: 'w-plan', title: 'Wiki page', plan: '1. Write the page' }, always: [] },
      { id: 'per_edit', sessionID: 'ses_1', permission: 'edit', patterns: ['docs/x.md'], metadata: {}, always: [] },
    ].filter(entry => !calls.some(call => call[0] === 'permission' && call[2] === entry.id)) : [];
  });
  try {
    const enabled = await call('PUT', '/api/owners/bellonda/sessions/ses_1/auto-accept', { enabled: true });
    assert.deepEqual(enabled.body, { enabled: true, answered: 1 });
    assert.deepEqual(calls.filter(entry => entry[0] === 'permission').map(entry => entry[2]), ['per_edit'], 'the plan approval waits for the person');
    await runtime.notebook('bellonda').ensure('# Charter\n');
    const proposal = { title: 'Wiki page', goal: 'Write it', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const planDocument = { markdown: '1. Write the page', digest: 'd' };
    const inChat = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'awaiting-plan-approval', planDocument });
    const delegated = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'awaiting-plan-approval', planDocument, request: 'r-1' });
    const inbox = (await call('GET', '/api/state')).body.inbox as { kind: string; id: string; title: string; planApproval?: unknown }[];
    assert.ok(inbox.some(entry => entry.kind === 'permission' && entry.id === 'per_plan'), 'the chat prompt is the in-chat plan\'s gate');
    const prompt = inbox.find(entry => entry.id === 'per_plan')!;
    assert.equal(prompt.title, 'Approve plan w-plan: Wiki page');
    assert.deepEqual(prompt.planApproval, { item: 'w-plan', title: 'Wiki page', plan: '1. Write the page' }, 'the plan reaches the surface as a plan, not as JSON');
    assert.deepEqual(inbox.filter(entry => entry.kind === 'plan').map(entry => entry.id), [delegated.id]);
    assert.equal((await call('POST', '/api/decide', { action: 'approve-plan', id: delegated.id })).status, 200);
    const approved = await runtime.ledger.get(delegated.id);
    assert.equal(approved.status, 'working');
    assert.equal(approved.planApproval?.by, 'tester');
    assert.equal((await runtime.ledger.get(inChat.id)).status, 'awaiting-plan-approval');
  } finally {
    server.close();
  }
});

test('a work item\'s hires are found by title in opencode\'s store, and read from it', async () => {
  const { runtime, server, call } = await start();
  try {
    const item = await runtime.ledger.create('clippy', 'rebase', { title: 'Fix it', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' });
    await runtime.ledger.save({ ...item, id: 'w-1' });
    const sessions = (await call('GET', '/api/items/w-1/sessions')).body as unknown as { id: string; title: string }[];
    assert.deepEqual(sessions.map(session => session.title), ['w-1: plan', 'w-1: implement 1']);
    const messages = (await call('GET', '/api/items/w-1/sessions/ses_impl/messages')).body as unknown as { info: { sessionID: string } }[];
    assert.equal(messages[0]?.info.sessionID, 'ses_impl');
    assert.equal((await call('GET', '/api/items/w-1/sessions/ses_x/messages')).status, 404, 'another item\'s session is not served');
  } finally {
    server.close();
  }
});

test('an item page carries the decision it waits on, and its activity lists the work session and its subagents', async () => {
  const { runtime, server, call } = await start(api => {
    api.listSessions = async directory => [
      { id: 'ses_work', title: 'Plan w-2: Wiki page', directory, time: { created: 5, updated: 6 } },
      { id: 'ses_sub', title: 'Task 1 (@onionsoup-implementer subagent)', parentID: 'ses_work', directory, time: { created: 7, updated: 8 } },
      { id: 'ses_other', title: 'Another chat', directory, time: { created: 1, updated: 1 } },
    ];
    api.messages = async (_directory, sessionID) => [{ info: { id: 'msg_owner', sessionID, role: 'user' }, parts: [] }];
  });
  try {
    const proposal = { title: 'Wiki page', goal: 'Write it', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const planDocument = { markdown: '1. Write the page', digest: 'd' };
    const delegated = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'awaiting-plan-approval', planDocument, request: 'r-1' });
    assert.equal((await call('GET', `/api/items/${delegated.id}`)).body.waiting && ((await call('GET', `/api/items/${delegated.id}`)).body.waiting as { kind: string }).kind, 'plan');
    const inChat = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'awaiting-plan-approval', planDocument });
    assert.equal((await call('GET', `/api/items/${inChat.id}`)).body.waiting, undefined, 'answered in the owner\'s chat');
    const working = await runtime.ledger.create('bellonda', 'owner-change', proposal, { status: 'working', planDocument, session: { sessionID: 'ses_work', directory: '/desks/bellonda' } });
    const sessions = (await call('GET', `/api/items/${working.id}/sessions`)).body as unknown as { id: string; label: string; kind: string }[];
    assert.deepEqual(sessions.map(session => [session.id, session.label, session.kind]), [
      ['ses_work', 'work session', 'owner'], ['ses_sub', 'Task 1 (@onionsoup-implementer subagent)', 'owner'],
    ]);
    const messages = (await call('GET', `/api/items/${working.id}/sessions/ses_sub/messages`)).body as unknown as { info: { id: string } }[];
    assert.equal(messages[0]?.info.id, 'msg_owner', 'owner sessions are read from the surface\'s opencode');
    assert.equal((await call('GET', `/api/items/${working.id}/sessions/ses_other/messages`)).status, 404);
  } finally {
    server.close();
  }
});

test('person recovery decisions resume the exact stage, retry failures and cancel a pending push', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.notebook('clippy').ensure('# Charter\n');
    const proposal = { title: 'Recover', goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const item = await runtime.ledger.create('clippy', 'rebase', proposal, { status: 'interrupted', resumeStatus: 'reviewing' });
    assert.equal((await call('POST', '/api/decide', { action: 'resume-item', id: item.id })).status, 200);
    assert.equal((await runtime.ledger.get(item.id)).status, 'reviewing');
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'failed', resumeStatus: 'landing' }));
    assert.equal((await call('POST', '/api/decide', { action: 'retry-item', id: item.id, reason: 'I approve the wording' })).status, 200);
    const retried = await runtime.ledger.get(item.id);
    assert.equal(retried.status, 'landing');
    assert.equal(retried.humanNotes.at(-1)?.note, 'I approve the wording (continue from landing)', 'the note typed with retry is kept');
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'awaiting-push-approval' }));
    assert.equal((await call('POST', '/api/decide', { action: 'cancel-item', id: item.id, reason: 'Keep the existing head' })).status, 200);
    const cancelled = await runtime.ledger.get(item.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.humanNotes.at(-1)?.by, 'tester');
    assert.equal(cancelled.reason, 'Keep the existing head');
  } finally {
    server.close();
  }
});

test('an owner\'s page lists its pending reminders, and the person cancels one with a note', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.notebook('homelab').ensure('# Charter\n');
    const prompt = 'Verify Coder backups on minideb keep exactly 14 days.';
    const reminder = await setReminder(runtime, 'homelab', { after: '15d', prompt });
    const page = (await call('GET', '/api/owners/homelab')).body;
    assert.deepEqual(page.reminders, [{ id: reminder.id, prompt, dueAt: reminder.dueAt, createdAt: reminder.createdAt }]);
    assert.ok(!((await call('GET', '/api/state')).body.inbox as { id: string }[]).some(entry => entry.id === reminder.id), 'a reminder waits on no one');
    const decided = await call('POST', '/api/decide', { action: 'cancel-reminder', id: reminder.id, reason: 'Checked it by hand' });
    assert.equal(decided.body.outcome, 'cancelled');
    const cancelled = await runtime.reminders.get(reminder.id);
    assert.deepEqual(cancelled.cancelled && [cancelled.cancelled.by, cancelled.cancelled.note], ['tester', 'Checked it by hand']);
    assert.deepEqual((await call('GET', '/api/owners/homelab')).body.reminders, []);
    const again = await call('POST', '/api/decide', { action: 'cancel-reminder', id: reminder.id });
    assert.match(String(again.body.error), /reminder_not_pending/);
  } finally {
    server.close();
  }
});

test('attention and uncertain requests have durable decisions in the inbox', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.notebook('bellonda').ensure('# Test');
    await runtime.notebook('bellonda').journal({ kind: 'attention', note: 'Investigate failed deployment' });
    const request = await runtime.requests.open('bellonda', 'bellonda', {
      kind: 'work', purpose: 'fix it', proposal: { title: 'Fix', goal: 'Fix', rationale: 'Broken', acceptance: ['Fixed'], size: 'small' },
    }, 'none');
    await runtime.requests.save({ ...request, status: 'interrupted', operation: { id: 'operation-1', stage: 'pending-owner', startedAt: request.createdAt } });
    const snapshot = (await call('GET', '/api/state')).body;
    const inbox = snapshot.inbox as { id: string; kind: string }[];
    const attention = inbox.find(entry => entry.kind === 'attention')!;
    assert.ok(attention);
    assert.ok(inbox.some(entry => entry.kind === 'request-recovery' && entry.id === request.id));
    assert.equal((await call('POST', '/api/decide', { action: 'acknowledge-attention', id: attention.id, reason: 'Investigating' })).body.outcome, 'acknowledged');
    assert.equal((await call('POST', '/api/decide', { action: 'resolve-attention', id: attention.id, reason: 'Recovered' })).body.outcome, 'resolved');
    assert.equal((await call('POST', '/api/decide', { action: 'cancel-request', id: request.id, reason: 'No longer needed' })).body.outcome, 'failed');
    const remaining = (await call('GET', '/api/state')).body.inbox as { id: string }[];
    assert.ok(!remaining.some(entry => entry.id === attention.id || entry.id === request.id));
    assert.equal((await runtime.requests.get(request.id)).recovery[0]?.reason, 'No longer needed');
  } finally {
    server.close();
  }
});


test('question replies carry every ordered answer to opencode and dismissal uses the rejection endpoint', async () => {
  const { server, call, calls } = await start();
  try {
    const answers = [['Engine', 'Surface', 'Docs'], ['Later'], ['Keep the existing colors.']];
    const reply = await call('POST', '/api/owners/bellonda/questions/question-1', { answers });
    assert.equal(reply.status, 200);
    assert.deepEqual(calls.at(-1), ['question', '/desks/bellonda', 'question-1', answers]);
    const rejected = await call('POST', '/api/owners/bellonda/questions/question-2', { reject: true });
    assert.equal(rejected.status, 200);
    assert.deepEqual(calls.at(-1), ['reject-question', '/desks/bellonda', 'question-2']);
  } finally {
    server.close();
  }
});

test('the surface shows the org chart and initiatives, and the person approves an initiative from the inbox', async () => {
  const { server, runtime, call } = await start();
  try {
    for (const owner of runtime.declarations.owners.keys()) await runtime.notebook(owner).ensure('# Charter\n');
    const org = (await call('GET', '/api/org')).body as unknown as { id: string; manager?: string }[];
    assert.equal(org.find(entry => entry.id === 'clippy')?.manager, 'odrade');
    assert.equal(org.find(entry => entry.id === 'odrade')?.manager, undefined);

    const proposal = (title: string) => ({ title, goal: 'g', rationale: 'r', acceptance: ['a'], size: 'small' as const });
    const drafted = await draftInitiative(runtime, 'odrade', { title: 'Org change', goal: 'Change core then the wiki', rationale: 'r', assignments: [
      { id: 'wiki', to: 'bellonda', proposal: proposal('Wiki'), after: ['core'] },
      { id: 'core', to: 'clippy', proposal: proposal('Core'), after: [] },
    ] }, { sessionID: 'ses_odrade', directory: '/evidence/odrade' });
    await submitInitiative(runtime, 'odrade', drafted.id);
    const inbox = (await call('GET', '/api/state')).body.inbox as { kind: string; id: string; owner: string; detail: string }[];
    const entry = inbox.find(candidate => candidate.kind === 'initiative');
    assert.equal(entry?.id, drafted.id);
    assert.equal(entry?.owner, 'odrade');
    assert.match(entry!.detail, /2 assignments to bellonda, clippy/);

    const detail = (await call('GET', `/api/initiatives/${drafted.id}`)).body as { assignments: { id: string; depth: number; state: string }[]; origin?: unknown };
    assert.deepEqual(detail.assignments.map(assignment => [assignment.id, assignment.depth, assignment.state]), [['core', 0, 'not-dispatched'], ['wiki', 1, 'not-dispatched']]);
    assert.equal(detail.origin, undefined, 'the manager chat stays on the host');
    assert.equal((await call('GET', '/api/initiatives/i-20260924-000000')).status, 404);
    assert.equal((await call('POST', '/api/decide', { action: 'approve-initiative' })).status, 400, 'a decision without an id is refused at the edge');

    assert.equal((await call('POST', '/api/decide', { action: 'approve-initiative', id: drafted.id, note: 'Go' })).body.outcome, 'approved');
    const approved = await runtime.initiatives.get(drafted.id);
    assert.deepEqual([approved.status, approved.approval?.by, approved.approval?.note], ['approved', 'tester', 'Go']);
    const listed = (await call('GET', '/api/initiatives')).body as unknown as { id: string; status: string; total: number }[];
    assert.deepEqual(listed.map(summary => [summary.id, summary.status, summary.total]), [[drafted.id, 'approved', 2]]);
  } finally {
    server.close();
  }
});

test('a report plan under its manager grant says so in the inbox; without a grant it reads as usual', async () => {
  const { server, runtime, call } = await start();
  try {
    for (const owner of runtime.declarations.owners.keys()) await runtime.notebook(owner).ensure('# Charter\n');
    const proposal = { title: 'Core', goal: 'Change core', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const drafted = await draftInitiative(runtime, 'odrade', { title: 'Org change', goal: 'g', rationale: 'r', assignments: [
      { id: 'core', to: 'clippy', proposal, after: [] }, { id: 'wiki', to: 'bellonda', proposal: { ...proposal, title: 'Wiki' }, after: [] },
    ] });
    await submitInitiative(runtime, 'odrade', drafted.id);
    await approveInitiative(runtime, drafted.id, 'person');
    const planDocument = { markdown: '1. Change core', digest: 'd' };
    const assigned = (owner: string, assignment: string) => runtime.ledger.create(owner, 'owner-change', proposal, {
      status: 'awaiting-plan-approval', planDocument, assignment: { initiative: drafted.id, assignment },
    });
    const clippyItem = await assigned('clippy', 'core');
    const bellondaItem = await assigned('bellonda', 'wiki');
    const inbox = (await call('GET', '/api/state')).body.inbox as { kind: string; id: string; detail: string }[];
    assert.equal(inbox.find(entry => entry.id === clippyItem.id)?.detail, 'Odrade reviews under standing grant. Change core');
    assert.equal(inbox.find(entry => entry.id === bellondaItem.id)?.detail, 'Change core');
  } finally {
    server.close();
  }
});

test('a provider failing authentication is in /api/state and the inbox with its fix, until a call succeeds', async () => {
  const { runtime, server, call } = await start();
  try {
    const refused = { name: 'APIError', statusCode: 401, message: 'Incorrect API key provided: sk-svcac****************ab12. See the docs.' };
    await recordProviderFailure(runtime, 'openai', { kind: 'hire', what: 'w-1: review' }, refused);
    await recordProviderFailure(runtime, 'openai', { kind: 'watcher', what: 'homelab' }, refused);
    const failing = (await call('GET', '/api/state')).body;
    const [health] = failing.providerHealth as { provider: string; status: string; failures: number; fix: string; lastError: string }[];
    assert.equal(health?.provider, 'openai');
    assert.equal(health?.status, 'failing');
    assert.equal(health?.failures, 2);
    assert.match(health!.fix, /opencode auth login` and choose OpenAI/);
    assert.doesNotMatch(health!.lastError, /svcac/);
    const entry = (failing.inbox as { kind: string; id: string; title: string; detail: string }[]).find(candidate => candidate.kind === 'provider-auth');
    assert.equal(entry?.id, 'openai');
    assert.equal(entry?.title, 'OpenAI authentication failing');
    assert.match(entry!.detail, /2 failures\. Affected: hire w-1: review, watcher homelab\.\nRun `opencode auth login` and choose OpenAI/);

    await recordProviderSuccess(runtime, 'openai');
    const recovered = (await call('GET', '/api/state')).body;
    assert.deepEqual((recovered.providerHealth as { status: string }[]).map(view => view.status), ['ok'], 'shown a while as recovered');
    assert.equal((recovered.inbox as { kind: string }[]).some(candidate => candidate.kind === 'provider-auth'), false);
  } finally {
    server.close();
  }
});
