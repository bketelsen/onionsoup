import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ITEM_SECTIONS } from '../web/src/components/ItemSections.tsx';
import {
  OPERATOR_ID, OPERATOR_RECOVERY_PERMISSION, OPERATOR_WRITE_PERMISSION, OperatorDeclaration, Runtime, approveInitiative, armDeployment, beginDrain, draftInitiative, listAdmissions,
  recordProviderFailure, recordProviderSuccess, releaseDrain, reportFriction, setReminder,
  effectiveProposalDigest, writeRevision,
  readFrictionTriage, sourceSnapshot,
  submitInitiative,
  WorkItem,
} from '@onionsoup/owners';
import { SurfaceState, surfaceServer, type OpencodeApi } from '@onionsoup/surface';
import { DEFAULT_RELEASE_MANIFEST, readReleaseBuildId } from '../src/deployment-view.ts';
import { publicFrictionDigest } from '../src/friction-public.ts';
import { ItemRequestContext } from '../src/item-request-public.ts';

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

test('item HTTP and sections expose persisted request progress without inventing operational verification', async () => {
  const { runtime, server, call } = await start();
  const proposal = {
    title: 'Verify infrastructure', goal: 'Verify infrastructure without a PR', rationale: 'Operational request',
    acceptance: ['Host evidence proves the original goal'], size: 'small' as const,
  };
  try {
    const request = await runtime.requests.open('homelab', 'clippy', {
      kind: 'work', purpose: proposal.goal, proposal,
    }, 'none');
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { request: request.id, status: 'working' });
    await runtime.requests.save({ ...request, workItem: item.id, status: 'work-running' });
    const response = await call('GET', `/api/items/${item.id}`);
    assert.equal(response.status, 200);
    const context = ItemRequestContext.parse(response.body);
    const returnedItem = WorkItem.parse(response.body.item);
    assert.ok(context.requestText);
    assert.match(context.requestText, new RegExp(request.id));
    assert.match(context.requestText, /unavailable; no readable, matching request-scoped host evidence/);
    assert.doesNotMatch(context.requestText, /operational goal verified/i);
    assert.equal(returnedItem.publication, undefined);
    assert.equal((await runtime.requests.get(request.id)).status, 'work-running');
    const html = ITEM_SECTIONS.map(Section => renderToStaticMarkup(createElement(Section, {
      item: returnedItem, ...context,
    }))).join('');
    assert.match(html, /Request and host evidence/);
    assert.match(html, new RegExp(request.id));
  } finally {
    server.close();
  }
});

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
  snapshot?: (workspace: string) => Promise<string>,
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
    sessionID => [{ info: { id: 'msg_1', sessionID, role: 'assistant' }, parts: [] }], hireSessions, undefined, () => true, snapshot);
  const buildId = await readReleaseBuildId(manifestPath ?? DEFAULT_RELEASE_MANIFEST);
  const { server } = surfaceServer(state, { webRoot: '/nonexistent', by: 'tester', buildId });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { runtime, server, call, calls, state };
}

