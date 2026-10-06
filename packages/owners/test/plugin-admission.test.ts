import { childStore } from './fixtures/child-recovery.ts';
import { childRecoverySnapshot, recordChildAbandonment } from '../src/child-recovery.ts';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { armDeployment, beginDrain, listAdmissions } from '../src/deployment-admission.ts';
import { MEMORY_NUDGE_TEXT } from '../src/operator-memory.ts';
import { withActiveHooks } from './active-hooks.ts';
import { Runtime, humanWorkActor, pauseItem, settleItemPause } from '@onionsoup/owners';
import { submitPlan } from '../src/plan-work.ts';

type TimerCallback = () => Promise<unknown>;

async function setup(operator = false) {
  const declarations = await mkdtemp(join(tmpdir(), 'plugin-admission-config-'));
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  if (operator) await writeFile(join(declarations, 'operator.yaml'), 'model: github-copilot/gpt-6-sol\n');
  const state = await mkdtemp(join(tmpdir(), 'plugin-admission-state-'));
  const statuses: Record<string, { type: string }> = {};
  const children: Record<string, string[]> = {};
  let requireScopedChildren = false;
  let requireScopedStatus = false;
  const messages: Record<string, unknown[]> = {};
  let nextMessageID = 0;
  const statusDirectories: string[] = [];
  const messageErrors = new Set<string>();
  let failMessages = false;
  let pauseMessages = false;
  let pauseFinalChatMessages = false;
  let chatMessageReads = 0;
  let pauseFinalChildMessages = false;
  let childMessageReads = 0;
  let messagesStarted: (() => void) | undefined;
  let resumeMessages: (() => void) | undefined;
  const messagesStart = new Promise<void>(resolve => { messagesStarted = resolve; });
  const timers: TimerCallback[] = [];
  const originalInterval = globalThis.setInterval;
  let failWatcher = false;
  let failSessionLookup = false;
  let failStatusLookup = false;
  let malformedStatus = false;
  let runWatcher = false;
  let watcherFirstMessage = false;
  let watcherDeleted = false;
  let sayWatcher: (() => Promise<unknown>) | undefined;
  let childStatusStarted: (() => void) | undefined;
  let releaseChildStatus: (() => void) | undefined;
  let pauseChildStatus = false;
  let pauseChildLookup = false;
  const childStatusStart = new Promise<void>(resolve => { childStatusStarted = resolve; });
  let releasePrompt: (() => void) | undefined;
  let generatedNudgeID: string | undefined;
  let deliverNudgeThroughHook = false;
  let promptStarted: (() => void) | undefined;
  const promptStart = new Promise<void>(resolve => { promptStarted = resolve; });
  const client = { session: {
    status: async ({ query }: { query?: { directory?: string } } = {}) => {
      statusDirectories.push(query?.directory ?? '');
      if (pauseChildStatus) {
        pauseChildStatus = false;
        childStatusStarted?.();
        await new Promise<void>(resolve => { releaseChildStatus = resolve; });
      }
      if (failStatusLookup) return { error: new Error('status unavailable') };
      if (malformedStatus) return { data: { parent: { type: 123 } } };
      return { data: requireScopedStatus && !query?.directory ? {} : Object.fromEntries(
        Object.entries(statuses).filter(([, status]) => status.type !== 'idle')) };
    },
    children: async ({ path, query }: { path: { id: string }; query?: { directory?: string } }) => ({ data: requireScopedChildren && !query?.directory ? [] : (children[path.id] ?? []).map(id => ({ id })) }),
    get: async ({ path }: { path: { id: string } }) => {
      if (path.id === 'child' && pauseChildLookup) {
        pauseChildLookup = false;
        childStatusStarted?.();
        await new Promise<void>(resolve => { releaseChildStatus = resolve; });
      }
      return failSessionLookup
        ? { error: new Error('session unavailable') }
        : { data: { id: path.id, directory: '/chats', parentID: Object.entries(children).find(([, ids]) => ids.includes(path.id))?.[0] ?? (['child', 'watcher'].includes(path.id) ? 'parent' : undefined) } };
    },
    messages: async ({ path }: { path: { id: string } }) => {
      if (['chat', 'parent'].includes(path.id) && ++chatMessageReads === 4 && pauseFinalChatMessages) {
        const snapshot = messages[path.id];
        messagesStarted?.();
        await new Promise<void>(resolve => { resumeMessages = resolve; });
        return { data: snapshot };
      }
      if (path.id === 'child' && ++childMessageReads === 2 && pauseFinalChildMessages) {
        const snapshot = messages.child;
        messagesStarted?.();
        await new Promise<void>(resolve => { resumeMessages = resolve; });
        return { data: snapshot };
      }
      if (pauseMessages) {
        pauseMessages = false;
        messagesStarted?.();
        await new Promise<void>(resolve => { resumeMessages = resolve; });
      }
      if (messageErrors.has(path.id)) return { error: { name: 'BadRequest', data: { message: 'Expected OutputFormatJsonSchema' } } };
      if (failMessages) throw new Error('messages unavailable');
      if (failWatcher && !messages[path.id]) throw new Error('watcher unavailable');
      if (messages[path.id]) return { data: messages[path.id] };
      if (runWatcher) return { data: [{ info: { id: 'person-message', role: 'user' }, parts: [{ type: 'text', text: 'Hello' }] }] };
      return { data: [] };
    },
    create: async () => {
      children.parent = [...(children.parent ?? []), 'watcher'];
      if (!watcherFirstMessage) statuses.watcher = { type: 'busy' };
      return { data: { id: 'watcher' } };
    },
    prompt: async () => {
      if (watcherFirstMessage) await sayWatcher?.();
      return { data: { info: {}, parts: [{ type: 'text', text: '{"records":[]}' }] } };
    },
    delete: async () => {
      children.parent = (children.parent ?? []).filter(id => id !== 'watcher');
      delete statuses.watcher;
      watcherDeleted = true;
      return { data: true };
    },
    promptAsync: async ({ body }: { body: { messageID?: string } }) => {
      generatedNudgeID = body.messageID;
      promptStarted?.();
      await new Promise<void>(resolve => { releasePrompt = resolve; });
      if (deliverNudgeThroughHook) {
        await hooks['chat.message']!({ sessionID: 'operator', agent: 'Operator', messageID: body.messageID }, {
          message: { id: body.messageID, role: 'user', sessionID: 'operator' },
          parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }],
        } as never);
      }
      messages.operator = [...(messages.operator ?? []), {
        info: { id: body.messageID ?? 'nudge', role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }],
      }];
      return { data: {} };
    },
  } };
  let hooks: Awaited<ReturnType<typeof withActiveHooks>>;
  try {
    globalThis.setInterval = ((callback: TimerCallback) => {
      timers.push(callback);
      return { unref() {} } as NodeJS.Timeout;
    }) as typeof setInterval;
    hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  } finally {
    globalThis.setInterval = originalInterval;
  }
  const say = (sessionID: string, agent = 'Miles Teg', text = 'Hello') => {
    const id = ++nextMessageID === 1 ? 'user' : `user-${nextMessageID}`;
    const admitted = hooks['chat.message']!({ sessionID, agent, messageID: id }, {
      message: { id, role: 'user', sessionID }, parts: [{ type: 'text', text }],
    } as never);
    return admitted.then(() => {
      messages[sessionID] = [...(messages[sessionID] ?? []),
        { info: { id, role: 'user' }, parts: [{ type: 'text', text }] },
        { info: { id: `final-${id}`, role: 'assistant', parentID: id, time: { completed: 2 }, finish: 'stop' }, parts: [] }];
    });
  };
  const sayWithoutMarker = (sessionID: string) => hooks['chat.message']!({ sessionID, agent: 'Miles Teg' }, {
    message: { role: 'user', sessionID }, parts: [{ type: 'text', text: 'Hello' }],
  } as never);
  sayWatcher = () => say('watcher', 'onionsoup-watcher');
  const idle = (sessionID: string) => {
    if (sessionID === 'child' && !messages.child) {
      messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }, finishedFor('child-user')];
    }
    return hooks.event!({ event: { type: 'session.idle', properties: { sessionID } } as never });
  };
  return {
    hooks, state, declarations, statuses, children, messages, statusDirectories, say, sayWithoutMarker, idle, promptStart, childStatusStart, messagesStart,
    requireScopedChildren: () => { requireScopedChildren = true; },
    requireScopedStatus: () => { requireScopedStatus = true; },
    reconcile: async () => { for (const tick of timers.slice(1)) await tick(); },
    failMessagesFor: (id: string) => { messageErrors.add(id); },
    failMessages: () => { failMessages = true; },
    pauseNextMessages: () => { pauseMessages = true; },
    pauseFinalChatMessages: () => { pauseFinalChatMessages = true; },
    pauseFinalChildMessages: () => { pauseFinalChildMessages = true; },
    resumeMessages: () => resumeMessages?.(),
    pauseNextStatus: () => { pauseChildStatus = true; },
    pauseNextChildLookup: () => { pauseChildLookup = true; },
    resumeChildStatus: () => releaseChildStatus?.(),
    failWatcher: () => { failWatcher = true; },
    failSessionLookup: () => { failSessionLookup = true; },
    failStatusLookup: () => { failStatusLookup = true; },
    malformedStatus: () => { malformedStatus = true; },
    runWatcher: () => { runWatcher = true; },
    watcherFirstMessage: () => { watcherFirstMessage = true; },
    watcherDeleted: () => watcherDeleted,
    releasePrompt: () => releasePrompt?.(),
    nudgeID: () => generatedNudgeID,
    deliverNudge: () => hooks['chat.message']!({ sessionID: 'operator', agent: 'Operator', messageID: generatedNudgeID }, {
      message: { id: generatedNudgeID, role: 'user', sessionID: 'operator' },
      parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }],
    } as never),
    deliverNudgeThroughHook: () => { deliverNudgeThroughHook = true; },
  };
}

