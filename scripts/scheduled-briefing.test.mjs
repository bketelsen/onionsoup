import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConfig, runScheduledBriefing, scheduledDate } from './scheduled-briefing.mjs';

async function fixture(context) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'onionsoup-briefing-'));
  const state = { messages: [], status: {}, posts: [], onPost: undefined };
  const server = createServer(async (request, response) => {
    const reply = payload => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const prompt = JSON.parse(Buffer.concat(chunks).toString());
      state.posts.push(prompt);
      if (state.onPost) return state.onPost(prompt, request, response);
      state.messages.push(user(prompt.text), answer());
      response.statusCode = 202;
      return reply({ accepted: true });
    }
    if (request.url.endsWith('/messages')) return reply(state.messages);
    if (request.url.endsWith('/sessions')) return reply({ sessions: [{ id: 'session-test' }], status: state.status });
    response.statusCode = 404;
    reply({ error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const config = { id: 'morning', owner: 'leto', sessionID: 'session-test', surfaceUrl: `http://127.0.0.1:${server.address().port}`,
    stateDirectory, prompt: 'Private briefing request', timezone: 'America/New_York', requestTimeoutMs: 500, completionTimeoutMs: 150, pollMs: 5 };
  const key = 'smoke-test';
  const recordPath = join(stateDirectory, 'morning', `${key}.json`);
  const record = async () => JSON.parse(await readFile(recordPath, 'utf8'));
  return { config, state, key, record, recordPath };
}

function user(text) {
  return { info: { id: 'prompt-1', role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text }] };
}
function answer(overrides = {}, text = 'The full private briefing.') {
  return { info: { id: 'answer-1', role: 'assistant', parentID: 'prompt-1', finish: 'stop', time: { completed: Date.now() }, ...overrides },
    parts: [{ type: 'text', text }] };
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('scheduled briefing posts once, waits for its final answer, and persists metadata only', async context => {
  const { config, state, key, record } = await fixture(context);
  const completed = await runScheduledBriefing(config, { runKey: key });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.promptMessageID, 'prompt-1');
  assert.equal(completed.answerMessageID, 'answer-1');
  assert.match(state.posts[0].text, /\[onionsoup scheduled briefing: morning\/smoke-test\]/);
  assert.doesNotMatch(JSON.stringify(await record()), /Private briefing|full private/);
  state.messages = [];
  assert.equal((await runScheduledBriefing(config, { runKey: key })).status, 'completed');
  assert.equal(state.posts.length, 1);
});

test('busy sessions fail without a submission intent and can retry when idle', async context => {
  const { config, state, key, record } = await fixture(context);
  state.status['session-test'] = { type: 'busy' };
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'session_busy');
  assert.equal((await record()).error, 'session_busy');
  assert.equal(state.posts.length, 0);
  state.status = {};
  await runScheduledBriefing(config, { runKey: key });
  assert.equal(state.posts.length, 1);
});

test('asynchronous acceptance follows the matching prompt and ignores unrelated completed answers', async context => {
  const { config, state, key, record } = await fixture(context);
  state.onPost = (prompt, _request, response) => {
    state.messages.push(user(prompt.text), answer({ parentID: 'another-prompt' }));
    response.writeHead(202).end();
    setTimeout(() => state.messages.push(answer({ id: 'actual-answer' })), 25);
  };
  await runScheduledBriefing(config, { runKey: key });
  assert.equal((await record()).answerMessageID, 'actual-answer');
  assert.equal(state.posts.length, 1);
});

test('lost acknowledgement recovers an accepted prompt without reposting', async context => {
  const { config, state, key, record } = await fixture(context);
  state.onPost = (prompt, _request, response) => {
    state.messages.push(user(prompt.text), answer());
    response.destroy();
  };
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal((await record()).error, 'submission_ambiguous');
  assert.equal((await record()).causeCode, 'surface_unavailable');
  await runScheduledBriefing(config, { runKey: key });
  assert.equal((await record()).status, 'completed');
  assert.equal(state.posts.length, 1);
});

test('uncertain submissions missing from the transcript fail closed on retries', async context => {
  const { config, state, key, record } = await fixture(context);
  state.onPost = (_prompt, _request, response) => response.destroy();
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal(state.posts.length, 1);
  assert.equal((await record()).status, 'failed');
});

test('concurrent invocations cannot both submit a prompt', async context => {
  const { config, state, key } = await fixture(context);
  state.onPost = (prompt, _request, response) => {
    setTimeout(() => {
      state.messages.push(user(prompt.text), answer());
      response.writeHead(202).end();
    }, 20);
  };
  const outcomes = await Promise.allSettled([runScheduledBriefing(config, { runKey: key }), runScheduledBriefing(config, { runKey: key })]);
  assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled'));
  assert.equal(state.posts.length, 1);
  assert.equal((await runScheduledBriefing(config, { runKey: key })).status, 'completed');
});

test('model errors remain failures and never cause a duplicate prompt', async context => {
  const { config, state, key, record } = await fixture(context);
  state.onPost = (prompt, _request, response) => {
    state.messages.push(user(prompt.text), answer({ error: { name: 'APIError', message: 'private provider details' } }));
    response.writeHead(202).end();
  };
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'model_error');
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'model_error');
  assert.equal(state.posts.length, 1);
  assert.equal((await record()).error, 'model_error');
  assert.doesNotMatch(JSON.stringify(await record()), /private provider/);
});

