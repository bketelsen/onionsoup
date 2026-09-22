import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
import { openJobHost, listenJobHost, tokenHash, type Capability, type JobHost } from '../src/index.ts';
import { createJobClient } from '../src/client.ts';

const token = 'a'.repeat(40);
const otherToken = 'b'.repeat(40);
const invokers = [
  { id: 'chat', tokenHash: tokenHash(token), capabilities: ['fixture.read'], maxJobs: 4 },
  { id: 'schedule', tokenHash: tokenHash(otherToken), capabilities: ['fixture.read'], maxJobs: 4 },
];

function capability(execute: Capability['execute']): Capability {
  return {
    id: 'fixture.read',
    version: 'v1',
    description: 'Read fixture',
    input: z.object({ value: z.number().int() }).strict(),
    output: z.object({ value: z.number().int() }).strict(),
    metadata: {},
    effects: ['local_artifacts'],
    timeoutMs: 10000,
    execute,
  };
}
const request = (key = 'first-key', value = 1) => ({ capability: 'fixture.read', input: { value }, idempotencyKey: key });

async function settled(host: JobHost, owner: string, id: string) {
  for (let n = 0; n < 200; n++) {
    const j = await host.inspect(owner, id);
    if (!['queued', 'running'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('Timeout');
}

test('HTTP authentication, strict inputs, owner isolation and concurrent idempotency precede effects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-host-'));
  let effects = 0;
  const host = await openJobHost({ directory, binding: {}, invokers, capabilities: [capability(async (input) => { effects++; return input; })] });
  const server = await listenJobHost(host);
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const client = createJobClient({ url: server.url, token });
  const other = createJobClient({ url: server.url, token: otherToken });

  assert.equal((await fetch(server.url + '/v1/capabilities')).status, 401);
  assert.equal((await fetch(server.url + '/v1/capabilities', { headers: { Origin: 'https://example.invalid' } })).status, 401);
  assert.equal((await client.discover()).remainingAdmissions, 4);
  assert.equal(effects, 0);

  await assert.rejects(client.submit({ ...request(), input: { value: 1, command: 'delete' } }), /invalid_input/);
  await assert.rejects(client.submit({ ...request(), capability: 'fixture.write' }));
  assert.equal(effects, 0);

  const [a, b] = await Promise.all([client.submit(request()), client.submit(request())]);
  assert.equal(a.jobId, b.jobId);
  assert.notEqual(a.reused, b.reused);
  const done = await settled(host, 'chat', a.jobId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { value: 1 });
  assert.equal(effects, 1);

  await assert.rejects(client.submit(request('first-key', 2)), /idempotency_conflict/);
  await assert.rejects(other.inspect(a.jobId));
  await assert.rejects(other.cancel(a.jobId));
  assert.equal((await client.discover()).remainingAdmissions, 3);
  assert.deepEqual(done.events.map((e) => e.status), ['queued', 'running', 'completed']);
  assert.equal((await client.list()).jobs.length, 1);
  assert.equal((await other.list()).jobs.length, 0);

  const ledger = await readFile(join(directory, 'ledger.json'), 'utf8');
  assert.ok(!ledger.includes(token));
  assert.ok(!ledger.includes(otherToken));
});

