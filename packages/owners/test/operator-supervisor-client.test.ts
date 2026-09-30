import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Plugin } from '@opencode-ai/plugin';
import { operatorSupervisorClient } from '../src/operator-supervisor-client.ts';

function fixture() {
  const current = { id: 'child', title: 'host-stable-title', directory: '/fixture' };
  const state: { statuses: unknown; transcript: unknown; session: unknown } = {
    statuses: {}, session: current,
    transcript: [{ info: { id: 'user', sessionID: 'child', role: 'user', time: { created: 1 } }, parts: [] },
      { info: { id: 'answer', sessionID: 'child', role: 'assistant', parentID: 'user', time: { completed: 2 }, finish: 'stop' },
        parts: [{ type: 'text', text: 'Observed fixture fact; not independently verified.' }] }],
  };
  const client = operatorSupervisorClient({ session: {
    get: async () => ({ data: state.session }),
    status: async () => ({ data: state.statuses }),
    messages: async () => ({ data: state.transcript }),
  } } as unknown as Parameters<Plugin>[0]['client']);
  return { client, state, current };
}

test('an earlier unfinished tool prevents a later final answer from becoming completion evidence', async () => {
  const { client, state } = fixture();
  const transcript = state.transcript as Array<{ info: object; parts: unknown[] }>;
  transcript.splice(1, 0, { info: { id: 'tool-turn', sessionID: 'child', role: 'assistant', parentID: 'user', time: { completed: 1 }, finish: 'tool-calls' },
    parts: [{ type: 'tool', callID: 'still-running', tool: 'read', state: { status: 'running' } }] });
  const snapshot = await client.readSession('/fixture', 'child');
  assert.equal(snapshot.messages.at(-1)?.completed, false);
  transcript[1]!.parts = [{ type: 'tool', callID: 'still-running', tool: 'read', state: { status: 'error' } }];
  assert.equal((await client.readSession('/fixture', 'child')).messages.at(-1)?.completed, true);
});

test('idle status does not turn the actual restart-shaped incomplete assistant into a result', async () => {
  const { client, state } = fixture();
  state.transcript = [{ info: { id: 'user', sessionID: 'child', role: 'user', time: { created: 1 } }, parts: [] },
    { info: { id: 'interrupted', sessionID: 'child', role: 'assistant', parentID: 'user', time: { created: 2 } }, parts: [] }];
  const snapshot = await client.readSession('/fixture', 'child');
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.messages.at(-1)?.completed, false);
  assert.equal(snapshot.messages.at(-1)?.error, undefined);
});

test('malformed or wrong-session runtime observations fail closed instead of reporting idle completion', async () => {
  for (const broken of ['status', 'transcript-session', 'tool-state', 'session-directory', 'native-parent'] as const) {
    const { client, state, current } = fixture();
    const transcript = state.transcript as Array<{ info: Record<string, unknown>; parts: unknown[] }>;
    const corruptions = {
      status: () => { state.statuses = { child: { type: 'unknown' } }; },
      'transcript-session': () => { transcript[1]!.info.sessionID = 'other-session'; },
      'tool-state': () => { transcript[1]!.parts.push({ type: 'tool', callID: 'read', tool: 'read', state: { status: 'unknown' } }); },
      'session-directory': () => { state.session = { ...current, directory: '/another-workspace' }; },
      'native-parent': () => { state.session = { ...current, parentID: 'a-real-parent' }; },
    };
    corruptions[broken]();
    await assert.rejects(client.readSession('/fixture', 'child'), Error, broken);
  }
});

test('an assistant error cannot be promoted by a stop marker and completed timestamp', async () => {
  const { client, state } = fixture();
  const transcript = state.transcript as Array<{ info: Record<string, unknown>; parts: unknown[] }>;
  transcript[1]!.info.error = { name: 'MessageAbortedError', data: { message: 'Internal details are not projected.' } };
  const result = (await client.readSession('/fixture', 'child')).messages.at(-1)!;
  assert.equal(result.completed, false);
  assert.equal(result.error, 'MessageAbortedError');
});

test('a session observation shares one aggregate timeout across lookup, status and transcript', async () => {
  const observed: AbortSignal[] = [];
  let transcriptReads = 0;
  const client = operatorSupervisorClient({ session: {
    get: async ({ signal }: { signal: AbortSignal }) => {
      observed.push(signal);
      return { data: { id: 'child', title: 'fixture', directory: '/fixture' } };
    },
    status: async ({ signal }: { signal: AbortSignal }) => {
      observed.push(signal);
      await delay(1_000, undefined, { signal });
      return { data: {} };
    },
    messages: async () => { transcriptReads++; return { data: [] }; },
  } } as unknown as Parameters<Plugin>[0]['client'], { timeoutMs: 40 });
  await assert.rejects(client.readSession('/fixture', 'child'), /aborted/i);
  assert.equal(observed.length, 2);
  assert.equal(observed[0], observed[1]);
  assert.equal(observed[0]!.aborted, true);
  assert.equal(transcriptReads, 0);
});

test('a caller cancellation reaches the in-flight read and prevents later stages', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = operatorSupervisorClient({ session: {
    get: async ({ signal }: { signal: AbortSignal }) => {
      calls++;
      controller.abort(new Error('fixture_phase_cancelled'));
      await delay(1_000, undefined, { signal });
      return { data: {} };
    },
    status: async () => { calls++; return { data: {} }; },
  } } as unknown as Parameters<Plugin>[0]['client']);
  await assert.rejects(client.readSession('/fixture', 'child', { signal: controller.signal }), /aborted/i);
  assert.equal(calls, 1);
});

test('a cancelled call never creates, prompts or aborts a session', async () => {
  const controller = new AbortController();
  controller.abort(new Error('fixture_cancelled_before_effect'));
  let effects = 0;
  const effect = async () => { effects++; return { data: true }; };
  const transport = { session: { get: effect, create: effect, promptAsync: effect, abort: effect } };
  const client = operatorSupervisorClient(transport as unknown as Parameters<Plugin>[0]['client']);
  const options = { signal: controller.signal };
  await assert.rejects(client.createSession('/fixture', 'title', options), /fixture_cancelled_before_effect/);
  await assert.rejects(client.prompt('/fixture', 'child', 'message', 'scope', options), /fixture_cancelled_before_effect/);
  await assert.rejects(client.abort('/fixture', 'child', options), /fixture_cancelled_before_effect/);
  assert.equal(effects, 0);
});

test('a late session lookup cannot authorize a mutation after the shared budget expired', async () => {
  let mutations = 0;
  const client = operatorSupervisorClient({ session: {
    get: async () => {
      await delay(30);
      return { data: { id: 'child', title: 'fixture', directory: '/fixture' } };
    },
    promptAsync: async () => { mutations++; return { data: {} }; },
  } } as unknown as Parameters<Plugin>[0]['client'], { timeoutMs: 10 });
  await assert.rejects(client.prompt('/fixture', 'child', 'message', 'scope'), /timeout/i);
  assert.equal(mutations, 0);
});