test('item API distinguishes prepared closure from explicit acceptance and retains the old revise verdict', async () => {
  const { runtime, server, call } = await start();
  try {
    const proposal = { title: 'Repair friction', goal: 'Preserve history while revalidating safely', rationale: 'Trial', acceptance: ['No duplicate dispatch'], size: 'small' as const };
    const at = new Date().toISOString();
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, { status: 'working', request: 'r-trial',
      reason: 'review_changes_required', verdicts: [{ decision: 'revise', summary: 'Original dispatch races', findings: [] }] });
    const merge = { url: 'https://github.com/example/repo/pull/100', repository: 'example/repo', baseBranch: 'main',
      head: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), mergedAt: at };
    const candidate: NonNullable<WorkItem['requestClosureCandidates']>[number] = {
      digest: 'd'.repeat(64), item: item.id, request: 'r-trial', owner: 'clippy', proposal, planDigest: 'original-plan',
      requestDigest: 'e'.repeat(64), subjectDigest: 'f'.repeat(64), configurationDigest: '1'.repeat(64), historyDigest: '2'.repeat(64),
      approvalDigest: '3'.repeat(64), planDocumentDigest: '4'.repeat(64),
      directory: '/fixture/integrated', repository: 'example/repo', baseBranch: 'main', head: 'c'.repeat(40), tree: 'd'.repeat(40), base: 'b'.repeat(40),
      historicalMerges: [merge], followUps: [{ ...merge, url: 'https://github.com/example/repo/pull/107', mergeCommit: 'c'.repeat(40) }],
      originalFindings: [], verification: { observedAt: at, tree: 'd'.repeat(40), verifier: 'host-sandbox', checks: [] },
      review: { reviewer: 'fixture/other-family', verdict: { decision: 'approve', summary: 'Follow-up fixes scoped findings', findings: [] }, resolutions: [] },
      preparedBy: 'person', preparedAt: at,
    };
    await runtime.ledger.update(item.id, current => ({ ...current, requestClosureCandidates: [candidate] }));
    const prepared = (await call('GET', `/api/items/${item.id}`)).body;
    assert.equal(prepared.done, false);
    assert.equal((prepared.item as WorkItem).requestAcceptance, undefined);
    const receipt = { candidate, by: 'person', note: 'Original scoped goal met', acceptedAt: at };
    await runtime.ledger.update(item.id, current => ({ ...current, status: 'landed', requestAcceptance: receipt }));
    const accepted = (await call('GET', `/api/items/${item.id}`)).body;
    assert.equal(accepted.done, true);
    assert.equal(accepted.waiting, undefined);
    assert.deepEqual((accepted.item as WorkItem).requestAcceptance, receipt);
    assert.equal((accepted.item as WorkItem).verdicts[0]!.decision, 'revise');
    assert.equal((accepted.item as WorkItem).reason, 'review_changes_required');
    assert.match(String(accepted.text), /goal accepted by person/);
    assert.match(String(accepted.text), /Review 1: revise/);
    assert.match(String(accepted.text), /deployment not assessed/);
    const section = ITEM_SECTIONS.find(component => component.name === 'RequestAcceptance')!;
    const html = renderToStaticMarkup(createElement(section, { item: accepted.item as WorkItem }));
    assert.match(html, /Original goal accepted/);
    assert.match(html, /by person/);
    assert.match(html, /pull\/107/);
    assert.match(html, /earlier review verdicts remain unchanged/);
  } finally {
    server.close();
  }
});

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
    assert.equal(owners.find(owner => owner.id === 'clippy')?.chat, true);
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
    await mkdir(join(runtime.stateDirectory, 'friction/investigations'), { recursive: true });
    await writeFile(join(runtime.stateDirectory, 'friction/investigations', `${first.id}.json`), JSON.stringify({
      version: 1, id: first.id, policy: { version: 1, owner: 'bellonda', repository: 'example/wiki', enabledSince: first.firstSeen },
      state: 'investigated', runner: 1234, token: 'private-claim-token', sessionID: 'private-hire-session',
      createdAt: first.firstSeen, updatedAt: first.lastSeen,
      investigation: { disposition: 'needs-evidence', observed: [], inferred: [], unknown: ['Need a reproduction'] },
    }));
    const detail = await call('GET', `/api/friction/${first.id}`);
    assert.match(JSON.stringify(detail.body), /Need a reproduction/);
    assert.doesNotMatch(JSON.stringify(detail.body), /private-claim-token|private-hire-session|runner/);
    await writeFile(join(runtime.stateDirectory, 'friction/investigations', `${first.id}.json`), '{broken');
    const corrupt = await call('GET', `/api/friction/${first.id}`);
    assert.equal(corrupt.status, 200);
    assert.equal(corrupt.body.triageError, 'friction_triage_unreadable');
    assert.equal(((await call('GET', '/api/friction')).body as unknown as unknown[]).length, 2);
    assert.equal((await call('GET', '/api/state')).status, 200);
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
    const created = await call('POST', '/api/owners/clippy/sessions', {});
    assert.equal(created.status, 200);
    assert.equal(created.body.id, 'ses_2');
    assert.equal((await call('POST', '/api/owners/clippy/sessions/ses_1/prompt', { text: 'Wrong owner' })).status, 404);
    assert.equal((await call('POST', '/api/owners/clippy/sessions/ses_2/prompt', { text: 'What do you know?' })).status, 200);
    // start() injects the /desks/<id> resolver: this checks agent mapping, not filesystem workspace creation.
    assert.deepEqual(calls.at(-1), ['prompt', '/desks/clippy', 'ses_2', 'onionsoup-owner-clippy', 'What do you know?']);
    assert.equal((await call('GET', '/api/owners/nobody/sessions')).status, 404);
    assert.match(String((await call('POST', '/api/decide', { action: 'launch', id: 'x' })).body.error), /unknown_decision|not found|ENOENT/);
  } finally {
    server.close();
  }
});

