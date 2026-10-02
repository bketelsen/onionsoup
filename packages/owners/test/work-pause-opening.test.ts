import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Runtime, humanWorkActor, pauseItem, resumeItem, settleItemPause, workPauseClient } from '@onionsoup/owners';
import { openOwnerSession, neededSession, OWNER_SESSIONS, type OwnerSessionClient } from '../src/owner-sessions.ts';
import { SessionOpeningStore } from '../src/session-opening-store.ts';
import { cancelItem } from '../src/work-recovery.ts';
import { pausedSessionItem } from '../src/work-pause.ts';
import { pendingNotices } from '../src/notices.ts';
import type { MaintenanceContext } from '../src/maintenance-context.ts';
import { git, refreshCheckout } from '../src/workspace.ts';

const proposal = {
  title: 'Original planning work', goal: 'Complete the original request', rationale: 'Regression',
  acceptance: ['Original criteria'], size: 'small' as const,
};

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(process.cwd(), '.pause-opening-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: join(root, 'state') });
  await runtime.notebook('odrade').ensureJournal();
  const item = await runtime.ledger.create('odrade', 'owner-change', proposal, { status: 'planning' });
  const store = new SessionOpeningStore(runtime.stateDirectory);
  const key = { entity: 'owner-item' as const, id: item.id, owner: item.owner, kind: 'planning' as const };
  const calls = { creates: 0, prompts: 0 };
  const client: OwnerSessionClient = {
    create: async () => { calls.creates++; return 'ses_exact_created'; },
    prompt: async () => { calls.prompts++; },
    remove: async () => { throw new Error('must_not_delete_created_session'); },
    activity: async () => ({ isBusy: false, updatedAt: 1 }),
  };
  return { runtime, root, item, store, key, calls, client };
}

function lifecycle(beforePhase: (name: string) => Promise<void>): MaintenanceContext {
  const controller = new AbortController();
  return {
    signal: controller.signal, check: () => controller.signal.throwIfAborted(),
    phase: async (name, operation) => {
      await beforePhase(name);
      return operation();
    },
  };
}

async function executionFixture(context: TestContext) {
  const setup = await fixture(context);
  const remote = join(setup.root, 'origin.git');
  const seed = join(setup.root, 'seed');
  await mkdir(remote);
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  await git(setup.root, ['clone', '-q', remote, seed]);
  await writeFile(join(seed, 'base'), 'original base\n');
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Base']);
  await git(seed, ['push', '-q', 'origin', 'main']);
  const declared = setup.runtime.owner('clippy');
  setup.runtime.declarations.owners.set('clippy', {
    ...declared, workspace: join(setup.root, 'checkout'),
    domain: { kind: 'git-repository', name: 'example/clippy', remote, baseBranch: 'main', verify: [] },
  });
  await refreshCheckout(setup.runtime.repositoryOwner('clippy'));
  await setup.runtime.notebook('clippy').ensureJournal();
  const item = await setup.runtime.ledger.create('clippy', 'owner-change', proposal, {
    status: 'working', planDocument: { markdown: 'Original approved plan', digest: 'approved-plan' },
    planApproval: { by: 'original-human', at: '2026-10-01T00:00:00Z' },
  });
  const key = { entity: 'owner-item' as const, id: item.id, owner: item.owner, kind: 'execution' as const };
  return { ...setup, item, key };
}

