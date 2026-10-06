import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { approveCreate, approveDelete, processRequest, processRequests, requestInstance } from '../src/brokering.ts';
import { trackDelegatedWork } from '../src/delegation.ts';
import type { HireSessionClient } from '../src/opencode.ts';
import { completeOperationalWork, releaseOperationalInstance, reverifyOperationalWork } from '../src/operational-work.ts';
import { pendingNotices } from '../src/notices.ts';
import { requestProgressDetail } from '../src/request-status.ts';
import { readRequestWorkEvidence } from '../src/request-work-evidence.ts';
import { recoverRequests } from '../src/request-recovery.ts';
import { rememberSession } from '../src/session-history.ts';
import { git } from '../src/workspace.ts';
import { messageFixture } from './owner-message-fixture.ts';
import { humanWorkActor, pauseItem, settleItemPause } from '../src/work-pause.ts';

const proposal = { title: 'Runtime check and temporary instance cleanup',
  goal: 'Verify the configured runtime and remove the exact approved temporary instance',
  rationale: 'Operational maintenance requires no repository change',
  acceptance: ['Configured runtime check passes', 'Approved instance is positively absent'], size: 'small' as const };
const image = 'images:debian/13';

async function setup(context: TestContext) {
  const fixture = await messageFixture();
  context.after(() => rm(fixture.root, { force: true, recursive: true }));
  const { runtime } = fixture;
  const owner = runtime.owner('homelab');
  const source = owner.workspace;
  const remote = join(fixture.root, 'remote.git');
  await mkdir(remote);
  await git(remote, ['init', '--bare', '-q', '--initial-branch=main']);
  await git(source, ['remote', 'add', 'origin', remote]);
  await writeFile(join(source, 'check.mjs'), 'if (!process.version.startsWith("v")) process.exit(1);\n');
  await git(source, ['add', 'check.mjs']);
  await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture check']);
  await git(source, ['push', '-qu', 'origin', 'main']);
  runtime.declarations.owners.set('homelab', { ...owner, domain: {
    kind: 'git-repository', name: 'example/fleet', remote, baseBranch: 'main', verify: [[process.execPath, 'check.mjs']],
  } });
  const requesterOwner = runtime.repositoryOwner('bellonda');
  runtime.declarations.owners.set('bellonda', { ...requesterOwner, domain: { ...requesterOwner.domain, remote } });
  const requester = await fixture.addSession('bellonda', 'original-requester', join(fixture.root, 'retired-requester'), true);
  const origin = await fixture.addSession('homelab', 'original-execution', source);
  const request = await runtime.requests.open('bellonda', 'homelab', { kind: 'work', purpose: proposal.goal, proposal }, 'none', requester);
  const item = await runtime.ledger.create('homelab', 'owner-change', proposal, {
    id: `w-request-${request.id}`, status: 'working', request: request.id, session: origin, planWorktree: source,
    planDocument: { markdown: 'Check configured runtime; use the existing gated instance request; observe removal. No repository changes.', digest: 'original-approved-plan' },
    planApproval: { by: 'person', at: new Date().toISOString() },
  });
  await runtime.requests.update(request.id, current => ({ ...current, status: 'work-running', workItem: item.id }));
  const calls: string[][] = [];
  let isPresent = false;
  let tag = '';
  runtime.incus = { run: async args => {
    calls.push([...args]);
    if (args[0] === 'launch') {
      isPresent = true;
      tag = args.at(-1)!.split('=').at(-1)!;
      return '';
    }
    if (args[0] === 'delete') {
      isPresent = false;
      return '';
    }
    if (args[0] === 'list') return JSON.stringify(isPresent
      ? [{ name: 'onionsoup-test', type: 'container', status: 'Running', config: { 'user.onionsoup.request': tag } }]
      : []);
    throw new Error('fixture_unexpected_incus_command');
  } };
  const prompts: { model: string; text: string }[] = [];
  let verdict = { decision: 'approve' as 'approve' | 'revise', summary: 'Exact checks and cleanup satisfy the original scoped goal', findings: [] };
  let onReview = async () => {};
  const sdk = {
    session: {
      create: async () => ({ data: { id: 'ses_independent_review' } }),
      abort: async () => ({ data: true }),
      prompt: async (input: { model: { providerID: string; modelID: string }; parts: { text: string }[] }) => {
        prompts.push({ model: `${input.model.providerID}/${input.model.modelID}`, text: input.parts[0].text });
        await onReview();
        return { data: { info: { role: 'assistant', cost: 0 }, parts: [{ type: 'text', text: JSON.stringify(verdict) }] } };
      },
    },
    permission: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
  } as unknown as HireSessionClient;
  runtime.connectHire = async () => ({ client: sdk, close: () => undefined });
  return { ...fixture, item, request, origin, source, prompts, calls,
    setVerdict: (decision: 'approve' | 'revise') => { verdict = { ...verdict, decision }; },
    onReview: (callback: () => Promise<void>) => { onReview = callback; },
    setTag: (value: string) => { tag = value; }, setPresent: (value: boolean) => { isPresent = value; } };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function resource(fixture: Fixture, followUp = 'none') {
  const { runtime, origin } = fixture;
  const opened = await requestInstance(runtime, 'homelab', 'homelab', {
    kind: 'instance', image, purpose: proposal.goal, expectedMinutes: 5,
  }, followUp, origin);
  await runtime.requests.update(opened.id, current => ({ ...current, status: 'awaiting-create-approval',
    decision: { decision: 'accept', reply: 'Approved domain', remote: 'minideb', image, nameSuffix: 'test' } }));
  return opened;
}
async function cleanedResource(fixture: Fixture) {
  const opened = await resource(fixture);
  await approveCreate(fixture.runtime, opened.id, 'person', false);
  await processRequest(fixture.runtime, opened.id);
  await releaseOperationalInstance(fixture.runtime, 'homelab', opened.id, fixture.origin);
  await approveDelete(fixture.runtime, opened.id, 'person');
  await processRequest(fixture.runtime, opened.id);
  return fixture.runtime.requests.get(opened.id);
}

test('public completion performs host checks, final scripted SDK independent review and one retired-requester continuation; no fake PR', async context => {
  const fixture = await setup(context);
  const resource = await cleanedResource(fixture);
  const { runtime, item, request, origin } = fixture;
  const beforeCalls = fixture.calls.length;
  const completed = await completeOperationalWork(runtime, 'homelab', item.id, origin);
  assert.equal(completed?.status, 'completed');
  const saved = await runtime.ledger.get(item.id);
  assert.equal(saved.status, 'landed');
  assert.equal(saved.publication, undefined);
  assert.equal(saved.deskPublication, undefined);
  const receipt = (await runtime.requests.get(request.id)).operation!.checkpoint!.operational!;
  assert.equal(receipt.item, item.id);
  assert.equal(receipt.session.sessionID, origin.sessionID);
  assert.equal(receipt.effects[0].request, resource.id);
  assert.equal(receipt.effects[0].postcondition, 'absent');
  assert.equal(receipt.effects[0].createApproval, 'person');
  assert.ok(receipt.verification.checks.every(check => check.exitCode === 0));
  assert.notEqual(runtime.family(receipt.review.reviewer), runtime.family(runtime.owner('homelab').model));
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0].text, new RegExp(proposal.goal));
  assert.ok(fixture.calls.slice(beforeCalls).every(call => call[0] === 'list'));
  assert.equal((await readRequestWorkEvidence(runtime, saved)).operational?.request, request.id);
  assert.match(await requestProgressDetail(runtime, 'bellonda', request.id), /Operational goal evidence/);
  await fixture.deliver();
  assert.equal(fixture.creates(), 1);
  const delivery = (await fixture.receipts()).find(receipt => receipt.notice?.change === 'operational-completed')!;
  assert.equal(delivery.agent, 'Bellonda');
  assert.notEqual(delivery.origin.directory, origin.directory);
  assert.ok(!fixture.queries.some(query => query.directory === request.origin!.directory
    && ['create', 'promptAsync'].includes(query.method)));
  fixture.setMode('lost-reply');
  await completeOperationalWork(runtime, 'homelab', item.id, origin);
  await fixture.deliver();
  assert.equal(fixture.prompts.length, 1);
  assert.equal(fixture.sends.length, 1);
  assert.equal((await fixture.receipts())[0].status, 'sent');
});

