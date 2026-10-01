import assert from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from '@opencode-ai/plugin';
import { listAdmissions } from '../src/deployment-admission.ts';
import { PLUGIN_MAINTENANCE_LIMITS } from '../src/plugin-maintenance.ts';
import { withActiveHooks } from './active-hooks.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function fixture() {
  const declarations = await mkdtemp(join(tmpdir(), 'chat-maintenance-config-'));
  await cp('packages/owners/test/fixtures/owners', declarations, { recursive: true });
  const state = await mkdtemp(join(tmpdir(), 'chat-maintenance-state-'));
  const timers: Array<() => Promise<unknown>> = [];
  const readStarted = deferred();
  const readReleased = deferred();
  const promptStarted = deferred();
  const promptReleased = deferred();
  let blockRead = false;
  let blockPrompt = false;
  let readSignal: AbortSignal | undefined;
  const effects: string[] = [];
  const client = { session: {
    get: async ({ path, signal }: { path: { id: string }; signal?: AbortSignal }) => {
      if (blockRead) {
        blockRead = false;
        readSignal = signal;
        readStarted.resolve();
        await readReleased.promise;
      }
      return { data: { id: path.id, directory: '/chats' } };
    },
    status: async () => ({ data: {} }),
    children: async () => ({ data: [] }),
    messages: async () => ({ data: [
      { info: { id: 'user', role: 'user' }, parts: [{ type: 'text', text: 'Hello' }] },
      { info: { id: 'answer', role: 'assistant', parentID: 'user', finish: 'stop', time: { completed: 2 } }, parts: [] },
    ] }),
    create: async () => {
      effects.push('create');
      return { data: { id: 'watcher' } };
    },
    prompt: async () => {
      effects.push('prompt');
      promptStarted.resolve();
      if (blockPrompt) await promptReleased.promise;
      return { data: { info: { structured: { records: [] } } } };
    },
    delete: async () => {
      effects.push('delete');
      return { data: true };
    },
  } };
  const originalInterval = globalThis.setInterval;
  let hooks: Awaited<ReturnType<typeof withActiveHooks>>;
  try {
    globalThis.setInterval = ((callback: () => Promise<unknown>) => {
      timers.push(callback);
      return { unref() {} } as NodeJS.Timeout;
    }) as typeof setInterval;
    hooks = await withActiveHooks({ client } as unknown as Parameters<Plugin>[0], { declarations, state });
  } finally { globalThis.setInterval = originalInterval; }
  await hooks['chat.message']!({ sessionID: 'chat', agent: 'Miles Teg', messageID: 'user' }, {
    message: { id: 'user', role: 'user', sessionID: 'chat' }, parts: [{ type: 'text', text: 'Hello' }],
  } as never);
  return { hooks, state, effects, readStarted, readReleased, promptStarted, promptReleased,
    reconcile: () => timers.at(-1)!(), readSignal: () => readSignal,
    pauseRead: () => { blockRead = true; }, pausePrompt: () => { blockPrompt = true; } };
}

async function withFastDisposal(operation: () => Promise<void>) {
  const previous = PLUGIN_MAINTENANCE_LIMITS.disposeMs;
  PLUGIN_MAINTENANCE_LIMITS.disposeMs = 10;
  try { await operation(); } finally { PLUGIN_MAINTENANCE_LIMITS.disposeMs = previous; }
}

test('disposing periodic reconciliation aborts its read and retains the chat despite a late completed answer', async () => {
  await withFastDisposal(async () => {
    const context = await fixture();
    context.pauseRead();
    const running = context.reconcile();
    await context.readStarted.promise;
    try {
      await context.hooks.dispose!();
      assert.equal(context.readSignal()?.aborted, true);
      assert.equal((await listAdmissions(context.state)).filter(lease => lease.kind === 'chat:chat').length, 1);
    } finally { context.readReleased.resolve(); }
    await running;
    await context.reconcile();
    assert.deepEqual(context.effects, []);
    assert.equal((await listAdmissions(context.state)).filter(lease => lease.kind === 'chat:chat').length, 1);
  });
});

test('disposing an admitted watcher prompt prevents later cleanup effects and chat release', async () => {
  await withFastDisposal(async () => {
    const context = await fixture();
    context.pausePrompt();
    const running = context.reconcile();
    await context.promptStarted.promise;
    try { await context.hooks.dispose!(); } finally { context.promptReleased.resolve(); }
    await running;
    assert.deepEqual(context.effects, ['create', 'prompt']);
    assert.equal((await listAdmissions(context.state)).filter(lease => lease.kind === 'chat:chat').length, 1);
  });
});