test('pause after reservation but before create proves no create and permits same-stage resume and opening', async context => {
  const fixtureState = await fixture(context);
  const { runtime, item, client, store, key, calls } = fixtureState;
  const contextState = lifecycle(async name => {
    if (name === 'session-create') await pauseItem(runtime, item.id, humanWorkActor(), 'Fence before SDK create');
  });
  await assert.rejects(openOwnerSession(runtime, client, item.id, contextState), /work_item_paused/);
  const blocked = await store.read(key);
  assert.equal(blocked?.phase, 'blocked');
  assert.equal(blocked?.disposition, 'not-created');
  assert.equal(blocked?.origin, undefined);
  assert.deepEqual(calls, { creates: 0, prompts: 0 });
  assert.equal((await settleItemPause(runtime, item.id)).status, 'paused');
  const resumed = await resumeItem(runtime, item.id, humanWorkActor());
  assert.equal(resumed.status, 'planning');
  assert.deepEqual(resumed.proposal, item.proposal);
  assert.equal(neededSession(resumed), 'planning');
  await assert.rejects(openOwnerSession(runtime, client, item.id, lifecycle(async name => {
    if (name === 'chat-place') throw new Error('later_placement_failure');
  })), /later_placement_failure/);
  const failedRetry = await store.read(key);
  assert.equal(failedRetry?.disposition, 'not-created');
  assert.notEqual(failedRetry?.token, blocked?.token);
  assert.deepEqual(failedRetry?.history.slice(0, blocked?.history.length), blocked?.history);
  await openOwnerSession(runtime, client, item.id);
  const opened = await store.read(key);
  assert.equal(opened?.phase, 'opened');
  assert.notEqual(opened?.token, blocked?.token);
  assert.notEqual(opened?.token, failedRetry?.token);
  assert.deepEqual(opened?.history.slice(0, blocked?.history.length), blocked?.history);
  assert.deepEqual(calls, { creates: 1, prompts: 1 });
});

for (const checkpoint of ['create-response', 'before-prompt'] as const) {
  for (const action of ['resume', 'cancel'] as const) {
    test(`pause at ${checkpoint} retains exact unprompted identity and allows confirmed ${action}`, async context => {
      const { runtime, item, client, store, key, calls } = await fixture(context);
      if (checkpoint === 'create-response') {
        client.create = async () => {
          calls.creates++;
          await pauseItem(runtime, item.id, humanWorkActor(), 'Pause while SDK create returns');
          return 'ses_exact_created';
        };
      }
      const contextState = checkpoint === 'before-prompt' ? lifecycle(async name => {
        if (name === 'session-prompt') await pauseItem(runtime, item.id, humanWorkActor(), 'Pause the claimed session before prompt');
      }) : undefined;
      await assert.rejects(openOwnerSession(runtime, client, item.id, contextState), /work_item_paused/);
      const blocked = await store.read(key);
      assert.equal(blocked?.phase, 'blocked');
      assert.equal(blocked?.disposition, 'not-prompted');
      assert.equal(blocked?.origin?.sessionID, 'ses_exact_created');
      assert.equal(blocked?.history.some(entry => entry.phase === 'uncertain'), false);
      const claimed = await runtime.ledger.get(item.id);
      assert.equal(claimed.status, 'pausing');
      assert.deepEqual(claimed.origin, blocked?.origin);
      assert.deepEqual(claimed.proposal, item.proposal);
      assert.deepEqual(calls, { creates: 1, prompts: 0 });
      assert.equal((await pausedSessionItem(runtime, 'ses_exact_created'))?.id, item.id);
      await assert.rejects(cancelItem(runtime, item.id, 'person', 'Not yet stopped'), /stop_unconfirmed/);
      const receiptBeforeStop = await readFile(store.path(key), 'utf8');
      const aborted: string[] = [];
      let isBusy = true;
      const stop = workPauseClient({
        sessions: async () => [{ id: 'ses_exact_created' }],
        statuses: async () => isBusy ? { ses_exact_created: { type: 'busy' } } : {},
        abort: async (_directory, id) => { aborted.push(id); isBusy = false; },
      });
      const paused = await settleItemPause(runtime, item.id, stop);
      assert.equal(paused.status, 'paused');
      assert.equal(paused.pauses.at(-1)?.resumeStatus, 'planning');
      assert.deepEqual(aborted, ['ses_exact_created']);
      assert.equal(await readFile(store.path(key), 'utf8'), receiptBeforeStop);
      if (action === 'cancel') {
        assert.equal((await cancelItem(runtime, item.id, 'person', 'Stop this work')).status, 'cancelled');
      } else {
        const resumed = await resumeItem(runtime, item.id, humanWorkActor());
        assert.equal(resumed.status, 'planning');
        assert.deepEqual(resumed.proposal, item.proposal);
        assert.deepEqual(resumed.origin, blocked?.origin);
        assert.equal(await openOwnerSession(runtime, client, item.id), undefined);
        const notices = await pendingNotices(runtime);
        assert.equal(notices.length, 1);
        assert.deepEqual(notices[0]?.origin, blocked?.origin);
        assert.match(notices[0]!.text, /ORIGINAL work/);
        assert.ok(notices[0]!.text.endsWith(OWNER_SESSIONS.planning.prompt(resumed)));
        assert.equal(await pausedSessionItem(runtime, 'ses_exact_created'), undefined);
        assert.deepEqual(calls, { creates: 1, prompts: 0 });
      }
    });
  }
}