test('completion cannot execute or bypass existing create/delete gates, nor accept cleanup pending', async context => {
  const fixture = await setup(context);
  const opened = await resource(fixture);
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_instance_provenance_missing/);
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.runtime.requests.get(opened.id)).status, 'awaiting-create-approval');
  await approveCreate(fixture.runtime, opened.id, 'person', false);
  await processRequest(fixture.runtime, opened.id);
  await releaseOperationalInstance(fixture.runtime, 'homelab', opened.id, fixture.origin);
  assert.equal((await fixture.runtime.requests.get(opened.id)).status, 'awaiting-delete-approval');
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_instance_provenance_missing/);
  assert.equal(fixture.calls.filter(call => call[0] === 'delete').length, 0);
  assert.equal(fixture.prompts.length, 0);
  assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'work-running');
});

test('foreign resource identity prevents deletion; failed/unverifiable effects cannot complete work', async context => {
  const fixture = await setup(context);
  const opened = await resource(fixture);
  await approveCreate(fixture.runtime, opened.id, 'person', true);
  await processRequest(fixture.runtime, opened.id);
  fixture.setTag('foreign-request');
  await releaseOperationalInstance(fixture.runtime, 'homelab', opened.id, fixture.origin);
  await processRequest(fixture.runtime, opened.id);
  assert.equal((await fixture.runtime.requests.get(opened.id)).status, 'interrupted');
  assert.equal(fixture.calls.filter(call => call[0] === 'delete').length, 0);
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_resource_cleanup_pending/);
  assert.equal(fixture.prompts.length, 0);
  fixture.runtime.incus = { run: async () => { throw new Error('observation_unavailable'); } };
  await fixture.runtime.requests.update(opened.id, current => ({ ...current, status: 'deleted' }));
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin), /observation_unavailable/);
  assert.equal((await fixture.runtime.ledger.get(fixture.item.id)).status, 'working');
});

