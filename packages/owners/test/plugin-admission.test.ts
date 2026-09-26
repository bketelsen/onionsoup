import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { armDeployment, beginDrain, listAdmissions } from '../src/deployment-admission.ts';
import { withActiveHooks } from './active-hooks.ts';

async function setup(operator = false) {
  const declarations = await mkdtemp(join(tmpdir(), 'plugin-admission-config-'));
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  if (operator) await writeFile(join(declarations, 'operator.yaml'), 'model: github-copilot/gpt-6-sol\n');
  const state = await mkdtemp(join(tmpdir(), 'plugin-admission-state-'));
  const statuses: Record<string, { type: string }> = {};
  const children: Record<string, string[]> = {};
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
  let promptStarted: (() => void) | undefined;
  const promptStart = new Promise<void>(resolve => { promptStarted = resolve; });
  const client = { session: {
    status: async () => {
      if (pauseChildStatus) {
        pauseChildStatus = false;
        childStatusStarted?.();
        await new Promise<void>(resolve => { releaseChildStatus = resolve; });
      }
      if (failStatusLookup) return { error: new Error('status unavailable') };
      if (malformedStatus) return { data: { parent: { type: 123 } } };
      return { data: statuses };
    },
    children: async ({ path }: { path: { id: string } }) => ({ data: (children[path.id] ?? []).map(id => ({ id })) }),
    get: async ({ path }: { path: { id: string } }) => {
      if (path.id === 'child' && pauseChildLookup) {
        pauseChildLookup = false;
        childStatusStarted?.();
        await new Promise<void>(resolve => { releaseChildStatus = resolve; });
      }
      return failSessionLookup
        ? { error: new Error('session unavailable') }
        : { data: { id: path.id, directory: '/chats', parentID: ['child', 'watcher'].includes(path.id) ? 'parent' : undefined } };
    },
    messages: async () => {
      if (failWatcher) throw new Error('watcher unavailable');
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
      return { data: { info: { structured: { records: [] } } } };
    },
    delete: async () => {
      children.parent = (children.parent ?? []).filter(id => id !== 'watcher');
      delete statuses.watcher;
      watcherDeleted = true;
      return { data: true };
    },
    promptAsync: async () => {
      promptStarted?.();
      await new Promise<void>(resolve => { releasePrompt = resolve; });
      return { data: {} };
    },
  } };
  const hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  const say = (sessionID: string, agent = 'Miles Teg', text = 'Hello') =>
    hooks['chat.message']!({ sessionID, agent }, { parts: [{ type: 'text', text }] } as never);
  sayWatcher = () => say('watcher', 'onionsoup-watcher');
  const idle = (sessionID: string) => hooks.event!({ event: { type: 'session.idle', properties: { sessionID } } as never });
  return {
    hooks, state, declarations, statuses, children, say, idle, promptStart, childStatusStart,
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

test('a concurrent message sharing pending chat admission rechecks the drain gate', async () => {
  const { state, say, idle } = await setup();
  await armDeployment(state, 'build');
  const holder = spawn('flock', ['--exclusive', join(state, 'deploy', 'admission.lock'), 'sh', '-c', 'printf ready; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => { holder.once('close', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.once('data', () => resolve());
  });
  try {
    const first = say('chat');
    await new Promise(resolve => setImmediate(resolve));
    const draining = beginDrain(state, 'build');
    await new Promise(resolve => setImmediate(resolve));
    const rejectedSecond = assert.rejects(say('chat', 'Miles Teg', 'Concurrent turn'), /deployment_draining/);
    holder.stdin.end();
    await first;
    await draining;
    await rejectedSecond;
    assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 1);
    await idle('chat');
  } finally {
    holder.stdin.end();
    await closed;
  }
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
  const { state, declarations, hooks, say, idle, promptStart, releasePrompt } = await setup(true);
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
  await say('operator', 'Operator', 'Remember this for later');
  await idle('operator');
  assert.equal((await listAdmissions(state)).filter(lease => lease.alive).length, 0);
});
