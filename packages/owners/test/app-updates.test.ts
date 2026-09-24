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
  method?: string;
  transientPoll?: boolean;
}) {
  let statusReads = 0;
  let jobReads = 0;
  let hasStarted = options.existing ?? false;
  let method = options.method ?? 'app.pull_images';
  let hasPollFailed = false;
  const writes: string[] = [];
  runtime.truenasSsh = async (_domain, command) => {
    writes.push(command);
    if (options.startError) throw new Error('image_pull_denied');
    hasStarted = true;
    method = 'app.pull_images';
    return '42';
  };
  runtime.truenas = async (_domain, _writes, use) => use(async (tool, args) => {
    const handlers: Record<string, () => unknown> = {
      truenas_app_get: () => [options.states[Math.min(statusReads++, options.states.length - 1)]],
      truenas_jobs_list: () => {
        assert.ok(['app.upgrade', 'app.pull_images'].includes(String(args?.method)));
        if (args?.method !== method) return [];
        if (hasStarted && options.transientPoll && !hasPollFailed) {
          hasPollFailed = true;
          throw new Error('temporary_connection_failure');
        }
        if (!hasStarted || options.missingJob) return [];
        const states = options.jobs ?? ['RUNNING', 'SUCCESS'];
        return [{ id: 42, method, state: states[Math.min(jobReads++, states.length - 1)], arguments: ['radarr'] }];
      },
      truenas_app_update: () => {
        writes.push(tool);
        method = 'app.upgrade';
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
    { name: 'failed job', states: [app(true), app(false)], jobs: ['FAILED'], reason: /app_upgrade_failed/ },
    { name: 'missing job', states: [app(true), app(false)], missingJob: true, reason: /app_upgrade_unsettled/ },
    { name: 'images still pending', states: [app(true)], jobs: ['SUCCESS'], reason: /app_upgrade_unsettled/ },
    { name: 'image command failed', states: [app(true)], startError: true, reason: /image_pull_denied/ },
  ]) {
    const runtime = await nasRuntime();
    const request = await approvedUpdate(runtime);
    const writes = scriptNas(runtime, scenario);
    const previous = { ...APP_UPDATE_LIMITS };
    Object.assign(APP_UPDATE_LIMITS, { pollMs: 1, updateWaitMs: 12 });
    try {
      await processRequests(runtime);
      const failed = await runtime.requests.get(request.id);
      assert.equal(failed.status, 'interrupted', scenario.name);
      assert.equal(failed.operation?.stage, 'create-approved', scenario.name);
      assert.match(failed.reason!, scenario.reason, scenario.name);
      assert.equal(writes.length, 1);
    } finally {
      Object.assign(APP_UPDATE_LIMITS, previous);
    }
  }
});

test('catalog update reuses an existing job and recovery checks recorded success read-only', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime, { toVersion: '2', imageUpdates: false });
  const writes = scriptNas(runtime, { states: [app(false), app(false, '2')], existing: true, method: 'app.upgrade' });
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


test('catalog starter executes the upgrade and transient poll failures do not abandon its job', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime, { toVersion: '2', imageUpdates: false });
  const writes = scriptNas(runtime, {
    states: [app(false), app(false, '2')], transientPoll: true,
  });
  const previous = APP_UPDATE_LIMITS.pollMs;
  APP_UPDATE_LIMITS.pollMs = 1;
  try {
    await processRequests(runtime);
    assert.equal((await runtime.requests.get(request.id)).status, 'updated');
    assert.deepEqual(writes, ['truenas_app_update']);
  } finally {
    APP_UPDATE_LIMITS.pollMs = previous;
  }
});

test('mixed catalog and image update checkpoints both jobs and pulls images left after upgrade', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime, { toVersion: '2' });
  const writes: string[] = [];
  let version = '1';
  let hasImages = true;
  const jobs: { id: number; method: string; state: string; arguments: string[] }[] = [];
  runtime.truenas = async (_domain, _writes, use) => use(async tool => {
    const handlers: Record<string, () => unknown> = {
      truenas_app_get: () => [app(hasImages, version)],
      truenas_jobs_list: () => jobs,
      truenas_app_update: () => {
        writes.push('upgrade');
        version = '2';
        jobs.push({ id: 42, method: 'app.upgrade', state: 'SUCCESS', arguments: ['radarr'] });
        return { job_id: 42 };
      },
    };
    return JSON.stringify(handlers[tool]!());
  });
  runtime.truenasSsh = async () => {
    writes.push('pull');
    hasImages = false;
    jobs.push({ id: 43, method: 'app.pull_images', state: 'SUCCESS', arguments: ['radarr'] });
    return '43';
  };
  const previous = APP_UPDATE_LIMITS.pollMs;
  APP_UPDATE_LIMITS.pollMs = 1;
  const checkpointed: number[] = [];
  try {
    const settled = await updateApp(runtime, request, { onJobStarted: async jobId => { checkpointed.push(jobId); } });
    await runtime.requests.save({ ...request, status: 'updated', reason: settled });
    assert.deepEqual(writes, ['upgrade', 'pull']);
    assert.deepEqual(checkpointed, [42, 43]);
    assert.match((await runtime.requests.get(request.id)).reason!, /version 2, image updates false/);
    assert.match((await reconcileAppUpdate(runtime, request, 43))!, /job 43/);
  } finally {
    APP_UPDATE_LIMITS.pollMs = previous;
  }
});

test('absent image evidence cannot silently confirm an image update', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime);
  runtime.truenas = async (_domain, _writes, use) => use(async tool => JSON.stringify(
    tool === 'truenas_jobs_list'
      ? [{ id: 42, method: 'app.pull_images', state: 'SUCCESS', arguments: ['radarr'] }]
      : [{ name: 'radarr', state: 'RUNNING', version: '1' }],
  ));
  assert.equal(await reconcileAppUpdate(runtime, request, 42), undefined);
});


test('a catalog request waits for an existing image pull before starting the required upgrade', async () => {
  const runtime = await nasRuntime();
  const request = await approvedUpdate(runtime, { toVersion: '2', imageUpdates: false });
  let version = '1';
  let activeReads = 0;
  let hasUpgrade = false;
  const writes: string[] = [];
  runtime.truenas = async (_domain, _writes, use) => use(async (tool, args) => {
    const handlers: Record<string, () => unknown> = {
      truenas_app_get: () => [app(false, version)],
      truenas_jobs_list: () => {
        if (args?.method === 'app.pull_images') {
          const state = activeReads++ === 0 ? 'RUNNING' : 'SUCCESS';
          return [{ id: 41, method: 'app.pull_images', state, arguments: ['radarr'] }];
        }
        return hasUpgrade ? [{ id: 42, method: 'app.upgrade', state: 'SUCCESS', arguments: ['radarr'] }] : [];
      },
      truenas_app_update: () => {
        assert.ok(activeReads > 1, 'existing pull must finish before upgrading');
        writes.push('upgrade');
        version = '2';
        hasUpgrade = true;
        return { job_id: 42 };
      },
    };
    return JSON.stringify(handlers[tool]!());
  });
  const previous = APP_UPDATE_LIMITS.pollMs;
  APP_UPDATE_LIMITS.pollMs = 1;
  try {
    await processRequests(runtime);
    assert.equal((await runtime.requests.get(request.id)).status, 'updated');
    assert.deepEqual(writes, ['upgrade']);
  } finally {
    APP_UPDATE_LIMITS.pollMs = previous;
  }
});
