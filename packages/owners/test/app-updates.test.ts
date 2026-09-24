import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_UPDATE_LIMITS, reconcileAppUpdate, reviewAppUpdates, updateApp } from '../src/app-updates.ts';
import { processRequests } from '../src/brokering.ts';
import { Runtime } from '../src/runtime.ts';

async function nasRuntime() {
  const runtime = await Runtime.open({
    declarations: 'packages/owners/test/fixtures/owners',
    state: await mkdtemp(join(tmpdir(), 'owners-apps-')),
  });
  await runtime.notebook('moneo').ensure('# Charter\n');
  return runtime;
}

async function approvedUpdate(runtime: Runtime, overrides = {}) {
  const request = await runtime.requests.open('moneo', 'moneo', {
    kind: 'update-app', app: 'radarr', fromVersion: '1', toVersion: '1', imageUpdates: true,
    purpose: 'image patch', notesRead: [], ...overrides,
  }, 'none');
  return runtime.requests.save({ ...request, status: 'create-approved' });
}

const app = (imageUpdates: boolean, version = '1') => ({
  name: 'radarr', state: 'RUNNING', version, image_updates_available: imageUpdates, upgrade_available: false,
});

function scriptNas(runtime: Runtime, options: {
  states: ReturnType<typeof app>[];
  jobs?: string[];
  existing?: boolean;
  missingJob?: boolean;
  startError?: boolean;
}) {
  let statusReads = 0;
  let jobReads = 0;
  let hasStarted = options.existing ?? false;
  const writes: string[] = [];
  runtime.truenasSsh = async (_domain, command) => {
    writes.push(command);
    if (options.startError) throw new Error('image_pull_denied');
    hasStarted = true;
    return '42';
  };
  runtime.truenas = async (_domain, _writes, use) => use(async (tool, args) => {
    const handlers: Record<string, () => unknown> = {
      truenas_app_get: () => [options.states[Math.min(statusReads++, options.states.length - 1)]],
      truenas_jobs_list: () => {
        assert.ok(['app.upgrade', 'app.pull_images'].includes(String(args?.method)));
        if (!hasStarted || options.missingJob) return [];
        const states = options.jobs ?? ['RUNNING', 'SUCCESS'];
        return [{ id: 42, state: states[Math.min(jobReads++, states.length - 1)], arguments: ['radarr'] }];
      },
      truenas_app_update: () => {
        writes.push(tool);
        hasStarted = true;
        return { job_id: 42 };
      },
    };
    assert.ok(handlers[tool], tool);
    return JSON.stringify(handlers[tool]!());
  });
  return writes;
}

test('image-only approved request pulls and redeploys images, follows job, then persists updated', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime);
  const writes = scriptNas(runtime, { states: [app(true), app(false)] });
  const previous = APP_UPDATE_LIMITS.pollMs;
  APP_UPDATE_LIMITS.pollMs = 1;
  try {
    await processRequests(runtime);
    assert.equal((await runtime.requests.get(request.id)).status, 'updated');
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /sudo -n midclt call app.pull_images '"radarr"' '\{"redeploy":true\}'/);
  } finally {
    APP_UPDATE_LIMITS.pollMs = previous;
  }
});

test('update completion requires a successful job and image completion, not just equal versions', async () => {
  for (const scenario of [
    { name: 'failed job', states: [app(true), app(false)], jobs: ['FAILED'] },
    { name: 'missing job', states: [app(true), app(false)], missingJob: true },
    { name: 'images still pending', states: [app(true)], jobs: ['SUCCESS'] },
    { name: 'image command failed', states: [app(true)], startError: true },
  ]) {
    const runtime = await nasRuntime();
    const request = await approvedUpdate(runtime);
    scriptNas(runtime, scenario);
    const previous = { ...APP_UPDATE_LIMITS };
    Object.assign(APP_UPDATE_LIMITS, { pollMs: 1, updateWaitMs: 12 });
    try {
      await processRequests(runtime);
      const failed = await runtime.requests.get(request.id);
      assert.equal(failed.status, 'failed', scenario.name);
      assert.match(failed.reason!, /failed/, scenario.name);
    } finally {
      Object.assign(APP_UPDATE_LIMITS, previous);
    }
  }
});

test('catalog update reuses an existing job and recovery checks recorded success read-only', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime, { toVersion: '2', imageUpdates: false });
  const writes = scriptNas(runtime, { states: [app(false), app(false, '2')], existing: true });
  const previous = APP_UPDATE_LIMITS.pollMs;
  APP_UPDATE_LIMITS.pollMs = 1;
  let recorded: number | undefined;
  try {
    await updateApp(runtime, request, { onJobStarted: async jobId => { recorded = jobId; } });
    assert.equal(recorded, 42);
    assert.match((await reconcileAppUpdate(runtime, request, recorded))!, /job 42/);
    assert.equal(await reconcileAppUpdate(runtime, request), undefined);
    assert.deepEqual(writes, []);
  } finally {
    APP_UPDATE_LIMITS.pollMs = previous;
  }
});

test('an already updated image request is idempotent', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime);
  const writes = scriptNas(runtime, { states: [app(false)] });
  await processRequests(runtime);
  assert.equal((await runtime.requests.get(request.id)).status, 'updated');
  assert.deepEqual(writes, []);
});

test('duty preserves image intent in the persisted update request', async () => {
  const runtime = await nasRuntime();
  runtime.truenas = async (_domain, _writes, use) => use(async () => JSON.stringify([app(true)]));
  runtime.hire = async (_ownerId, request) => ({
    value: request.schema.parse({ apps: [{ name: 'radarr', decision: 'update', reason: 'safe', notesRead: [] }] }),
    sessionID: 'test', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), cost: 0,
  });
  const reviewed = await reviewAppUpdates(runtime, 'moneo', {
    id: 'apps', kind: 'app-updates', every: '1d', instructions: 'review', raises: 'attention',
  });
  assert.equal(reviewed.opened.length, 1);
  const persisted = await runtime.requests.get(reviewed.opened[0]!.id);
  assert.equal(persisted.ask.kind, 'update-app');
  if (persisted.ask.kind === 'update-app') assert.equal(persisted.ask.imageUpdates, true);
});