test('same-origin browser acts as the web invoker, receives events and static files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-web-'));
  const site = join(directory, 'site');
  await mkdir(site);
  await writeFile(join(site, 'index.html'), '<h1>app</h1>');
  await writeFile(join(site, 'app.js'), 'console.log(1)');
  const host = await openJobHost({
    directory: join(directory, 'state'),
    binding: {},
    invokers: [...invokers, { id: 'web', capabilities: ['fixture.read'] }],
    capabilities: [capability(async (input) => input)],
  });
  const server = await listenJobHost(host, { web: { directory: site, invoker: 'web' } });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });

  const origin = server.url;
  assert.equal(await (await fetch(origin + '/')).text(), '<h1>app</h1>');
  assert.equal((await fetch(origin + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await (await fetch(origin + '/jobs/anything')).text(), '<h1>app</h1>');
  assert.equal(await (await fetch(origin + '/../../etc/passwd')).text(), '<h1>app</h1>');

  const discovery = await (await fetch(origin + '/v1/capabilities', { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).json();
  assert.equal(discovery.invoker, 'web');
  assert.equal(discovery.remainingAdmissions, null);
  assert.equal((await fetch(origin + '/v1/capabilities', { headers: { Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 401);

  const stream = await fetch(origin + '/v1/events', { headers: { Origin: origin } });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const submitted = await fetch(origin + '/v1/jobs', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(request('web-key-1', 7)),
  });
  assert.equal(submitted.status, 202);
  const { jobId } = await submitted.json();
  await settled(host, 'web', jobId);

  const reader = stream.body!.getReader();
  let text = '';
  while (!text.includes('"status":"completed"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += Buffer.from(chunk.value).toString();
  }
  await reader.cancel();
  const statuses = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)).status);
  assert.deepEqual(statuses, ['queued', 'running', 'completed']);
  assert.ok(!text.includes('"result"'));
  assert.equal(((await (await fetch(origin + '/v1/jobs', { headers: { Origin: origin } })).json()) as { jobs: unknown[] }).jobs.length, 1);
});

test('restart retains quotas and results, tolerates changed bindings and never replays interrupted jobs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-restart-'));
  let effects = 0;
  const options = { directory, binding: { profile: 1 }, invokers: [{ ...invokers[0], maxJobs: 1 }], capabilities: [capability(async (input) => { effects++; return input; })] };
  let host = await openJobHost(options);
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });

  const admitted = await host.submit('chat', request());
  await settled(host, 'chat', admitted.jobId);
  await host.close();

  host = await openJobHost({ ...options, binding: { profile: 2 } });
  assert.equal((await host.submit('chat', request())).jobId, admitted.jobId);
  await assert.rejects(host.submit('chat', request('second-key')), /admission_limit/);
  assert.equal(effects, 1);
  await host.close();

  const path = join(directory, 'ledger.json');
  const ledger = JSON.parse(await readFile(path, 'utf8'));
  ledger.jobs[0].status = 'running';
  ledger.jobs[0].events.pop();
  delete ledger.jobs[0].resultHash;
  await writeFile(path, JSON.stringify(ledger));
  host = await openJobHost(options);
  const interrupted = await host.inspect('chat', admitted.jobId);
  assert.equal(interrupted.status, 'interrupted');
  assert.match(interrupted.error ?? '', /restarted/);
  assert.equal((await host.submit('chat', request())).reused, true);
  assert.equal(effects, 1);
});

test('queued cancellation and cooperative running cancellation preserve spent admission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-cancel-'));
  let started!: () => void;
  const entered = new Promise<void>((r) => { started = r; });
  const host = await openJobHost({
    directory, binding: {}, invokers, limits: { concurrency: 1 },
    capabilities: [capability(async (_, ctx) => {
      started();
      await new Promise<void>((r) => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener('abort', () => r(), { once: true }); });
      ctx.signal.throwIfAborted();
      return { value: 0 };
    })],
  });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });

  const first = await host.submit('chat', request());
  await entered;
  const second = await host.submit('chat', request('second-key'));
  assert.equal((await host.cancel('chat', second.jobId)).status, 'cancelled');
  await host.cancel('chat', first.jobId);
  assert.equal((await settled(host, 'chat', first.jobId)).status, 'cancelled');
  assert.equal(host.discover('chat').remainingAdmissions, 2);
});

test('failed result persistence stops queued effects and rejects further admission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-storage-'));
  let effects = 0;
  const host = await openJobHost({
    directory, binding: {}, invokers,
    capabilities: [capability(async (input) => { effects++; return input; })],
    persist: async (path, value) => { if (path.endsWith('result.json')) throw Error('private storage detail'); await atomicJson(path, value); },
  });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });

  const j = await host.submit('chat', request());
  assert.equal((await settled(host, 'chat', j.jobId)).status, 'failed');
  await assert.rejects(host.submit('chat', request('second-key')), /host_unavailable/);
  assert.equal(effects, 1);
  assert.ok(!(await readFile(join(directory, 'ledger.json'), 'utf8')).includes('private storage detail'));
});