test('the operator has a chat of its own in its directory, apart from the owners, with its prompts in the inbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surface-operator-'));
  const { server, call, calls, runtime } = await start(api => {
    const createSession = api.createSession;
    api.createSession = async (...args) => {
      const created = await createSession(...args);
      return args[0] === directory ? { ...(created as object), id: 'ses_op' } : created;
    };
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
    const created = await call('POST', '/api/owners/operator/sessions', {});
    assert.equal(created.status, 200);
    assert.equal(created.body.id, 'ses_op');
    assert.deepEqual(calls.at(-1), ['create', directory, undefined, 'Operator']);
    assert.equal((await call('POST', '/api/owners/operator/sessions/ses_op/prompt', { text: 'check the daemon' })).status, 200);
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

test('operator recovery always waits for the person despite chat auto-accept, including inherited child settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-recovery-gate-'));
  const digest = 'fixture-exact-child-recovery-digest';
  const { runtime, server, call, calls, state } = await start(api => {
    api.listSessions = async candidate => candidate === directory ? [
      { id: 'ses_operator', title: 'Operator chat', directory, time: { created: 0, updated: 0 } },
      { id: 'ses_child', parentID: 'ses_operator', title: 'Native child', directory, time: { created: 0, updated: 0 } },
    ] : [];
    api.permissions = async candidate => candidate === directory ? [
      { id: 'per_recovery', sessionID: 'ses_operator', permission: OPERATOR_RECOVERY_PERMISSION,
        patterns: [digest], metadata: { jobID: 'job_fixture', childID: 'child_fixture', digest }, always: [] },
      { id: 'per_child_recovery', sessionID: 'ses_child', permission: OPERATOR_RECOVERY_PERMISSION,
        patterns: [digest], metadata: { jobID: 'job_fixture', childID: 'child_fixture', digest }, always: [] },
      { id: 'per_read', sessionID: 'ses_operator', permission: 'read', patterns: ['README.md'], metadata: {}, always: [] },
    ].filter(entry => !calls.some(call => call[0] === 'permission' && call[2] === entry.id)) : [];
  });
  try {
    runtime.declarations.operator = OperatorDeclaration.parse({ name: 'Duncan', title: 'Operator', model: 'github-copilot/gpt-6-sol', directory });
    const enabled = await call('PUT', '/api/owners/operator/sessions/ses_operator/auto-accept', { enabled: true });
    assert.deepEqual(enabled.body, { enabled: true, answered: 1 });
    assert.deepEqual(calls.filter(entry => entry[0] === 'permission').map(entry => entry[2]), ['per_read']);
    await state.autoAnswerAll();
    assert.equal(calls.filter(entry => entry[0] === 'permission').length, 1, 'repeated passes never approve recovery');
    const inbox = (await call('GET', '/api/state')).body.inbox as { id: string; owner: string }[];
    assert(inbox.some(entry => entry.id === 'per_recovery' && entry.owner === OPERATOR_ID));
    assert(inbox.some(entry => entry.id === 'per_child_recovery' && entry.owner === OPERATOR_ID));
    const rejected = await call('POST', '/api/owners/operator/permissions/per_recovery', { reply: 'reject' });
    assert.equal(rejected.status, 200);
    assert.deepEqual(calls.at(-1), ['permission', directory, 'per_recovery', 'reject']);
  } finally {
    server.close();
  }
});