test('changed goal, foreign caller, dirty repository and unpublished commits preserve ordinary publication gate', async context => {
  const fixture = await setup(context);
  await cleanedResource(fixture);
  await assert.rejects(completeOperationalWork(fixture.runtime, 'bellonda', fixture.item.id, fixture.origin),
    /operational_item_not_yours/);
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id,
    { ...fixture.origin, sessionID: 'foreign' }), /operational_session_unproven/);
  await fixture.runtime.ledger.update(fixture.item.id, current => ({ ...current,
    proposal: { ...current.proposal, goal: 'A different goal' } }));
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_original_goal_changed/);
  await fixture.runtime.ledger.update(fixture.item.id, current => ({ ...current, proposal }));
  await writeFile(join(fixture.source, 'changed.md'), 'Requires normal publication');
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_repository_publication_required/);
  await git(fixture.source, ['add', 'changed.md']);
  await git(fixture.source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Unpublished']);
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_repository_publication_required/);
  assert.equal(fixture.prompts.length, 0);
});

test('configured failure, missing checks and independent review refusal stay owner reverify work, not human attention', async context => {
  const fixture = await setup(context);
  await cleanedResource(fixture);
  const owner = fixture.runtime.repositoryOwner('homelab');
  fixture.runtime.declarations.owners.set('homelab', { ...owner, domain: { ...owner.domain, verify: [] } });
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_configured_checks_missing/);
  fixture.runtime.declarations.owners.set('homelab', { ...owner, domain: {
    ...owner.domain, verify: [[process.execPath, '-e', 'process.exit(7)']],
  } });
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_configured_checks_failed/);
  fixture.runtime.declarations.owners.set('homelab', owner);
  fixture.setVerdict('revise');
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_goal_review_needs_work/);
  const notices = await pendingNotices(fixture.runtime);
  assert.ok(notices.every(notice => notice.change === 'operational-reverify'));
  assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'work-running');
  assert.equal((await fixture.runtime.ledger.get(fixture.item.id)).status, 'working');
});

