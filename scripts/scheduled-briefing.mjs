#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

export const DEFAULTS = { requestTimeoutMs: 15_000, completionTimeoutMs: 1_200_000, pollMs: 3_000, localTime: '09:00' };
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const fail = (code, causeCode) => Object.assign(new Error(code), { code, causeCode });
const Text = z.string().trim().min(1);
const PositiveMs = z.number().int().positive();
const Timezone = Text.refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
});
export const Config = z.object({
  id: z.string().regex(KEY), owner: Text, sessionID: Text,
  surfaceUrl: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  stateDirectory: Text.refine(isAbsolute), prompt: Text, timezone: Timezone,
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default(DEFAULTS.localTime),
  requestTimeoutMs: PositiveMs.default(DEFAULTS.requestTimeoutMs),
  completionTimeoutMs: PositiveMs.default(DEFAULTS.completionTimeoutMs),
  pollMs: PositiveMs.default(DEFAULTS.pollMs),
});
export const RunRecord = z.object({
  id: Text, runKey: Text, owner: Text, sessionID: Text, surfaceUrl: Text, marker: Text,
  status: z.enum(['waiting', 'submitting', 'monitoring', 'completed', 'failed']), updatedAt: z.iso.datetime(),
  promptMessageID: Text.optional(), answerMessageID: Text.optional(), error: Text.optional(), causeCode: Text.optional(),
}).refine(record => record.status !== 'completed' || Boolean(record.promptMessageID && record.answerMessageID));
export const Sessions = z.object({
  sessions: z.array(z.object({ id: Text })), status: z.record(z.string(), z.object({ type: Text })),
});
export const Messages = z.array(z.object({
  info: z.object({ id: Text, role: z.enum(['user', 'assistant']), parentID: Text.optional(), finish: z.string().optional(),
    error: z.unknown().optional(), time: z.object({ completed: z.number().finite().optional() }) }),
  parts: z.array(z.object({ type: Text, text: z.string().optional() })),
}));

function parse(schema, value, code) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw fail(code);
  return parsed.data;
}

export function parseConfig(input) {
  const parsed = Config.safeParse(input);
  if (!parsed.success) throw fail(`config_invalid_${parsed.error.issues[0]?.path[0] ?? 'shape'}`);
  return parsed.data;
}