test('unfinished or empty model replies time out and existing prompts can later finish', async context => {
  const { config, state, key, record } = await fixture(context);
  config.completionTimeoutMs = 25;
  state.onPost = (prompt, _request, response) => {
    state.messages.push(user(prompt.text), answer({ finish: 'tool-calls' }), answer({ id: 'empty' }, '  '));
    response.writeHead(202).end();
  };
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'completion_timeout');
  assert.equal((await record()).status, 'failed');
  state.messages.push(answer({ id: 'finished-later' }));
  await runScheduledBriefing(config, { runKey: key });
  assert.equal((await record()).answerMessageID, 'finished-later');
  assert.equal(state.posts.length, 1);
});

test('existing persisted final answer succeeds even without a local run record', async context => {
  const { config, state, key, record } = await fixture(context);
  state.messages.push(user(`Earlier execution\n[onionsoup scheduled briefing: morning/${key}]`), answer());
  state.status['session-test'] = { type: 'busy' };
  await runScheduledBriefing(config, { runKey: key });
  assert.equal(state.posts.length, 0);
  assert.equal((await record()).status, 'completed');
});

test('run keys use the latest scheduled local date across midnight, DST, and year boundaries', () => {
  const config = { timezone: 'America/New_York', localTime: '09:00' };
  assert.equal(scheduledDate(config, new Date('2026-09-24T03:59:00Z')), '2026-09-23');
  assert.equal(scheduledDate(config, new Date('2026-09-24T04:01:00Z')), '2026-09-23');
  assert.equal(scheduledDate(config, new Date('2026-09-24T12:59:00Z')), '2026-09-23');
  assert.equal(scheduledDate(config, new Date('2026-09-24T13:00:00Z')), '2026-09-24');
  assert.equal(scheduledDate(config, new Date('2026-01-01T05:01:00Z')), '2025-12-31');
  assert.equal(scheduledDate(config, new Date('2026-03-08T12:59:00Z')), '2026-03-07');
  assert.equal(scheduledDate(config, new Date('2026-03-08T13:00:00Z')), '2026-03-08');
  assert.equal(scheduledDate(config, new Date('2026-11-01T13:59:00Z')), '2026-10-31');
  assert.equal(scheduledDate(config, new Date('2026-11-01T14:00:00Z')), '2026-11-01');
});

test('configuration is validated at the boundary and corrupted state refuses effects', async context => {
  const { config, state, key, recordPath } = await fixture(context);
  assert.equal(parseConfig(config).localTime, '09:00');
  assert.throws(() => parseConfig({ ...config, localTime: '25:00' }), /config_invalid_localTime/);
  assert.throws(() => parseConfig({ ...config, pollMs: -1 }), /config_invalid_pollMs/);
  assert.throws(() => parseConfig({ ...config, timezone: 'not-a-timezone' }), /config_invalid_timezone/);
  await runScheduledBriefing(config, { runKey: key });
  await writeFile(recordPath, '{broken');
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'run_state_invalid');
  assert.equal(state.posts.length, 1);
});

test('CLI accepts an absolute config and prints metadata without transcript content', async context => {
  const { config, key } = await fixture(context);
  const configPath = join(config.stateDirectory, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const script = fileURLToPath(new URL('./scheduled-briefing.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--config', configPath, '--run-key', key], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'completed');
  assert.doesNotMatch(stdout + stderr, /Private briefing|full private/);
});

test('an adopted incomplete prompt cannot be reposted if later transcript reads omit it', async context => {
  const { config, state, key, record } = await fixture(context);
  config.completionTimeoutMs = 20;
  state.messages.push(user(`Earlier execution\n[onionsoup scheduled briefing: morning/${key}]`));
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'completion_timeout');
  assert.equal((await record()).promptMessageID, 'prompt-1');
  state.messages = [];
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal(state.posts.length, 0);
});

test('a crash after claiming submission but before POST fails closed', async context => {
  const { config, state, key, record } = await fixture(context);
  const directory = join(config.stateDirectory, config.id);
  await mkdir(directory);
  await writeFile(join(directory, `${key}.intent.json`), JSON.stringify({
    id: config.id, runKey: key, owner: config.owner, sessionID: config.sessionID, surfaceUrl: config.surfaceUrl,
    marker: `[onionsoup scheduled briefing: morning/${key}]`, status: 'submitting', updatedAt: new Date().toISOString(),
  }));
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal((await record()).error, 'submission_ambiguous');
  assert.equal(state.posts.length, 0);
});

test('HTTP rejection retains its reason and cannot trigger duplicate submissions', async context => {
  const { config, state, key, record } = await fixture(context);
  state.onPost = (_prompt, _request, response) => response.writeHead(400).end();
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal((await record()).causeCode, 'surface_http_400');
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal(state.posts.length, 1);
});

test('submission timeouts retain a distinct reason and remain recoverable from the transcript', async context => {
  const { config, state, key, record } = await fixture(context);
  config.requestTimeoutMs = 100;
  state.onPost = prompt => state.messages.push(user(prompt.text), answer());
  await rejectsCode(runScheduledBriefing(config, { runKey: key }), 'submission_ambiguous');
  assert.equal((await record()).causeCode, 'surface_timeout');
  await runScheduledBriefing(config, { runKey: key });
  assert.equal((await record()).status, 'completed');
  assert.equal(state.posts.length, 1);
});
