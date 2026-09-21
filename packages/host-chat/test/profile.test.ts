import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { openJobHost, type Capability } from '@onionsoup/job-host';
import { openChatSession, chatTurn, closeChatSession } from '@onionsoup/chat';
import { createHostChatProfile, summarize, type HostCaller } from '../src/index.ts';

const capability = (id: string, interactive = false): Capability => ({
  id, version: 'v1', description: `${id} fixture`, metadata: {}, effects: ['local_artifacts'], timeoutMs: 10000, interactive,
  input: z.object({ value: z.number().int() }).strict(),
  output: z.object({ value: z.number().int(), markdown: z.string() }).strict(),
  execute: async (input) => ({ value: input.value * 2, markdown: `# Doubled\n\n${input.value * 2}` }),
});

type Call = { tool: string; input: unknown };
/** A model that decides its next tool call from the tool results already in the conversation. */
function planner(decide: (results: string[]) => Call) {
  return new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const results: string[] = [];
    for (const message of prompt) {
      if (message.role !== 'tool') continue;
      for (const part of message.content) if (part.type === 'tool-result') results.push(JSON.stringify(part.output));
    }
    const call = decide(results);
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: `call-${results.length}`, toolName: call.tool, input: JSON.stringify(call.input) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
}
const jobIdIn = (text: string) => /"jobId\\?":\\?"([0-9a-f-]{36})/.exec(text)?.[1];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-chat-'));
  const host = await openJobHost({ directory: join(root, 'host'), binding: {}, capabilities: [capability('fixture.double'), capability('fixture.approve', true)], invokers: [{ id: 'web', capabilities: ['fixture.double', 'fixture.approve'] }] });
  const caller: HostCaller = {
    discover: () => host.discover('web'), submit: (r) => host.submit('web', r), inspect: (id) => host.inspect('web', id), list: () => host.list('web'), cancel: (id) => host.cancel('web', id),
  };
  const profile = createHostChatProfile({ bindingHash: 'a'.repeat(64), host: caller, pollMs: 5 });
  const handle = await openChatSession({ directory: join(root, 'session'), profile, provider: 'copilot', modelId: 'gpt-5.6-terra' });
  return { root, host, handle, async close() { await closeChatSession(handle); await host.close(); await rm(root, { recursive: true, force: true }); } };
}

test('a turn discovers, runs a capability as a host job, and answers citing the inspected job', async () => {
  const f = await fixture();
  try {
    const model = planner((results) => {
      if (results.length === 0) return { tool: 'discover_capabilities', input: {} };
      if (results.length === 1) return { tool: 'run_capability', input: { capability: 'fixture.double', input: { value: 21 } } };
      const jobId = jobIdIn(results[1])!;
      return { tool: 'submit_answer', input: { kind: 'answer', text: 'Doubled to 42.', basis: 'current', references: [{ id: jobId }] } };
    });
    const turn = await chatTurn(f.handle, 'Double 21 for me', { modelFactory: async () => model });
    assert.equal(turn.status, 'completed', turn.failure);
    assert.equal(turn.answer?.kind, 'answer');
    const jobId = turn.answer!.references[0].id;
    const job = await f.host.inspect('web', jobId);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.result, { value: 42, markdown: '# Doubled\n\n42' });
    const memory = f.handle.session.memory as { admissions: number; jobs: { id: string }[] };
    assert.equal(memory.admissions, 1);
    assert.deepEqual(memory.jobs.map((j) => j.id), [jobId]);
    assert.deepEqual(turn.events.filter((e) => e.stage === 'intent').map((e) => e.tool), ['discover_capabilities', 'run_capability']);
    assert.ok(turn.events.some((e) => e.tool === 'submit_answer' && e.stage === 'result'));
  } finally {
    await f.close();
  }
});

test('interactive capabilities and uninspected citations are refused; the model recovers with an unsupported answer', async () => {
  const f = await fixture();
  try {
    const model = planner((results) => {
      if (results.length === 0) return { tool: 'discover_capabilities', input: {} };
      if (results.length === 1) return { tool: 'run_capability', input: { capability: 'fixture.approve', input: { value: 1 } } };
      if (results.length === 2) return { tool: 'submit_answer', input: { kind: 'answer', text: 'Done.', basis: 'current', references: [{ id: '11111111-1111-4111-8111-111111111111' }] } };
      return { tool: 'submit_answer', input: { kind: 'unsupported', text: 'Approval needs a person; open the job page.', basis: 'none', references: [] } };
    });
    const turn = await chatTurn(f.handle, 'Approve it', { modelFactory: async () => model });
    assert.equal(turn.status, 'completed', turn.failure);
    assert.equal(turn.answer?.kind, 'unsupported');
    const rejected = turn.events.filter((e) => e.stage === 'rejected');
    assert.deepEqual(rejected.map((e) => e.tool), ['run_capability', 'submit_answer']);
    assert.equal((rejected[1].details as { code: string }).code, 'INSPECT_FIRST');
    assert.equal(f.host.list('web').length, 0);
  } finally {
    await f.close();
  }
});

test('summaries prefer Markdown and stay bounded', () => {
  assert.deepEqual(summarize({ markdown: '# Hi', other: 1 }), { summary: '# Hi', truncated: false });
  const long = summarize({ value: 'x'.repeat(10000) }, 100);
  assert.equal(long.summary.length, 100);
  assert.equal(long.truncated, true);
});