/** Use the most recent scheduled local date, including persistent-timer catch-up before today's deadline. */
export function scheduledDate(config, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const local = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${local.year}-${local.month}-${local.day}`;
  if (`${local.hour}:${local.minute}` >= config.localTime) return date;
  const previous = new Date(`${date}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

async function readRecord(path) {
  const text = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  try {
    return parse(RunRecord, JSON.parse(text), 'run_state_invalid');
  } catch {
    throw fail('run_state_invalid');
  }
}

async function save(path, record, isExclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  try {
    if (isExclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function transportError(error, fallback) {
  return fail(['TimeoutError', 'AbortError'].includes(error?.name) ? 'surface_timeout' : fallback);
}

async function request(config, path, body) {
  let response;
  try {
    response = await fetch(`${config.surfaceUrl.replace(/\/$/, '')}${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(config.requestTimeoutMs),
      headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw transportError(error, 'surface_unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw fail(`surface_http_${response.status}`);
  }
  if (body) {
    await response.body?.cancel();
    return undefined;
  }
  try {
    return await response.json();
  } catch (error) {
    throw transportError(error, 'surface_response_invalid');
  }
}

const textOf = message => message.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
const promptIn = (messages, marker) => messages.find(message => message.info.role === 'user' && textOf(message).split('\n').includes(marker));

function answerIn(messages, promptID) {
  const answers = messages.filter(message => message.info.role === 'assistant' && message.info.parentID === promptID);
  const final = answers.findLast(message => message.info.time.completed !== undefined && message.info.finish === 'stop'
    && !message.info.error && textOf(message).trim());
  if (final) return final;
  if (answers.some(message => message.info.error)) throw fail('model_error');
  return undefined;
}

async function monitor(config, context, initial = []) {
  const deadline = performance.now() + config.completionTimeoutMs;
  let messages = initial;
  while (true) {
    const prompt = promptIn(messages, context.marker);
    if (prompt) {
      const answer = answerIn(messages, prompt.info.id);
      const status = { ...context.record, status: answer ? 'completed' : 'monitoring', promptMessageID: prompt.info.id,
        answerMessageID: answer?.info.id, updatedAt: new Date().toISOString() };
      await save(context.path, status);
      if (answer) return status;
    }
    if (performance.now() >= deadline) throw fail('completion_timeout');
    await sleep(Math.min(config.pollMs, Math.max(1, deadline - performance.now())));
    messages = parse(Messages, await request(config, context.messagesPath), 'messages_response_invalid');
  }
}

async function execute(config, context) {
  const previous = await readRecord(context.path);
  if (previous && (previous.marker !== context.marker || previous.owner !== config.owner
    || previous.sessionID !== config.sessionID || previous.surfaceUrl !== config.surfaceUrl)) throw fail('run_identity_changed');
  if (previous?.status === 'completed') return previous;
  const listing = parse(Sessions, await request(config, context.sessionsPath), 'sessions_response_invalid');
  if (!listing.sessions.some(session => session.id === config.sessionID)) throw fail('session_not_found');
  const messages = parse(Messages, await request(config, context.messagesPath), 'messages_response_invalid');
  if (promptIn(messages, context.marker)) return monitor(config, context, messages);
  if (previous?.promptMessageID || ['submitting', 'monitoring'].includes(previous?.status)
    || await readRecord(context.intentPath)) throw fail('submission_ambiguous');
  if (listing.status[config.sessionID] && listing.status[config.sessionID].type !== 'idle') throw fail('session_busy');
  const submitting = { ...context.record, status: 'submitting' };
  try {
    await save(context.intentPath, submitting, true);
  } catch (error) {
    throw error.code === 'EEXIST' ? fail('submission_ambiguous') : error;
  }
  await save(context.path, submitting);
  try {
    await request(config, `${context.sessionsPath}/${encodeURIComponent(config.sessionID)}/prompt`, { text: `${config.prompt}\n\n${context.marker}` });
  } catch (error) {
    throw fail('submission_ambiguous', error.code ?? 'runner_failed');
  }
  return monitor(config, context);
}

export async function runScheduledBriefing(input, options = {}) {
  const config = parseConfig(input);
  const runKey = options.runKey ?? scheduledDate(config, options.now);
  if (!KEY.test(runKey)) throw fail('run_key_invalid');
  const directory = join(config.stateDirectory, config.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = `[onionsoup scheduled briefing: ${config.id}/${runKey}]`;
  const sessionsPath = `/api/owners/${encodeURIComponent(config.owner)}/sessions`;
  const record = { id: config.id, runKey, owner: config.owner, sessionID: config.sessionID, surfaceUrl: config.surfaceUrl,
    marker, status: 'waiting', updatedAt: new Date().toISOString() };
  const context = { record, marker, sessionsPath, messagesPath: `${sessionsPath}/${encodeURIComponent(config.sessionID)}/messages`,
    path: join(directory, `${runKey}.json`), intentPath: join(directory, `${runKey}.intent.json`) };
  try {
    return await execute(config, context);
  } catch (error) {
    const previous = await readRecord(context.path);
    if (previous?.status !== 'completed' && error.code !== 'run_identity_changed') {
      await save(context.path, {
        ...record, ...previous, status: 'failed', error: error.code ?? 'runner_failed',
        causeCode: error.causeCode ?? previous?.causeCode, updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function main() {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, 'run-key': { type: 'string' } }, allowPositionals: false });
    if (!values.config || !isAbsolute(values.config)) throw fail('config_path_required');
    let config;
    try {
      config = JSON.parse(await readFile(values.config, 'utf8'));
    } catch {
      throw fail('config_unreadable');
    }
    console.log(JSON.stringify(await runScheduledBriefing(config, { runKey: values['run-key'] })));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.code ?? 'runner_failed', causeCode: error.causeCode }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