test('operator write creation and reviewed-diff acceptance are never auto-accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-write-gate-'));
  const { runtime, server, call, calls, state } = await start(api => {
    api.listSessions = async candidate => candidate === directory ? [
      { id: 'ses_operator', title: 'Duncan chat', directory, time: { created: 0, updated: 0 } },
      { id: 'ses_child', parentID: 'ses_operator', title: 'Native child', directory, time: { created: 0, updated: 0 } },
    ] : [];
    api.permissions = async candidate => candidate === directory ? [
      ...['create-write', 'accept-write'].flatMap(mode => ['ses_operator', 'ses_child'].map(sessionID => ({
        id: `per_${mode}_${sessionID}`, sessionID, permission: OPERATOR_WRITE_PERMISSION,
        patterns: [`${mode}/job/child/exact-digest`], metadata: { mode, approvalScope: 'once' }, always: [],
      }))),
      { id: 'per_read', sessionID: 'ses_operator', permission: 'read', patterns: ['README.md'], metadata: {}, always: [] },
    ].filter(entry => !calls.some(call => call[0] === 'permission' && call[2] === entry.id)) : [];
  });
  try {
    runtime.declarations.operator = OperatorDeclaration.parse({ name: 'Duncan', title: 'Operator', model: 'github-copilot/gpt-6-sol', directory });
    assert.deepEqual((await call('PUT', '/api/owners/operator/sessions/ses_operator/auto-accept', { enabled: true })).body,
      { enabled: true, answered: 1 });
    await state.autoAnswerAll();
    assert.deepEqual(calls.filter(entry => entry[0] === 'permission').map(entry => entry[2]), ['per_read']);
    const inbox = (await call('GET', '/api/state')).body.inbox as { id: string; owner: string }[];
    assert.equal(inbox.filter(entry => entry.owner === OPERATOR_ID && /^per_(create|accept)-write_/.test(entry.id)).length, 4);
    assert.equal((await call('POST', '/api/owners/operator/permissions/per_create-write_ses_operator', { reply: 'once' })).status, 200);
    assert.equal((await call('POST', '/api/owners/operator/permissions/per_accept-write_ses_operator', { reply: 'reject' })).status, 200);
    assert.deepEqual(calls.filter(entry => entry[0] === 'permission').map(entry => [entry[2], entry[3]]),
      [['per_read', 'once'], ['per_create-write_ses_operator', 'once'], ['per_accept-write_ses_operator', 'reject']]);
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

test('human session stop persists a pause, aborts children, rejects messages and explicitly resumes original approval', async () => {
  const busySessions = new Set(['ses_work', 'ses_child']);
  const stopped: string[] = [];
  const { runtime, server, call, calls } = await start(api => {
    api.listSessions = async directory => [
      { id: 'ses_work', directory, title: 'Original work', time: { created: 1, updated: 1 } },
      { id: 'ses_child', directory, parentID: 'ses_work', title: 'Implementer', time: { created: 1, updated: 1 } },
    ];
    api.status = async () => Object.fromEntries([...busySessions].map(id => [id, { type: 'busy' }]));
    api.abort = async (_directory, id) => { stopped.push(id); busySessions.delete(id); };
  });
  try {
    await runtime.notebook('clippy').ensure('# Charter\n');
    const proposal = { title: 'Original', goal: 'Approved original goal', rationale: 'r', acceptance: ['a'], size: 'small' as const };
    const item = await runtime.ledger.create('clippy', 'owner-change', proposal, {
      status: 'working', session: { sessionID: 'ses_work', directory: '/desks/clippy' },
      planDocument: { markdown: 'Carry out the original plan', digest: 'original' },
      planApproval: { by: 'original-person', at: '2026-10-01T00:00:00Z' },
    });
    const outcome = await call('POST', '/api/owners/clippy/sessions/ses_work/abort', {});
    assert.equal(outcome.status, 200, String(outcome.body.error));
    assert.equal(outcome.body.outcome, 'paused');
    assert.deepEqual(stopped, ['ses_child', 'ses_work']);
    const paused = await runtime.ledger.get(item.id);
    assert.equal(paused.status, 'paused');
    assert.ok(paused.pauses[0]?.stoppedAt);
    assert.equal((await call('POST', '/api/owners/clippy/sessions/ses_work/prompt', { text: 'Resume please' })).status, 409);
    assert.equal(calls.some(entry => entry[0] === 'prompt'), false);
    assert.equal((await runtime.ledger.get(item.id)).status, 'paused');
    const snapshot = (await call('GET', '/api/state')).body as { owners: { id: string; running: number }[] };
    assert.equal(snapshot.owners.find(owner => owner.id === 'clippy')?.running, 0);
    const resumed = await call('POST', '/api/decide', { action: 'resume-item', id: item.id });
    assert.equal(resumed.status, 200, String(resumed.body.error));
    const persisted = await runtime.ledger.get(item.id);
    assert.equal(persisted.status, 'working');
    assert.deepEqual(persisted.planApproval, item.planApproval);
    assert.deepEqual(persisted.proposal, item.proposal);
    assert.equal(persisted.session?.sessionID, 'ses_work');
    const repeated = await call('POST', '/api/decide', { action: 'resume-item', id: item.id });
    assert.equal(repeated.status, 200);
    assert.equal((await runtime.ledger.get(item.id)).humanNotes.filter(note => note.kind === 'resume').length, 1);
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
    const seen = (await call('GET', '/api/state')).body;
    assert.ok(!(seen.inbox as { id: string }[]).some(entry => entry.id === attention.id));
    assert.equal((seen.owners as { id: string; waiting: number }[]).find(owner => owner.id === 'bellonda')?.waiting, 3,
      'only the two chat permissions and interrupted request remain waiting');
    const history = (await call('GET', '/api/owners/bellonda')).body.backlog as { id: string; status: string }[];
    assert.equal(history.find(entry => entry.id === attention.id)?.status, 'acknowledged');
    assert.equal((await call('POST', '/api/decide', { action: 'resolve-attention', id: attention.id, reason: 'Recovered' })).body.outcome, 'resolved');
    assert.equal((await call('POST', '/api/decide', { action: 'cancel-request', id: request.id, reason: 'No longer needed' })).body.outcome, 'failed');
    const remaining = (await call('GET', '/api/state')).body.inbox as { id: string }[];
    assert.ok(!remaining.some(entry => entry.id === attention.id || entry.id === request.id));
    assert.equal((await runtime.requests.get(request.id)).recovery[0]?.reason, 'No longer needed');
  } finally {
    server.close();
  }
});

test('owner housekeeping and legacy suggestions do not count as waiting; human approvals, questions and permissions still do', async () => {
  const { runtime, server, call } = await start(api => {
    api.permissions = async directory => directory.endsWith('homelab')
      ? [{ id: 'permission-fixture', sessionID: 'ses_1', permission: 'edit', patterns: ['config.yaml'], always: [], metadata: {} }] : [];
    api.questions = async directory => directory.endsWith('homelab')
      ? [{ id: 'question-fixture', sessionID: 'ses_1', questions: [
        { question: 'Which authority?', header: 'Authority', options: [{ label: 'Keep', description: 'Keep current scope' }] },
      ] }] : [];
  });
  try {
    const notebook = runtime.notebook('homelab');
    await notebook.ensure('# Fixture');
    await notebook.journal({ kind: 'attention', note: 'Cleanup needs approval urgently', provenance: { kind: 'maintenance', code: 'cleanup' } });
    await notebook.journal({ kind: 'attention', note: 'proposed work: Improve checks: Better checks (plan it with the owner in chat)' });
    await notebook.journal({ kind: 'attention', note: 'Choose configured authority', provenance: { kind: 'human-decision', code: 'authority_discrepancy' } });
    const proposal = { title: 'Actual plan', goal: 'Approved work', rationale: 'Fixture', acceptance: ['Done'], size: 'small' as const };
    const item = await runtime.ledger.create('homelab', 'owner-change', proposal, {
      status: 'awaiting-plan-approval', request: 'r-fixture', planDocument: { markdown: 'Plan', digest: 'fixture' },
    });
    const snapshot = (await call('GET', '/api/state')).body;
    const inbox = snapshot.inbox as { id: string; kind: string; title: string }[];
    const human = inbox.find(entry => entry.kind === 'attention')!;
    assert.equal(human.title, 'Choose configured authority');
    assert.ok(inbox.some(entry => entry.kind === 'plan' && entry.id === item.id));
    assert.ok(inbox.some(entry => entry.kind === 'question'));
    assert.ok(inbox.some(entry => entry.kind === 'permission'));
    assert.equal((snapshot.owners as { id: string; waiting: number }[]).find(owner => owner.id === 'homelab')?.waiting, 4);
    const page = (await call('GET', '/api/owners/homelab')).body;
    assert.equal((page.backlog as { status: string }[]).filter(entry => entry.status === 'open').length, 2);
    await call('POST', '/api/decide', { action: 'acknowledge-attention', id: human.id, reason: 'Seen' });
    const seen = (await call('GET', '/api/state')).body;
    assert.equal((seen.owners as { id: string; waiting: number }[]).find(owner => owner.id === 'homelab')?.waiting, 3);
    assert.equal((await runtime.ledger.get(item.id)).status, 'awaiting-plan-approval');
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

test('attention assignment route preserves Seen and exposes linked gated request without spoofed actor', async () => {
  const { runtime, server, call } = await start();
  try {
    await runtime.notebook('bellonda').ensure('# Test');
    await runtime.notebook('bellonda').journal({ kind: 'attention', note: 'Repair the check' });
    const inbox = (await call('GET', '/api/state')).body.inbox as { id: string; kind: string }[];
    const attention = inbox.find(entry => entry.kind === 'attention')!;
    const assignment = { owner: 'clippy', repository: 'example/clippy', title: 'Fix check', goal: 'Correct check', acceptance: ['Regression passes'], by: 'spoofed' };
    const first = await call('POST', '/api/decide', { action: 'assign-attention', id: attention.id, assignment });
    assert.match(String(first.body.outcome), /pending-owner/);
    await call('POST', '/api/decide', { action: 'assign-attention', id: attention.id, assignment });
    const retried = await call('POST', '/api/decide', { action: 'retry-attention-assignment', id: attention.id });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.outcome, 'pending-owner');
    const requests = await runtime.requests.list();
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.ask.kind, 'work');
    if (request.ask.kind === 'work') assert.notEqual(request.ask.operatorAssignment?.by, 'spoofed');
    const current = (await call('GET', '/api/state')).body.inbox as { id: string; attentionStatus?: string; attentionAssignment?: { requestID: string } }[];
    const entry = current.find(candidate => candidate.id === attention.id)!;
    assert.equal(entry.attentionStatus, 'open');
    assert.equal(entry.attentionAssignment?.requestID, request.id);
  } finally { server.close(); }
});


test('HTTP friction promotion binds displayed evidence and exposes gated linked work', async () => {
  const { runtime, server, call } = await start();
  try {
    const workspace = await mkdtemp(join(tmpdir(), 'surface-friction-source-'));
    runtime.declarations.owners.get('bellonda')!.workspace = workspace;
    execFileSync('git', ['init', '--quiet', workspace]);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'source']);
    const sourceCommit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await runtime.notebook('bellonda').ensure('# Test');
    const report = await reportFriction(runtime, { owner: 'bellonda', submissionID: 'promotion',
      origin: { sessionID: 'ses_origin', directory: '/private/desk' }, model: 'fixture/model', commit: 'a'.repeat(40), failures: [],
      input: { summary: 'Missing evidence', expected: 'Reviewer reads facts', actual: 'Reviewer blocked' } });
    const directory = join(runtime.stateDirectory, 'friction/investigations');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${report.id}.json`), JSON.stringify({ version: 1, id: report.id, state: 'investigated',
      createdAt: report.firstSeen, updatedAt: report.lastSeen,
      sourceCommit,
      policy: { version: 1, owner: 'bellonda', repository: 'example/wiki', enabledSince: report.firstSeen },
      investigation: { disposition: 'propose-fix', observed: ['Checked source'], inferred: [], unknown: [],
        proposedWork: { title: 'Fix evidence', goal: 'Expose facts', rationale: 'Review blocked', size: 'small',
          repository: 'example/wiki', acceptance: ['Reviewer sees facts'] } } }));
    const view = await call('GET', `/api/friction/${report.id}`);
    assert.match(String(view.body.proposalDigest), /^[a-f0-9]{64}$/);
    const stale = await call('POST', '/api/decide', { action: 'promote-friction', id: report.id, proposalDigest: '0'.repeat(64) });
    assert.match(String(stale.body.error), /friction_proposal_stale/);
    assert.equal((await runtime.requests.list()).length, 0);
    const decision = { action: 'promote-friction', id: report.id, proposalDigest: view.body.proposalDigest };
    assert.equal((await call('POST', '/api/decide', decision)).status, 200);
    assert.equal((await call('POST', '/api/decide', decision)).status, 200);
    const [request] = await runtime.requests.list();
    assert.equal(request.status, 'pending-owner');
    assert.deepEqual(request.approvals, []);
    assert.equal((await runtime.ledger.list()).length, 0);
    await runtime.requests.update(request.id, current => ({ ...current, status: 'denied', reason: 'Stop' }));
    const linked = await call('GET', `/api/friction/${report.id}`);
    assert.match(JSON.stringify(linked.body.promotion), /denied/);
    assert.match(JSON.stringify(linked.body.promotion), new RegExp(request.id));
    assert.doesNotMatch(JSON.stringify(linked.body), /private\/desk/);
  } finally { server.close(); }
});

async function frictionSourceFixture(runtime: Runtime) {
  const workspace = await mkdtemp(join(tmpdir(), 'surface-friction-freshness-'));
  runtime.declarations.owners.get('bellonda')!.workspace = workspace;
  execFileSync('git', ['init', '--quiet', workspace]);
  const commit = (message: string) => {
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', message]);
    return execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const originalCommit = commit('original');
  await runtime.notebook('bellonda').ensure('# Test');
  const report = await reportFriction(runtime, { owner: 'bellonda', submissionID: 'freshness',
    origin: { sessionID: 'ses_origin', directory: '/private/desk' }, model: 'fixture/model', commit: originalCommit,
    failures: [], input: { summary: 'Original issue', expected: 'Works', actual: 'Fails' } });
  const investigation = { disposition: 'propose-fix' as const, observed: ['Original observation'], inferred: [], unknown: [],
    proposedWork: { title: 'Original fix', goal: 'Original goal', rationale: 'Observed failure', size: 'small' as const,
      repository: 'example/wiki', acceptance: ['Works'] } };
  const directory = join(runtime.stateDirectory, 'friction/investigations');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${report.id}.json`), JSON.stringify({ version: 1, id: report.id, state: 'investigated',
    createdAt: report.firstSeen, updatedAt: report.lastSeen, sourceCommit: originalCommit,
    policy: { version: 1, owner: 'bellonda', repository: 'example/wiki', enabledSince: report.firstSeen }, investigation }));
  return { report, investigation, originalCommit, commit, workspace };
}