test('durable checkpoint repairs both crash windows without re-review or a duplicate requester notice', async context => {
  const fixture = await setup(context);
  await cleanedResource(fixture);
  const update = fixture.runtime.ledger.updateIfChanged.bind(fixture.runtime.ledger);
  fixture.runtime.ledger.updateIfChanged = async () => { throw new Error('crash_before_ledger_projection'); };
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /crash_before_ledger_projection/);
  const request = await fixture.runtime.requests.get(fixture.request.id);
  assert.ok(request.operation?.checkpoint?.operational);
  assert.equal(request.operation?.runner, undefined);
  fixture.runtime.ledger.updateIfChanged = update;
  await fixture.runtime.requests.update(request.id, current => ({
    ...current, operation: { ...current.operation!, runner: 999999 },
  }));
  await recoverRequests(fixture.runtime, (_id, error) => { throw error; });
  assert.ok((await fixture.runtime.requests.get(request.id)).operation?.checkpoint?.operational);
  await processRequests(fixture.runtime);
  assert.equal((await fixture.runtime.requests.get(request.id)).status, 'completed');
  assert.equal(fixture.prompts.length, 1);
  const receipt = (await fixture.runtime.requests.get(request.id)).operation!.checkpoint!;
  await fixture.runtime.requests.update(request.id, current => ({ ...current,
    operation: { ...current.operation!, stage: 'completed', runner: 999999,
      checkpoint: { ...receipt, operationalNoticeQueued: undefined } } }));
  await recoverRequests(fixture.runtime, (_id, error) => { throw error; });
  await processRequest(fixture.runtime, request.id);
  await processRequest(fixture.runtime, request.id);
  assert.equal((await pendingNotices(fixture.runtime)).filter(notice => notice.change === 'operational-completed').length, 1);
  assert.equal(fixture.prompts.length, 1);
});

test('restart of a completed operational checkpoint preserves paused work and rejects a foreign work binding', async context => {
  const fixture = await setup(context);
  const { runtime, item } = fixture;
  await cleanedResource(fixture);
  const update = runtime.ledger.updateIfChanged.bind(runtime.ledger);
  runtime.ledger.updateIfChanged = async () => { throw new Error('crash_before_ledger_projection'); };
  try {
    await assert.rejects(completeOperationalWork(runtime, item.owner, item.id, fixture.origin),
      /crash_before_ledger_projection/);
  } finally {
    runtime.ledger.updateIfChanged = update;
  }
  const checkpoint = (await runtime.requests.get(fixture.request.id)).operation!.checkpoint!;
  assert.ok(checkpoint.operational);
  await pauseItem(runtime, item.id, humanWorkActor(), 'Keep the verified original work intentionally paused');
  assert.equal((await settleItemPause(runtime, item.id, { stop: async origin => {
    assert.deepEqual(origin, fixture.origin);
    return true;
  } })).status, 'paused');
  await runtime.requests.update(fixture.request.id, current => ({
    ...current, status: 'completed', operation: { ...current.operation!, stage: 'completed', runner: 999999 },
  }));
  await recoverRequests(runtime, (_id, error) => { throw error; });
  const recovered = await runtime.requests.get(fixture.request.id);
  assert.equal(recovered.status, 'work-paused');
  assert.deepEqual(recovered.operation?.checkpoint, checkpoint);
  assert.equal(recovered.operation?.runner, undefined);
  assert.equal((await runtime.ledger.get(item.id)).status, 'paused');
  assert.equal(fixture.prompts.length, 1);
  await runtime.ledger.update(item.id, current => ({ ...current, request: 'foreign-request' }));
  await runtime.requests.update(fixture.request.id, current => ({
    ...current, status: 'interrupted', operation: { ...current.operation!, stage: 'completed' },
  }));
  await assert.rejects(recoverRequests(runtime, (_id, error) => { throw error; }), /delegation_request_binding_mismatch/);
  assert.equal((await runtime.requests.get(fixture.request.id)).status, 'interrupted');
  assert.deepEqual((await runtime.requests.get(fixture.request.id)).operation?.checkpoint, checkpoint);
});

