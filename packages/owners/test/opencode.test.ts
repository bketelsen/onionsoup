import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Verdict } from '../src/artifacts.ts';
import { HireError, runHire, type HireSessionClient } from '../src/opencode.ts';

interface RecordedPrompt {
  sessionID: string;
  format?: unknown;
  parts: { text: string }[];
}

function scriptedClient(replies: readonly (() => unknown)[]) {
  const sessionIDs: string[] = [];
  const prompts: RecordedPrompt[] = [];
  const client = {
    session: {
      create: async () => {
        const sessionID = `ses_${sessionIDs.length + 1}`;
        sessionIDs.push(sessionID);
        return { data: { id: sessionID } };
      },
      abort: async () => ({ data: true }),
      prompt: async (options: RecordedPrompt) => {
        const reply = replies[prompts.length];
        prompts.push(options);
        assert.ok(reply, 'unexpected additional hire prompt');
        return reply();
      },
    },
    permission: { list: async () => ({ data: [] }), reply: async () => ({ data: true }) },
  } as unknown as HireSessionClient;
  return { client, sessionIDs, prompts };
}

function reviewRequest(model: string) {
  return {
    role: 'reviewer' as const, model, directory: process.cwd(),
    title: 'Hire outcome regression', brief: 'Review the authorized change.', schema: Verdict,
  };
}

function malformedReply() {
  const deliverable = { decision: 'not-a-decision' };
  return {
    data: {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: JSON.stringify(deliverable) }],
    },
  };
}

test('runHire marks two actually returned malformed deliverables terminal', async () => {
  const fixture = scriptedClient([malformedReply, malformedReply]);
  await assert.rejects(runHire(fixture.client, reviewRequest('fixture/malformed')), error => {
    assert.ok(error instanceof HireError);
    assert.match(error.message, /^deliverable_invalid:/);
    assert.equal(error.sessionID, 'ses_1');
    assert.equal(error.outcome, 'returned-terminal');
    return true;
  });
  assert.deepEqual(fixture.sessionIDs, ['ses_1']);
  assert.equal(fixture.prompts.length, 2, 'a returned invalid reply gets one resend before terminal failure');
  assert.ok(fixture.prompts.every(prompt => prompt.sessionID === 'ses_1' && prompt.format === undefined));
});

test('runHire marks returned provider info.error terminal without inferring it from prose', async () => {
  const fixture = scriptedClient([() => ({
    data: { info: { role: 'assistant', error: {
      name: 'APIError', data: { message: 'upstream_down', statusCode: 503 },
    } } },
  })]);
  await assert.rejects(runHire(fixture.client, reviewRequest('fixture/returned-provider-error')), error => {
    assert.ok(error instanceof HireError);
    assert.equal(error.outcome, 'returned-terminal');
    assert.equal(error.sessionID, 'ses_1');
    assert.deepEqual(error.providerError, { name: 'APIError', message: 'upstream_down', statusCode: 503 });
    return true;
  });
  assert.deepEqual(fixture.sessionIDs, ['ses_1']);
  assert.equal(fixture.prompts.length, 1);
});

test('a returned transport error without assistant info remains unknown even with terminal-looking error text', async () => {
  const fixture = scriptedClient([() => ({ error: new Error('deliverable_invalid: connection lost') })]);
  await assert.rejects(runHire(fixture.client, reviewRequest('fixture/missing-assistant')), error => {
    assert.ok(error instanceof HireError);
    assert.match(error.message, /^no_assistant_reply:/);
    assert.equal(error.sessionID, 'ses_1');
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.providerError, undefined);
    return true;
  });
  assert.equal(fixture.prompts.length, 1);
});

test('runHire leaves a rejected transport promise unclassified rather than claiming a returned terminal reply', async () => {
  const transportError = new Error('deliverable_invalid: transport disconnected');
  const fixture = scriptedClient([() => { throw transportError; }]);
  await assert.rejects(runHire(fixture.client, reviewRequest('fixture/rejected-transport')), error => {
    assert.equal(error, transportError);
    assert.equal(error instanceof HireError, false, 'no returned assistant evidence supplies a terminal outcome');
    return true;
  });
  assert.equal(fixture.prompts.length, 1);
});