test('chat admission blocks drain until idle and refuses new messages once draining', async () => {
  const { state, say, idle } = await setup();
  await say('chat');
  assert.equal((await listAdmissions(state)).length, 1);
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await assert.rejects(say('other'), /deployment_draining/);
  await idle('chat');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('paused work and its SDK-observed descendants cannot admit messages or effect tools', async () => {
  const fixture = await setup();
  const runtime = await Runtime.open({ declarations: fixture.declarations, state: fixture.state });
  const item = await runtime.ledger.create('homelab', 'owner-change', {
    title: 'Original', goal: 'Original goal', rationale: 'r', acceptance: ['a'], size: 'small',
  }, { status: 'working', session: { sessionID: 'parent', directory: '/chats' } });
  await pauseItem(runtime, item.id, humanWorkActor(), 'Human stop');
  await settleItemPause(runtime, item.id, { stop: async () => true });
  fixture.children.parent = ['child'];
  await assert.rejects(fixture.say('parent'), /work_item_paused/);
  await assert.rejects(fixture.say('child', 'onionsoup-implementer'), /work_item_paused/);
  await assert.rejects(fixture.hooks['tool.execute.before']!({
    sessionID: 'child', callID: 'paused-effect', tool: 'bash',
  }, { args: { command: 'echo must-not-run' } }), /work_item_paused/);
  assert.equal((await runtime.ledger.get(item.id)).status, 'paused');
  assert.equal((await listAdmissions(fixture.state)).length, 0);
});

test('pausing a shared-desk submitted plan or publication leaves unrelated desk messages and tools admitted', async () => {
  const fixture = await setup();
  const runtime = await Runtime.open({ declarations: fixture.declarations, state: fixture.state });
  const origin = { sessionID: 'parent', directory: '/chats' };
  const plan = await submitPlan(runtime, 'homelab', {
    title: 'Wait for approval', goal: 'Only this plan pauses', plan: 'The original proposed plan',
  }, origin);
  const publication = await runtime.ledger.create('homelab', 'desk-publication', plan.proposal, {
    status: 'landing', origin,
  });
  for (const item of [plan, publication]) {
    assert.equal((await pauseItem(runtime, item.id, humanWorkActor(), 'Defer this item only')).status, 'paused');
  }
  fixture.children.parent = ['child'];
  await fixture.say('parent');
  await fixture.say('child', 'onionsoup-implementer');
  await fixture.hooks['tool.execute.before']!({
    sessionID: 'child', callID: 'unrelated-desk-effect', tool: 'bash',
  }, { args: { command: 'echo unrelated-work' } });
  assert.ok((await listAdmissions(fixture.state)).length > 0);
  assert.equal((await runtime.ledger.get(plan.id)).status, 'paused');
  assert.equal((await runtime.ledger.get(publication.id)).status, 'paused');
});

test('busy child sessions keep their parent lease past parent idle', async () => {
  const { state, say, idle, children, statuses } = await setup();
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await say('parent');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  statuses.child = { type: 'idle' };
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('failed watcher during drain releases the chat after confirming it is idle', async () => {
  const { state, say, idle, statuses, failWatcher } = await setup();
  await say('parent');
  statuses.parent = { type: 'idle' };
  failWatcher();
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('failed watcher during drain retains the chat while a child is busy', async () => {
  const { state, say, idle, statuses, children, failWatcher } = await setup();
  await say('parent');
  statuses.parent = { type: 'idle' };
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  failWatcher();
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  statuses.child = { type: 'idle' };
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a standalone tool stays admitted until after it finishes', async () => {
  const { state, hooks } = await setup();
  await hooks['tool.execute.before']!({ sessionID: 'standalone', tool: 'bash', callID: 'one' }, { args: {} });
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await hooks['tool.execute.after']!({ sessionID: 'standalone', tool: 'bash', callID: 'one', args: {} }, { title: '', output: '', metadata: {} });
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
  await assert.rejects(hooks['tool.execute.before']!({ sessionID: 'other', tool: 'bash', callID: 'two' }, { args: {} }), /deployment_draining/);
});

test('an already admitted chat cannot start another turn during drain', async () => {
  const { state, say, idle } = await setup();
  await say('chat');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await assert.rejects(say('chat', 'Miles Teg', 'Another turn'), /deployment_draining/);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('chat');
});

test('a second message on an admitted chat rechecks the drain gate', async () => {
  const { state, say, idle } = await setup();
  await say('chat');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await assert.rejects(say('chat', 'Miles Teg', 'Concurrent turn'), /deployment_draining/);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('chat');
});

test('a tool in an admitted turn continues after drain while standalone tools are refused', async () => {
  const { state, hooks, say, idle } = await setup();
  await say('chat');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await hooks['tool.execute.before']!({ sessionID: 'chat', tool: 'bash', callID: 'one' }, { args: {} });
  await hooks['tool.execute.after']!({ sessionID: 'chat', tool: 'bash', callID: 'one', args: {} }, { title: '', output: '', metadata: {} });
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await assert.rejects(hooks['tool.execute.before']!({ sessionID: 'standalone', tool: 'bash', callID: 'two' }, { args: {} }), /deployment_draining/);
  await idle('chat');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child tool continues on its parent chat lease during drain', async () => {
  const { state, hooks, say, idle, statuses, children } = await setup();
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await say('parent');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await hooks['tool.execute.before']!({ sessionID: 'child', tool: 'bash', callID: 'child-tool' }, { args: {} });
  await hooks['tool.execute.after']!({ sessionID: 'child', tool: 'bash', callID: 'child-tool', args: {} }, { title: '', output: '', metadata: {} });
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  statuses.child = { type: 'idle' };
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child message continues on its admitted parent turn during drain, including after parent idle', async () => {
  const { state, say, idle, statuses, children } = await setup();
  children.parent = ['child'];
  statuses.parent = { type: 'idle' };
  statuses.child = { type: 'busy' };
  await say('parent');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await say('child', 'onionsoup-implementer', 'Continue the parent turn');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  statuses.child = { type: 'idle' };
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('an enumerated child without status retains the parent through drain until its first message and completion', async () => {
  const { state, say, idle, statuses, children } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.parent = { type: 'idle' };
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await say('child', 'onionsoup-implementer', 'Start the parent turn');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child first message joins without status and retains the parent through interleaved idle and drain', async () => {
  const { state, say, idle, statuses, children } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.parent = { type: 'idle' };
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await say('child', 'onionsoup-implementer');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child first message without status cannot lose a race with parent idle', async () => {
  const { state, say, idle, statuses, children, childStatusStart, pauseNextStatus, resumeChildStatus } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.parent = { type: 'idle' };
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await say('child', 'onionsoup-implementer');
  pauseNextStatus();
  const parentIdle = idle('parent');
  await childStatusStart;
  const childIdle = idle('child');
  await new Promise(resolve => setImmediate(resolve));
  resumeChildStatus();
  await parentIdle;
  await childIdle;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child reporting idle before it runs remains pending until its idle event', async () => {
  const { state, say, idle, statuses, children } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.child = { type: 'idle' };
  await say('child', 'onionsoup-implementer');
  statuses.parent = { type: 'idle' };
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child never started remains admitted rather than treating missing status as completion', async () => {
  const { state, say, idle, statuses, children } = await setup();
  await say('parent');
  children.parent = ['child'];
  await say('child', 'onionsoup-implementer');
  statuses.parent = { type: 'idle' };
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a joined child omitted from a successful status response releases the parent after its idle event', async () => {
  const { state, say, idle, statuses, children } = await setup();
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await say('parent');
  await say('child', 'onionsoup-implementer');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  delete statuses.child;
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a deleted decision watcher no longer holds the parent after its watch finishes', async () => {
  const { state, say, idle, runWatcher, watcherDeleted } = await setup();
  runWatcher();
  await say('parent');
  await idle('parent');
  assert.equal(watcherDeleted(), true);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a decision watcher first message joins without status and its deletion completes the parent', async () => {
  const { state, say, idle, runWatcher, watcherFirstMessage, watcherDeleted } = await setup();
  runWatcher();
  watcherFirstMessage();
  await say('parent');
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await idle('parent');
  assert.equal(watcherDeleted(), true);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('an invalid status response does not release a joined child or its parent', async () => {
  const { state, say, idle, statuses, children, malformedStatus } = await setup();
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await say('parent');
  await say('child', 'onionsoup-implementer');
  await idle('parent');
  delete statuses.child;
  malformedStatus();
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a failed status lookup does not treat a missing joined child as idle', async () => {
  const { state, say, idle, statuses, children, failStatusLookup } = await setup();
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await say('parent');
  await say('child', 'onionsoup-implementer');
  await idle('parent');
  delete statuses.child;
  failStatusLookup();
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a child joining during parent idle retains the admission through drain until child idle', async () => {
  const { state, say, idle, statuses, children, childStatusStart, pauseNextChildLookup, resumeChildStatus } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.parent = { type: 'idle' };
  statuses.child = { type: 'busy' };
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  pauseNextChildLookup();
  const joining = say('child', 'onionsoup-implementer');
  await childStatusStart;
  const parentIdle = idle('parent');
  await new Promise(resolve => setImmediate(resolve));
  resumeChildStatus();
  await joining;
  await parentIdle;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await assert.rejects(say('standalone'), /deployment_draining/);
  statuses.child = { type: 'idle' };
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a standalone child message cannot start an independent turn', async () => {
  const { state, say } = await setup();
  await assert.rejects(say('child', 'onionsoup-implementer'), /deployment_chat_parent_not_admitted/);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child message refuses unknown ancestry without claiming a lease', async () => {
  const ancestry = await setup();
  await ancestry.say('parent');
  ancestry.statuses.child = { type: 'busy' };
  ancestry.failSessionLookup();
  await assert.rejects(ancestry.say('child', 'onionsoup-implementer'), /deployment_chat_ancestry_unknown/);
  assert.equal((await listAdmissions(ancestry.state)).filter(lease => lease.alive).length, 1);

});

test('a child without a known busy status joins but a missing status cannot complete it', async () => {
  const { state, say, idle, statuses } = await setup();
  await say('parent');
  await say('child', 'onionsoup-implementer');
  statuses.parent = { type: 'idle' };
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('operator memory nudge keeps the lease through its answering turn', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, messages, nudgeID } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-1', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length > 0, true);
  releasePrompt();
  await finishing;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length > 0, true);
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: nudgeID(), role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }] }, finishedFor(nudgeID()!)];
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('only the pending plugin memory nudge continues an operator chat during drain', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, deliverNudgeThroughHook, messages } = await setup(true);
  deliverNudgeThroughHook();
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-drain', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  await assert.rejects(say('operator', 'Operator', 'Another turn'), /deployment_draining/);
  await assert.rejects(say('operator', 'Operator', MEMORY_NUDGE_TEXT), /deployment_draining/);
  releasePrompt();
  await finishing;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await assert.rejects(say('operator', 'Operator', MEMORY_NUDGE_TEXT), /deployment_draining/);
  messages.operator = [...messages.operator, finishedFor((messages.operator.at(-1) as { info: { id: string } }).info.id)];
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a 204 prompt acknowledgement before its nudge hook retains admission through drain', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, deliverNudge, nudgeID, messages } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-late-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  releasePrompt();
  await finishing;
  await deliverNudge();
  messages.operator = [...messages.operator, finishedFor(nudgeID()!)];
  await idle('operator');
  assert.equal(messages.operator.some(message => (message as { info: { id: string } }).info.id === nudgeID()), true);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('matching nudge text under a different ID cannot prove the generated nudge was answered', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, messages, nudgeID } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-false-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  releasePrompt();
  await finishing;
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: 'impostor', role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }] }, finished];
  assert.notEqual(nudgeID(), 'impostor');
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

  const finishedFor = (parentID: string) => ({
    info: { id: `assistant-final-${parentID}`, role: 'assistant', parentID, time: { created: 1, completed: 2 }, finish: 'stop' },
    parts: [],
  });
  const finished = finishedFor('user');

test('periodic reconciliation releases a missed idle only after a completed final assistant message', async () => {
  const { state, say, statuses, messages, reconcile, statusDirectories } = await setup();
  await say('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
  assert.ok(statusDirectories.includes('/chats'));
});

test('a stopped assistant belonging to an older turn cannot release an admitted chat', async () => {
  const { state, say, idle, reconcile, messages } = await setup();
  await say('chat');
  messages.chat = [
    { info: { id: 'older', role: 'user' }, parts: [] },
    { info: { id: 'user', role: 'user' }, parts: [] },
    { info: { id: 'older-final', role: 'assistant', parentID: 'older', time: { completed: 2 }, finish: 'stop' }, parts: [] },
  ];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await idle('chat');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a stopped assistant belonging to the original turn cannot answer the nudge', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, messages, nudgeID } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'nudge-edit', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  releasePrompt();
  await finishing;
  messages.operator = [
    { info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: nudgeID(), role: 'user' }, parts: [] }, finished,
  ];
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a child final with no user or with the wrong parent retains the parent lease', async () => {
  const { state, say, children, messages, reconcile } = await setup();
  await say('parent');
  children.parent = ['child'];
  messages.child = [finishedFor('missing-user')];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.child = [
    { info: { id: 'child-user', role: 'user' }, parts: [] },
    finishedFor('other-user'),
  ];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.child = [messages.child[0], finishedFor('child-user')];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('real status shape omits idle sessions and reconciles only with a scoped completed answer', async () => {
  const { state, say, statuses, messages, reconcile, statusDirectories, requireScopedStatus } = await setup();
  requireScopedStatus();
  await say('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
  assert.ok(statusDirectories.every(directory => directory === '/chats'));
});

test('idle event retains a parent while a scoped child is busy and an unscoped lookup omits it', async () => {
  const { state, say, idle, statuses, children, requireScopedChildren, requireScopedStatus } = await setup();
  requireScopedChildren();
  requireScopedStatus();
  await say('parent');
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  delete statuses.child;
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a missed nudge-answer idle releases only after the nudge user message has a final answer', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, reconcile, messages, nudgeID } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  releasePrompt();
  await finishing;
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: nudgeID(), role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }] }];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.operator = [...messages.operator, finishedFor(nudgeID()!)];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a nudge answering message without a busy event can reconcile its completed reply', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, reconcile, messages, nudgeID, deliverNudge } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  releasePrompt();
  await finishing;
  await deliverNudge();
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: nudgeID(), role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }] }, finishedFor(nudgeID()!)];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a premature idle during the nudge answer cannot release without that answers final', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, messages } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  releasePrompt();
  await finishing;
  await say('operator', 'Operator', MEMORY_NUDGE_TEXT);
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: 'user-2', role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }] }];
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('periodic reconciliation retains a chat without final proof, including an absent status', async () => {
  const { state, say, statuses, messages, reconcile, failMessages } = await setup();
  await say('chat');
  messages.chat = [{ info: { id: 'assistant', role: 'assistant', time: { created: 1 } }, parts: [] }];
  await reconcile();
  statuses.chat = { type: 'idle' };
  await reconcile();
  messages.chat = [finished, { info: { id: 'new-user', role: 'user' }, parts: [] }];
  await reconcile();
  messages.chat = [finished];
  failMessages();
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('periodic reconciliation retains a parent with an unproved child', async () => {
  const { state, say, statuses, children, messages, reconcile } = await setup();
  await say('parent');
  statuses.parent = { type: 'idle' };
  children.parent = ['child'];
  messages.parent = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('periodic reconciliation releases a parent after its child has a completed final answer', async () => {
  const { state, say, statuses, children, messages, reconcile } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.parent = { type: 'idle' };
  statuses.child = { type: 'idle' };
  messages.parent = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }, finishedFor('child-user')];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('periodic reconciliation retains a turn while its tool is in flight', async () => {
  const { state, hooks, say, statuses, messages, reconcile } = await setup();
  await say('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await hooks['tool.execute.before']!({ sessionID: 'chat', tool: 'bash', callID: 'one' }, { args: {} });
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await hooks['tool.execute.after']!({ sessionID: 'chat', tool: 'bash', callID: 'one', args: {} }, { title: '', output: '', metadata: {} });
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('periodic reconciliation retains a chat until all concurrent tools finish', async () => {
  const { state, hooks, say, statuses, messages, reconcile } = await setup();
  await say('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  for (const callID of ['one', 'two']) {
    await hooks['tool.execute.before']!({ sessionID: 'chat', tool: 'bash', callID }, { args: {} });
  }
  await hooks['tool.execute.after']!({ sessionID: 'chat', tool: 'bash', callID: 'one', args: {} }, { title: '', output: '', metadata: {} });
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  await hooks['tool.execute.after']!({ sessionID: 'chat', tool: 'bash', callID: 'two', args: {} }, { title: '', output: '', metadata: {} });
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a new message during reconciliation invalidates its earlier completion proof', async () => {
  const { state, say, statuses, messages, reconcile, pauseNextMessages, messagesStart, resumeMessages } = await setup();
  await say('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [finished];
  pauseNextMessages();
  const checking = reconcile();
  await messagesStart;
  const newTurn = say('chat', 'Miles Teg', 'Another turn');
  resumeMessages();
  await newTurn;
  await checking;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a message starting during the final idle transcript read keeps the existing chat lease', async () => {
  const { state, say, idle, pauseFinalChatMessages, messagesStart, resumeMessages } = await setup();
  await say('chat');
  const [original] = await listAdmissions(state);
  pauseFinalChatMessages();
  const finishing = idle('chat');
  await messagesStart;
  const newTurn = say('chat', 'Miles Teg', 'Another turn');
  resumeMessages();
  await finishing;
  await newTurn;
  const alive = (await listAdmissions(state)).filter(lease => lease.alive);
  assert.deepEqual(alive.map(lease => lease.id), [original!.id]);
  await idle('chat');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a prior turn final cannot reconcile an admitted message before its user record is persisted', async () => {
  const { state, say, statuses, messages, reconcile } = await setup();
  await say('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [{ info: { id: 'prior-user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.chat = [...messages.chat, { info: { id: 'user', role: 'user' }, parts: [] },
    { info: { id: 'fresh-final', role: 'assistant', parentID: 'user', time: { completed: 3 }, finish: 'stop' }, parts: [] }];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('an idle event delayed in child ancestry cannot finish a newer admitted turn', async () => {
  const { state, say, idle, statuses, children, messages, pauseNextChildLookup, childStatusStart, resumeChildStatus } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  messages.parent = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  pauseNextChildLookup();
  const oldIdle = idle('child');
  await childStatusStart;
  await say('parent', 'Miles Teg', 'New turn');
  delete statuses.child;
  messages.parent = [...messages.parent, { info: { id: 'user-2', role: 'user' }, parts: [] }, finished];
  resumeChildStatus();
  await oldIdle;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('an old child idle after its new message cannot clear pending completion or reuse its prior final', async () => {
  const { state, say, idle, statuses, children, messages, pauseNextChildLookup, childStatusStart, resumeChildStatus } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.child = { type: 'busy' };
  await say('child', 'onionsoup-implementer', 'First child turn');
  pauseNextChildLookup();
  const oldIdle = idle('child');
  await childStatusStart;
  await say('child', 'onionsoup-implementer', 'New child turn');
  messages.child = [
    { info: { id: 'user-2', role: 'user' }, parts: [] }, finished,
    { info: { id: 'user-3', role: 'user' }, parts: [] },
  ];
  delete statuses.child;
  resumeChildStatus();
  await oldIdle;
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.child = [...messages.child, finishedFor('user-3')];
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('ordinary idle retains the lease until the admitted user has a completed final', async () => {
  const { state, say, idle, messages } = await setup();
  await say('chat');
  messages.chat = [{ info: { id: 'older', role: 'user' }, parts: [] }, finished];
  await idle('chat');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.chat = [...messages.chat, { info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await idle('chat');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('an arbitrary reply after a pending nudge cannot release the lease', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, messages } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  releasePrompt();
  await finishing;
  await say('operator', 'Operator', 'Unrelated reply');
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: 'user-2', role: 'user' }, parts: [{ type: 'text', text: 'Unrelated reply' }] }, finished];
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a later arbitrary reply cannot stand in for the persisted nudge answer', async () => {
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt, messages } = await setup(true);
  await say('operator', 'Operator', 'Change the owner configuration');
  await hooks.event!({ event: { type: 'message.part.updated', properties: { part: {
    id: 'edit-nudge', sessionID: 'operator', type: 'tool', tool: 'edit',
    state: { status: 'completed', input: { filePath: join(declarations, 'owners', 'nas.yaml') }, output: 'ok' },
  } } } as never });
  const finishing = idle('operator');
  await promptStart;
  releasePrompt();
  await finishing;
  await say('operator', 'Operator', 'Unrelated reply');
  messages.operator = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished,
    { info: { id: 'nudge', role: 'user' }, parts: [{ type: 'text', text: MEMORY_NUDGE_TEXT }] },
    { info: { id: 'user-2', role: 'user' }, parts: [{ type: 'text', text: 'Unrelated reply' }] }, finished];
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('reconciliation retains a lease if the admitted message has no persisted ID', async () => {
  const { state, sayWithoutMarker, statuses, messages, reconcile } = await setup();
  await sayWithoutMarker('chat');
  statuses.chat = { type: 'idle' };
  messages.chat = [{ info: { id: 'old-user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a child tool awaiting ancestry retains the parent admission until it completes', async () => {
  const { state, hooks, say, idle, statuses, children, pauseNextChildLookup, childStatusStart, resumeChildStatus } = await setup();
  await say('parent');
  statuses.parent = { type: 'idle' };
  children.parent = [];
  statuses.child = { type: 'idle' };
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  pauseNextChildLookup();
  const tool = hooks['tool.execute.before']!({ sessionID: 'child', tool: 'bash', callID: 'late' }, { args: {} });
  await childStatusStart;
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  resumeChildStatus();
  await tool;
  await hooks['tool.execute.after']!({ sessionID: 'child', tool: 'bash', callID: 'late', args: {} }, { title: '', output: '', metadata: {} });
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child message awaiting ancestry during the parent final read keeps its lease through drain', async () => {
  const { state, say, idle, children, pauseFinalChatMessages, messagesStart, resumeMessages,
    pauseNextChildLookup, childStatusStart, resumeChildStatus } = await setup();
  await say('parent');
  children.parent = [];
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  pauseFinalChatMessages();
  const finishing = idle('parent');
  await messagesStart;
  pauseNextChildLookup();
  const joining = say('child', 'onionsoup-implementer');
  await childStatusStart;
  resumeMessages();
  await finishing;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  resumeChildStatus();
  await joining;
  children.parent = ['child'];
  await idle('child');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child tool awaiting ancestry during the parent final read keeps its lease through drain', async () => {
  const { state, hooks, say, idle, children, pauseFinalChatMessages, messagesStart, resumeMessages,
    pauseNextChildLookup, childStatusStart, resumeChildStatus } = await setup();
  await say('parent');
  children.parent = [];
  await armDeployment(state, 'build');
  await beginDrain(state, 'build');
  pauseFinalChatMessages();
  const finishing = idle('parent');
  await messagesStart;
  pauseNextChildLookup();
  const tool = hooks['tool.execute.before']!({ sessionID: 'child', tool: 'bash', callID: 'pending' }, { args: {} });
  await childStatusStart;
  resumeMessages();
  await finishing;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  resumeChildStatus();
  await tool;
  await hooks['tool.execute.after']!({ sessionID: 'child', tool: 'bash', callID: 'pending', args: {} }, { title: '', output: '', metadata: {} });
  await idle('parent');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child omitted by an unscoped lookup retains its parent until its scoped final is proved', async () => {
  const { state, say, statuses, children, messages, reconcile, requireScopedChildren } = await setup();
  requireScopedChildren();
  await say('parent');
  statuses.parent = { type: 'idle' };
  statuses.child = { type: 'idle' };
  children.parent = ['child'];
  messages.parent = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
  messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }, finishedFor('child-user')];
  await reconcile();
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});

test('a child becoming busy after initial proof cannot release through the final boundary', async () => {
  const { state, say, statuses, children, messages, reconcile, pauseNextStatus, childStatusStart, resumeChildStatus } = await setup();
  await say('parent');
  statuses.parent = { type: 'idle' };
  statuses.child = { type: 'idle' };
  children.parent = ['child'];
  messages.parent = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }, finishedFor('child-user')];
  pauseNextStatus();
  const checking = reconcile();
  await childStatusStart;
  statuses.child = { type: 'busy' };
  resumeChildStatus();
  await checking;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a known child busy event during the final parent transcript read retains its lease', async () => {
  const { state, hooks, say, idle, statuses, children, messages,
    pauseFinalChatMessages, messagesStart, resumeMessages } = await setup();
  await say('parent');
  children.parent = ['child'];
  statuses.child = { type: 'idle' };
  messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }, finishedFor('child-user')];
  pauseFinalChatMessages();
  const finishing = idle('parent');
  await messagesStart;
  statuses.child = { type: 'busy' };
  const busy = hooks.event!({ event: { type: 'session.status', properties: {
    sessionID: 'child', status: { type: 'busy' },
  } } as never });
  resumeMessages();
  await Promise.all([busy, finishing]);
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});

test('a child final disappearing after initial proof retains the parent at final release', async () => {
  const { state, say, statuses, children, messages, reconcile, pauseFinalChildMessages, messagesStart, resumeMessages } = await setup();
  await say('parent');
  statuses.parent = { type: 'idle' };
  statuses.child = { type: 'idle' };
  children.parent = ['child'];
  messages.parent = [{ info: { id: 'user', role: 'user' }, parts: [] }, finished];
  messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }, finishedFor('child-user')];
  pauseFinalChildMessages();
  const checking = reconcile();
  await messagesStart;
  messages.child = [{ info: { id: 'child-user', role: 'user' }, parts: [] }];
  resumeMessages();
  await checking;
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
});


test('approved inactive child releases only its completed parent; active child, changed evidence and new prompts remain blocked', async context => {
  const { state, say, statuses, children, reconcile, failMessagesFor, hooks } = await setup();
  const database = join(state, 'child-history.db');
  const db = childStore(database);
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = database;
  context.after(() => { db.close(); if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous; });
  await say('ses_parent');
  await say('ses_unrelated');
  statuses.ses_unrelated = { type: 'busy' };
  children.ses_parent = ['ses_child'];
  failMessagesFor('ses_child');
  await reconcile();
  assert.equal((await listAdmissions(state)).length, 2, 'HTTP 400 cannot manufacture a finished child');
  const identity = { childID: 'ses_child', parentID: 'ses_parent', directory: '/chats' };
  await recordChildAbandonment(state, { ...identity, version: 1, state: 'abandoned',
    digest: childRecoverySnapshot(identity, database).digest, recordedBy: 'fixture-operator', approvedBy: 'person', approvedAt: new Date().toISOString(), reason: 'Abandon the inactive watcher' }, database);
  statuses.ses_child = { type: 'busy' };
  await reconcile();
  assert.equal((await listAdmissions(state)).length, 2, 'an approval cannot override current activity');
  delete statuses.ses_child;
  await reconcile();
  assert.deepEqual((await listAdmissions(state)).map(lease => lease.kind), ['chat:ses_unrelated']);
  await assert.rejects(say('ses_child'), /child_session_abandoned/);
  await assert.rejects(hooks['tool.execute.before']!({ sessionID: 'ses_child', callID: 'blocked', tool: 'read' }, { args: {} }), /child_session_abandoned/);
  await say('ses_parent');
  db.prepare('update message set data=? where id=?').run(JSON.stringify({ role: 'user', time: { created: 5 } }), 'msg_user');
  await reconcile();
  assert.equal((await listAdmissions(state)).length, 2, 'new evidence invalidates the old receipt');
});

function persistFailedTool(fixture: Awaited<ReturnType<typeof setup>>, sessionID: string, callID: string, userID = 'user') {
  const messageID = `tool-message-${callID}`;
  const part = { id: `part-${callID}`, sessionID, messageID, callID, type: 'tool', tool: 'apply_patch',
    state: { status: 'error', error: 'apply_patch verification failed', time: { start: 3, end: 4 } } };
  const messages = fixture.messages[sessionID]!;
  for (const message of messages as { info: { role: string; sessionID?: string } }[]) {
    message.info.sessionID = sessionID;
  }
  messages.splice(messages.length - 1, 0, {
    info: { id: messageID, role: 'assistant', sessionID, parentID: userID }, parts: [part],
  });
  return part;
}

async function toolErrorEvent(fixture: Awaited<ReturnType<typeof setup>>, part: unknown) {
  await fixture.hooks.event!({ event: { type: 'message.part.updated', properties: { part } } as never });
}

async function beforeFailedTool(fixture: Awaited<ReturnType<typeof setup>>, sessionID: string, callID = 'failed') {
  await fixture.hooks['tool.execute.before']!({ sessionID, callID, tool: 'apply_patch' }, { args: {} });
}

async function liveAdmissions(fixture: Awaited<ReturnType<typeof setup>>) {
  return (await listAdmissions(fixture.state)).filter(lease => lease.alive).length;
}

test('persisted terminal error releases exact parent and child markers without an after hook', async () => {
  const fixture = await setup();
  fixture.children.parent = ['child'];
  await fixture.say('parent');
  await fixture.say('child');
  await beforeFailedTool(fixture, 'child');
  const part = persistFailedTool(fixture, 'child', 'failed', 'user-2');
  await toolErrorEvent(fixture, part);
  await fixture.idle('child');
  assert.equal(await liveAdmissions(fixture), 0);
  await toolErrorEvent(fixture, part);
  await fixture.hooks['tool.execute.after']!({ sessionID: 'child', callID: 'failed', tool: 'apply_patch', args: {} }, { title: '', output: '', metadata: {} });
  assert.equal(await liveAdmissions(fixture), 0);
});

test('periodic reconciliation repairs a missed terminal-error event using persisted evidence', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  persistFailedTool(fixture, 'chat', 'failed');
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('terminal-error event before persistence retains the call until a later reconciliation', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  await toolErrorEvent(fixture, { type: 'tool', sessionID: 'chat', state: { status: 'error' } });
  await fixture.idle('chat');
  assert.equal(await liveAdmissions(fixture), 1);
  persistFailedTool(fixture, 'chat', 'failed');
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('failed-call cleanup retains concurrent genuine tools and does not treat completed parts as errors', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  await beforeFailedTool(fixture, 'chat', 'running');
  const part = persistFailedTool(fixture, 'chat', 'failed');
  const running = persistFailedTool(fixture, 'chat', 'running');
  running.state.status = 'completed';
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  await fixture.hooks['tool.execute.after']!({ sessionID: 'chat', callID: 'running', tool: 'apply_patch', args: {} }, { title: '', output: '', metadata: {} });
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('duplicate old error and after callbacks preserve a later genuine turn and tool', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  const part = persistFailedTool(fixture, 'chat', 'failed');
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
  await fixture.say('chat');
  fixture.messages.chat!.pop();
  await beforeFailedTool(fixture, 'chat', 'later');
  await toolErrorEvent(fixture, part);
  await fixture.hooks['tool.execute.after']!({ sessionID: 'chat', callID: 'failed', tool: 'apply_patch', args: {} }, { title: '', output: '', metadata: {} });
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  await fixture.hooks['tool.execute.after']!({ sessionID: 'chat', callID: 'later', tool: 'apply_patch', args: {} }, { title: '', output: '', metadata: {} });
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  fixture.messages.chat!.push(finishedFor('user-2'));
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('an error during before-hook ancestry registration cannot clear a marker before registration finishes', async () => {
  const fixture = await setup();
  fixture.children.parent = ['child'];
  await fixture.say('parent');
  await fixture.say('child');
  fixture.pauseNextChildLookup();
  const starting = beforeFailedTool(fixture, 'child');
  await fixture.childStatusStart;
  const part = persistFailedTool(fixture, 'child', 'failed', 'user-2');
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  fixture.resumeChildStatus();
  await starting;
  await fixture.idle('child');
  assert.equal(await liveAdmissions(fixture), 1);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('a new user arriving during error-proof reads keeps its unfinished admission', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  const part = persistFailedTool(fixture, 'chat', 'failed');
  fixture.pauseNextMessages();
  const checking = toolErrorEvent(fixture, part);
  await fixture.messagesStart;
  await fixture.say('chat');
  fixture.messages.chat!.pop();
  fixture.resumeMessages();
  await checking;
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  fixture.messages.chat!.push(finishedFor('user-2'));
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

for (const mismatch of ['callID', 'sessionID', 'messageID', 'tool', 'parentID', 'time', 'running'] as const) {
  test(`failed-tool reconciliation fails closed for mismatched ${mismatch}`, async () => {
    const fixture = await setup();
    await fixture.say('chat');
    await beforeFailedTool(fixture, 'chat');
    const part = persistFailedTool(fixture, 'chat', 'failed');
    const changes = {
      callID: () => { part.callID = 'other'; },
      sessionID: () => { part.sessionID = 'other'; },
      messageID: () => { part.messageID = 'other'; },
      tool: () => { part.tool = 'read'; },
      parentID: () => { (fixture.messages.chat![1] as { info: { parentID: string } }).info.parentID = 'other'; },
      time: () => { part.state.time.end = 1; },
      running: () => { part.state.status = 'running'; },
    };
    changes[mismatch]();
    await toolErrorEvent(fixture, part);
    await fixture.reconcile();
    assert.equal(await liveAdmissions(fixture), 1);
  });
}

test('failed-tool proof read errors retain the lease and duplicate before hooks cannot replace tracking', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  await assert.rejects(beforeFailedTool(fixture, 'chat'), /tool_call_already_active/);
  const part = persistFailedTool(fixture, 'chat', 'failed');
  fixture.failMessagesFor('chat');
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
});

test('conflicting persisted states for the same call cannot prove terminal failure', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  const part = persistFailedTool(fixture, 'chat', 'failed');
  const conflict = persistFailedTool(fixture, 'chat', 'failed');
  conflict.state.status = 'running';
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
});

test('an aborted tool error clears only that call and still waits for its real final answer', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  const part = persistFailedTool(fixture, 'chat', 'failed');
  part.state.error = 'The operation was aborted.';
  fixture.messages.chat!.pop();
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  fixture.messages.chat!.push(finishedFor('user'));
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('a failed grandchild tool cleans its admitted ancestor without releasing a later child turn', async () => {
  const fixture = await setup();
  fixture.children.parent = ['child'];
  fixture.children.child = ['grandchild'];
  await fixture.say('parent');
  await fixture.say('child');
  await fixture.say('grandchild');
  await beforeFailedTool(fixture, 'grandchild');
  const part = persistFailedTool(fixture, 'grandchild', 'failed', 'user-3');
  await fixture.idle('grandchild');
  await fixture.idle('child');
  await fixture.say('child');
  fixture.messages.child!.pop();
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
  fixture.messages.child!.push(finishedFor('user-4'));
  await fixture.idle('child');
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 0);
});

test('a completed call identity cannot be reused where a delayed after hook would be ambiguous', async () => {
  const fixture = await setup();
  await fixture.say('chat');
  await beforeFailedTool(fixture, 'chat');
  const part = persistFailedTool(fixture, 'chat', 'failed');
  await toolErrorEvent(fixture, part);
  await fixture.reconcile();
  await fixture.say('chat');
  fixture.messages.chat!.pop();
  await assert.rejects(beforeFailedTool(fixture, 'chat'), /tool_call_already_finished/);
  await fixture.hooks['tool.execute.after']!({ sessionID: 'chat', callID: 'failed', tool: 'apply_patch', args: {} }, { title: '', output: '', metadata: {} });
  await fixture.reconcile();
  assert.equal(await liveAdmissions(fixture), 1);
});