test('one friction list pass shares a workspace snapshot without caching across polls', async () => {
  let snapshots = 0;
  const { runtime, server, state } = await start(undefined, undefined, undefined, async workspace => {
    snapshots++;
    return sourceSnapshot(workspace);
  });
  try {
    const fixture = await frictionSourceFixture(runtime);
    for (let index = 0; index < 5; index++) {
      const report = await reportFriction(runtime, { owner: 'bellonda', submissionID: `shared-${index}`,
        origin: { sessionID: `ses_${index}`, directory: '/private/desk' }, model: 'fixture/model',
        commit: fixture.originalCommit, failures: [],
        input: { summary: `Distinct issue ${'abcdefghij'[index]} in checkout`, expected: 'Works', actual: 'Fails' } });
      const triage = await readFrictionTriage(runtime, fixture.report.id);
      await writeFile(join(runtime.stateDirectory, 'friction/investigations', `${report.id}.json`),
        JSON.stringify({ ...triage, id: report.id }));
    }
    const entries = await state.friction();
    assert.equal(entries.length, 6);
    assert.ok(entries.every(entry => entry.freshness?.stale === false && entry.proposalDigest));
    assert.equal(snapshots, 1);
    await state.fingerprint();
    assert.equal(snapshots, 2);
  } finally { server.close(); }
});