test('invalid results fail with a recorded reason; foreign parents and modified artifacts are rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-validation-'));
  const host = await openJobHost({ directory, binding: {}, invokers, capabilities: [capability(async (input) => (input.value === 0 ? { unexpected: true } : input))] });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });

  const bad = await host.submit('chat', request('bad-result', 0));
  const failed = await settled(host, 'chat', bad.jobId);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error);
  const good = await host.submit('chat', request('good-result'));
  await settled(host, 'chat', good.jobId);
  await assert.rejects(host.submit('schedule', { ...request(), parentJobId: good.jobId }), /job_not_found/);
  await writeFile(join(directory, good.jobId, 'result.json'), JSON.stringify({ value: 2 }));
  await assert.rejects(host.inspect('chat', good.jobId), /result_mismatch/);
});

test('recipes chain granted capabilities as child jobs, bind results by ID, and stop on failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-recipe-'));
  const calls: unknown[] = [];
  const double: Capability = {
    id: 'fixture.double', version: 'v1', description: 'Double a value', metadata: {}, effects: ['local_artifacts'], timeoutMs: 10000,
    input: z.object({ value: z.number().int(), parent: z.uuid().optional() }).strict(),
    output: z.object({ value: z.number().int() }).strict(),
    execute: async (input) => { calls.push(input); if (input.value > 100) throw new Error('too big'); return { value: input.value * 2 }; },
  };
  const recipe = {
    schemaVersion: 1, id: 'quadruple', title: 'Quadruple', steps: [
      { id: 'first', capability: 'fixture.double', input: { value: { $param: 'start' } } },
      { id: 'second', capability: 'fixture.double', input: { value: { $result: ['first', 'value'] }, parent: { $job: 'first' } } },
    ],
  };
  const host = await openJobHost({ directory, binding: {}, capabilities: [double], recipes: [recipe],
    invokers: [{ id: 'web', capabilities: ['fixture.double'] }, { id: 'limited', tokenHash: tokenHash(token), capabilities: ['fixture.double'], maxJobs: 1 }] });
  const server = await listenJobHost(host, { web: { directory, invoker: 'web' } });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });

  const discovery = host.discover('web');
  const listed = discovery.capabilities.find((c) => c.id === 'recipe.quadruple')!;
  assert.deepEqual(Object.keys((listed.inputSchema as any).properties), ['start']);
  assert.equal((listed.inputSchema as any).properties.start.type, 'integer');

  await assert.rejects(host.submit('web', { capability: 'recipe.quadruple', idempotencyKey: 'missing-param', input: {} }), /missing_param:start/);
  const run = await host.submit('web', { capability: 'recipe.quadruple', idempotencyKey: 'recipe-run-1', input: { start: 3 } });
  const done = await settled(host, 'web', run.jobId);
  assert.equal(done.status, 'completed', done.error);
  const result = done.result as { steps: { id: string; jobId: string; status: string }[] };
  assert.deepEqual(result.steps.map((s) => [s.id, s.status]), [['first', 'completed'], ['second', 'completed']]);
  const second = await host.inspect('web', result.steps[1].jobId);
  assert.deepEqual(second.result, { value: 12 });
  assert.equal(second.parentJobId, run.jobId);
  assert.deepEqual(calls[1], { value: 6, parent: result.steps[0].jobId });

  const failing = await host.submit('web', { capability: 'recipe.quadruple', idempotencyKey: 'recipe-run-2', input: { start: 60 } });
  const failed = await settled(host, 'web', failing.jobId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /step second/);
  assert.equal(calls.length, 4);

  // Saving a recipe over HTTP is operator content bound to granted capabilities.
  const origin = server.url;
  const saved = await fetch(`${origin}/v1/recipes/echo`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, id: 'echo', title: 'Echo', steps: [{ id: 'one', capability: 'fixture.double', input: { value: 1 } }] }) });
  assert.equal(saved.status, 200);
  const rejected = await fetch(`${origin}/v1/recipes/bad`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, id: 'bad', title: 'Bad', steps: [{ id: 'one', capability: 'fixture.other', input: {} }] }) });
  assert.equal(rejected.status, 400);
  const list = await (await fetch(`${origin}/v1/recipes`, { headers: { Origin: origin } })).json() as { recipes: { id: string }[] };
  assert.deepEqual(list.recipes.map((r) => r.id).sort(), ['echo', 'quadruple']);
  assert.ok(await readFile(join(directory, 'recipes', 'echo.json'), 'utf8'));

  // A recipe consumes one admission per child on top of its own; the limited invoker cannot run it.
  await assert.rejects(host.submit('limited', { capability: 'recipe.quadruple', idempotencyKey: 'limited-run', input: { start: 1 } }).then((r) => settled(host, 'limited', r.jobId)).then((j) => { if (j.status !== 'failed') throw new Error('expected failure'); return Promise.reject(new Error(j.error)); }), /admission_limit/);
});