test('a pause preserves a truly possibly-prompted opening without interpreting idle as rejected delivery', async context => {
  const { runtime, item, client, store, key, calls } = await fixture(context);
  client.prompt = async () => {
    calls.prompts++;
    await pauseItem(runtime, item.id, humanWorkActor(), 'Pause after prompt admission');
    throw new Error('prompt_response_lost');
  };
  await assert.rejects(openOwnerSession(runtime, client, item.id), /prompt_response_lost/);
  const uncertain = await readFile(store.path(key), 'utf8');
  assert.equal((await store.read(key))?.phase, 'uncertain');
  assert.equal((await store.read(key))?.disposition, undefined);
  assert.equal((await settleItemPause(runtime, item.id, {
    stop: async () => { throw new Error('uncertain_prompt_must_not_be_reinterpreted'); },
  })).status, 'pausing');
  await assert.rejects(resumeItem(runtime, item.id, humanWorkActor()), /work_not_paused/);
  await assert.rejects(cancelItem(runtime, item.id, 'person', 'Cannot prove stopped'), /stop_unconfirmed/);
  assert.equal(await openOwnerSession(runtime, client, item.id), undefined);
  assert.equal(await readFile(store.path(key), 'utf8'), uncertain);
  assert.deepEqual(calls, { creates: 1, prompts: 1 });
});

test('a pause racing approved execution creation retains its session and resumes the identical approval and worktree', async context => {
  const { runtime, item, client, calls, store, key } = await executionFixture(context);
  client.create = async () => {
    calls.creates++;
    await pauseItem(runtime, item.id, humanWorkActor(), 'Pause the approved execution being created');
    return 'ses_approved_created';
  };
  await assert.rejects(openOwnerSession(runtime, client, item.id), /work_item_paused/);
  const opening = await store.read(key);
  assert.equal(opening?.disposition, 'not-prompted');
  const claimed = await runtime.ledger.get(item.id);
  assert.equal(claimed.status, 'pausing');
  assert.deepEqual(claimed.session, opening?.origin);
  assert.equal(claimed.session?.directory, claimed.planWorktree);
  assert.equal((await settleItemPause(runtime, item.id, { stop: async target => {
    assert.deepEqual(target, opening?.origin);
    return true;
  } })).status, 'paused');
  const resumed = await resumeItem(runtime, item.id, humanWorkActor());
  assert.equal(resumed.status, 'working');
  assert.deepEqual(resumed.proposal, item.proposal);
  assert.deepEqual(resumed.planDocument, item.planDocument);
  assert.deepEqual(resumed.planApproval, item.planApproval);
  assert.deepEqual(resumed.session, claimed.session);
  assert.equal(resumed.planWorktree, claimed.planWorktree);
  assert.equal(resumed.planWorktreeGeneration, claimed.planWorktreeGeneration);
  assert.equal(await openOwnerSession(runtime, client, item.id), undefined);
  assert.deepEqual(calls, { creates: 1, prompts: 0 });
  assert.deepEqual((await pendingNotices(runtime))[0]?.origin, claimed.session);
  assert.ok((await pendingNotices(runtime))[0]!.text.endsWith(OWNER_SESSIONS.execution.prompt(resumed)));
});