test('explicit reverify uses an exact host continuation of original work, retaining its original session and effect scope', async context => {
  const fixture = await setup(context);
  await cleanedResource(fixture);
  await rememberSession(fixture.runtime, { id: fixture.origin.sessionID, directory: fixture.origin.directory,
    owner: 'homelab', title: 'Original execution', archived: true, time: { created: 1, updated: 1 } });
  const observed = fixture.sessions.get(fixture.origin.sessionID)!;
  observed.time.archived = 1;
  await reverifyOperationalWork(fixture.runtime, 'homelab', fixture.item.id);
  await fixture.deliver();
  assert.equal(fixture.creates(), 1);
  const continuation = (await fixture.receipts())[0].origin;
  assert.notEqual(continuation.sessionID, fixture.origin.sessionID);
  await completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, continuation);
  const receipt = (await fixture.runtime.requests.get(fixture.request.id)).operation!.checkpoint!.operational!;
  assert.deepEqual(receipt.session, fixture.origin);
  assert.deepEqual(receipt.execution, continuation);
  assert.equal(receipt.effects.length, 1);
});

test('failed follow-up cannot be replaced by a model report or absent-resource claim', async context => {
  const fixture = await setup(context);
  const opened = await resource(fixture, 'legacy-follow-up');
  await fixture.runtime.requests.update(opened.id, current => ({ ...current, status: 'deleted',
    instance: { remote: 'minideb', name: 'onionsoup-test' }, leaseIncludesDelete: true,
    approvals: [{ step: 'create', by: 'person', at: current.createdAt }],
    followUpResult: { ok: false, summary: 'Owner later claims success', at: current.createdAt },
    operation: { id: 'host-operation', stage: 'delete-approved', startedAt: current.createdAt,
      checkpoint: { instance: { remote: 'minideb', name: 'onionsoup-test', image } } },
  }));
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_follow_up_not_verified/);
  assert.equal((await fixture.runtime.requests.get(fixture.request.id)).status, 'work-running');
  assert.equal(fixture.prompts.length, 0);
});

test('legacy landed work with only an owner report queues one concrete continuation, never attention or completion', async context => {
  const fixture = await setup(context);
  await fixture.runtime.ledger.update(fixture.item.id, current => ({ ...current, status: 'landed', reason: 'The owner says everything is done' }));
  const request = await fixture.runtime.requests.get(fixture.request.id);
  await trackDelegatedWork(fixture.runtime, request);
  await trackDelegatedWork(fixture.runtime, request);
  const notices = await pendingNotices(fixture.runtime);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].change, 'operational-reverify');
  assert.match(notices[0].text, /managed request identity/);
  assert.equal((await fixture.runtime.requests.get(request.id)).status, 'work-running');
  assert.equal(fixture.prompts.length, 0);
});

test('interrupted pre-receipt verification becomes a concrete owner reverify continuation without replaying effects', async context => {
  const fixture = await setup(context);
  await fixture.runtime.requests.update(fixture.request.id, current => ({
    ...current, operation: { id: 'interrupted-host-verification', stage: 'work-running',
      startedAt: current.createdAt, runner: 999999, checkpoint: { operationalOrigin: fixture.origin } },
  }));
  await recoverRequests(fixture.runtime, (_id, error) => { throw error; });
  await recoverRequests(fixture.runtime, (_id, error) => { throw error; });
  const request = await fixture.runtime.requests.get(fixture.request.id);
  assert.equal(request.status, 'work-running');
  assert.equal(request.operation?.runner, undefined);
  const notices = await pendingNotices(fixture.runtime);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].change, 'operational-reverify');
  assert.match(notices[0].text, /operational_verification_interrupted/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.prompts.length, 0);
});

test('a source or original approval change during the final review never commits a completion receipt', async context => {
  const fixture = await setup(context);
  await cleanedResource(fixture);
  fixture.onReview(async () => {
    await fixture.runtime.ledger.update(fixture.item.id, current => ({
      ...current, planApproval: { ...current.planApproval!, by: 'different-approval' },
    }));
  });
  await assert.rejects(completeOperationalWork(fixture.runtime, 'homelab', fixture.item.id, fixture.origin),
    /operational_completion_binding_mismatch/);
  assert.equal((await fixture.runtime.requests.get(fixture.request.id)).operation?.checkpoint?.operational, undefined);
});