test('tailnet users are identified by the local proxy header and mapped to invokers; funnel and spoofed hosts are refused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-tailscale-'));
  const site = join(directory, 'site');
  await mkdir(site);
  await writeFile(join(site, 'index.html'), '<h1>app</h1>');
  const host = await openJobHost({
    directory: join(directory, 'state'), binding: {},
    invokers: [{ id: 'web', capabilities: ['fixture.read'] }, { id: 'brian', capabilities: ['fixture.read'] }],
    capabilities: [capability(async (input) => input)],
  });
  const server = await listenJobHost(host, { web: { directory: site, invoker: 'web' }, tailscale: { users: { 'brian@github': 'brian' } } });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const port = Number(new URL(server.url).port);
  const tailnet = 'onionsoup.tail1234.ts.net';
  // fetch() will not send a custom Host header, so speak raw HTTP the way the tailscaled proxy would.
  const discover = (headers: Record<string, string>) => new Promise<{ status: number; body: any }>((resolveRequest, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/v1/capabilities', method: 'GET', headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
    });
    request.on('error', reject);
    request.end();
  });

  // Local operator on loopback keeps working without any identity header.
  assert.equal((await discover({ Host: `127.0.0.1:${port}`, Origin: server.url })).body.invoker, 'web');
  // Through tailscale serve: the proxy is on loopback and adds the login header.
  const viaProxy = await discover({ Host: tailnet, Origin: `https://${tailnet}`, 'Tailscale-User-Login': 'brian@github' });
  assert.equal(viaProxy.status, 200);
  assert.equal(viaProxy.body.invoker, 'brian');
  assert.equal(viaProxy.body.login, 'brian@github');
  // Funnel or an unknown tailnet user: no mapping, no access.
  assert.equal((await discover({ Host: tailnet, Origin: `https://${tailnet}` })).status, 401);
  assert.equal((await discover({ Host: tailnet, Origin: `https://${tailnet}`, 'Tailscale-User-Login': 'stranger@github' })).status, 403);
  await assert.rejects(listenJobHost(host, { web: { directory: site, invoker: 'web' }, tailscale: { users: { 'x@github': 'nobody' } } }), /unknown_tailscale_invoker/);
});

test('a completed job records the capability\'s own outcome so lists can show failed work without loading results', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-outcome-'));
  const judged: Capability = { ...capability(async (input) => input), outcome: (result) => ({ status: result.value > 0 ? 'ok' : 'failed', label: result.value > 0 ? 'positive' : 'non-positive' }) };
  const host = await openJobHost({ directory, binding: {}, invokers, capabilities: [judged] });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const good = await settled(host, 'chat', (await host.submit('chat', request('outcome-good', 3))).jobId);
  const bad = await settled(host, 'chat', (await host.submit('chat', request('outcome-bad', 0))).jobId);
  assert.equal(good.status, 'completed');
  assert.deepEqual(good.outcome, { status: 'ok', label: 'positive' });
  assert.equal(bad.status, 'completed');
  assert.deepEqual(bad.outcome, { status: 'failed', label: 'non-positive' });
  assert.deepEqual(host.list('chat').map((j) => j.outcome?.status), ['failed', 'ok']);
});