test('HTTP friction view marks changed local checkout stale without proposing or promoting', async () => {
  const { runtime, server, call, state } = await start();
  try {
    const fixture = await frictionSourceFixture(runtime);
    const before = await state.fingerprint();
    const referenceCommit = fixture.commit('changed source');
    const response = await call('GET', `/api/friction/${fixture.report.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.freshness, {
      investigatedCommit: fixture.originalCommit, referenceCommit, stale: true,
      reason: 'source_stale', scope: 'local-checkout-not-fetched',
    });
    assert.deepEqual(response.body.revisions, []);
    assert.deepEqual(response.body.originalInvestigation, fixture.investigation);
    assert.equal(response.body.effectiveRevision, 0);
    assert.equal('proposalDigest' in response.body, false);
    assert.deepEqual((response.body.triage as { investigation: unknown }).investigation, fixture.investigation);
    assert.deepEqual(response.body.promotionHistory, []);
    assert.notEqual(await state.fingerprint(), before, 'freshness changes trigger the stream');
    assert.equal((await runtime.requests.list()).length, 0);
  } finally { server.close(); }
});

test('HTTP friction view preserves investigation and withholds digest when a revision is unreadable', async () => {
  const { runtime, server, call } = await start();
  try {
    const fixture = await frictionSourceFixture(runtime);
    const revisions = join(runtime.stateDirectory, 'friction', 'investigations', fixture.report.id);
    await mkdir(revisions, { recursive: true });
    await writeFile(join(revisions, 'rev-1.json'), '{broken');
    const response = await call('GET', `/api/friction/${fixture.report.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.originalInvestigation, fixture.investigation);
    assert.deepEqual((response.body.triage as { investigation: unknown }).investigation, fixture.investigation);
    assert.deepEqual(response.body.unreadable, ['friction_revisions_unreadable']);
    assert.equal('proposalDigest' in response.body, false);
    assert.equal(response.body.triageError, undefined);
  } finally { server.close(); }
});

test('HTTP friction view reports unreadable promotion history without hiding its investigation', async () => {
  const { runtime, server, call } = await start();
  try {
    const fixture = await frictionSourceFixture(runtime);
    const history = join(runtime.stateDirectory, 'friction', 'promotions', fixture.report.id);
    await mkdir(history, { recursive: true });
    await writeFile(join(history, 'superseded-1.json'), '{broken');
    const response = await call('GET', `/api/friction/${fixture.report.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.originalInvestigation, fixture.investigation);
    assert.deepEqual((response.body.triage as { investigation: unknown }).investigation, fixture.investigation);
    assert.deepEqual(response.body.unreadable, ['friction_promotion_history_unreadable']);
    assert.match(String(response.body.proposalDigest), /^[a-f0-9]{64}$/);
    assert.equal(response.body.triageError, undefined);
  } finally { server.close(); }
});

test('a mismatched freshness view cannot offer a digest for a different effective revision', async () => {
  const { runtime, server } = await start();
  try {
    const fixture = await frictionSourceFixture(runtime);
    const triage = (await readFrictionTriage(runtime, fixture.report.id))!;
    assert.equal(publicFrictionDigest({ triage, revision: 0 }, {
      investigatedCommit: 'b'.repeat(40), referenceCommit: 'b'.repeat(40),
      stale: false, scope: 'local-checkout-not-fetched',
    }), undefined);
  } finally { server.close(); }
});

test('HTTP friction view exposes a revised proposal after blocked old intent, and preserves history and effective evidence', async () => {
  const { runtime, server, call, state } = await start();
  try {
    const fixture = await frictionSourceFixture(runtime);
    const initial = (await call('GET', `/api/friction/${fixture.report.id}`)).body;
    const initialDigest = String(initial.proposalDigest);
    const open = runtime.requests.openIdentified.bind(runtime.requests);
    runtime.requests.openIdentified = async () => { throw new Error('routing paused'); };
    const oldDecision = { action: 'promote-friction', id: fixture.report.id, proposalDigest: initialDigest };
    assert.match(String((await call('POST', '/api/decide', oldDecision)).body.error), /routing_failed/);
    runtime.requests.openIdentified = open;
    const referenceCommit = fixture.commit('changed source');
    assert.match(String((await call('POST', '/api/decide', oldDecision)).body.error), /friction_source_stale/);
    assert.equal((await runtime.requests.list()).length, 0);

    const beforeBlocked = await state.fingerprint();
    await writeRevision(runtime, { version: 1, id: fixture.report.id, revision: 1,
      previousCommit: fixture.originalCommit, sourceCommit: referenceCommit, reason: 'source_stale',
      state: 'blocked', blockedReason: 'friction_citation_unverified', at: fixture.report.firstSeen,
      investigation: { disposition: 'already-fixed', fixedBy: referenceCommit,
        observed: ['unverified.ts:1'], inferred: [], unknown: [] } });
    const blocked = (await call('GET', `/api/friction/${fixture.report.id}`)).body;
    assert.equal(blocked.effectiveRevision, 0);
    assert.equal(blocked.freshness && (blocked.freshness as { stale: boolean }).stale, true);
    assert.equal((blocked.revisions as { blockedReason?: string }[])[0]?.blockedReason, 'friction_citation_unverified');
    assert.equal('proposalDigest' in blocked, false);
    assert.notEqual(await state.fingerprint(), beforeBlocked, 'blocked revisions trigger the stream');
    const beforeRevision = await state.fingerprint();

    const revisedInvestigation = { ...fixture.investigation, observed: ['check.ts:1 still fails'],
      proposedWork: { ...fixture.investigation.proposedWork, goal: 'Revised goal' } };
    await writeRevision(runtime, { version: 1, id: fixture.report.id, revision: 2,
      previousCommit: fixture.originalCommit, sourceCommit: referenceCommit, reason: 'source_stale',
      state: 'revised', at: fixture.report.firstSeen, investigation: revisedInvestigation });
    const revised = (await call('GET', `/api/friction/${fixture.report.id}`)).body;
    assert.equal(revised.effectiveRevision, 2);
    assert.deepEqual(revised.freshness, { investigatedCommit: referenceCommit, referenceCommit,
      stale: false, scope: 'local-checkout-not-fetched' });
    assert.equal((revised.revisions as unknown[]).length, 2);
    assert.deepEqual(revised.originalInvestigation, fixture.investigation);
    assert.deepEqual((revised.triage as { investigation: unknown }).investigation, revisedInvestigation);
    assert.equal(revised.proposalDigest, await effectiveProposalDigest(runtime, fixture.report.id));
    assert.notEqual(revised.proposalDigest, initialDigest);
    assert.notEqual(await state.fingerprint(), beforeRevision, 'revision changes trigger the stream');
    const decision = { action: 'promote-friction', id: fixture.report.id, proposalDigest: revised.proposalDigest };
    assert.equal((await call('POST', '/api/decide', decision)).status, 200);
    assert.equal((await call('POST', '/api/decide', decision)).status, 200);
    const [request] = await runtime.requests.list();
    assert.equal((await runtime.requests.list()).length, 1);
    assert.equal(request.ask.kind === 'work' && request.ask.proposal.goal, 'Revised goal');
    const promoted = (await call('GET', `/api/friction/${fixture.report.id}`)).body;
    assert.equal((promoted.promotionHistory as { digest: string; state: string; reason: string }[])[0]?.digest, initialDigest);
    assert.equal((promoted.promotionHistory as { state: string; reason: string }[])[0]?.state, 'blocked');
    assert.equal((promoted.promotionHistory as { reason: string }[])[0]?.reason, 'friction_source_stale');
    assert.equal((promoted.promotionHistory as unknown[]).length, 1);
    assert.equal((promoted.promotion as { digest: string }).digest, revised.proposalDigest);
    assert.doesNotMatch(JSON.stringify(promoted), /private\/desk/);

    await writeRevision(runtime, { version: 1, id: fixture.report.id, revision: 3,
      previousCommit: referenceCommit, sourceCommit: referenceCommit, reason: 'source_stale',
      state: 'revised', at: fixture.report.firstSeen,
      investigation: { disposition: 'already-fixed', fixedBy: referenceCommit,
        observed: ['check.ts:1 fixed'], inferred: [], unknown: [] } });
    const fixed = (await call('GET', `/api/friction/${fixture.report.id}`)).body;
    assert.equal(fixed.effectiveRevision, 3);
    assert.equal('proposalDigest' in fixed, false);
    assert.equal((fixed.triage as { investigation: { disposition: string; fixedBy: string; observed: string[]; proposedWork?: unknown } }).investigation.disposition, 'already-fixed');
    assert.equal((fixed.triage as { investigation: { fixedBy: string } }).investigation.fixedBy, referenceCommit);
    assert.deepEqual((fixed.triage as { investigation: { observed: string[] } }).investigation.observed, ['check.ts:1 fixed']);
    assert.equal((fixed.triage as { investigation: { proposedWork?: unknown } }).investigation.proposedWork, undefined);
    assert.deepEqual(fixed.originalInvestigation, fixture.investigation);
  } finally { server.close(); }
});


test('synthetic revision IDs cannot be acknowledged, resolved or assigned through HTTP', async () => {
  const { runtime, server, call } = await start();
  try {
    const assignment = { owner: 'clippy', repository: 'example/clippy', title: 'Fix', goal: 'Fix check', acceptance: ['Passes'] };
    for (const action of ['acknowledge-attention', 'resolve-attention', 'assign-attention']) {
      const rejected = await call('POST', '/api/decide', { action, id: 'plan-revision-w-fixture', reason: 'Fix it', assignment });
      assert.notEqual(rejected.status, 200);
      assert.match(JSON.stringify(rejected.body), /attention_not_found/);
    }
    assert.equal((await runtime.requests.list()).length, 0);
  } finally { server.close(); }
});
