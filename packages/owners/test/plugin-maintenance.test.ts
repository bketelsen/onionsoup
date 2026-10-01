import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { beginAdmission, listAdmissions } from '../src/deployment-admission.ts';
import { MaintenanceOperation, PluginMaintenance, type MaintenancePass } from '../src/plugin-maintenance.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('maintenance fixture did not reach its expected durable boundary');
}

function sessionClient(methods: Record<string, (options: { signal: AbortSignal }) => Promise<unknown>>) {
  return { session: methods } as unknown as Parameters<MaintenancePass['client']>[0];
}

async function fixture(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'plugin-maintenance-'));
  const callbacks: Array<() => Promise<void>> = [];
  const intervals = globalThis.setInterval;
  const controllers: PluginMaintenance[] = [];
  const create = () => {
    const controller = new PluginMaintenance(home, '/fixture', { budgetMs: 2_000, disposeMs: 20, effectTimeoutMs: 1_000 });
    controllers.push(controller);
    return controller;
  };
  context.after(async () => { for (const controller of controllers) await controller.dispose(); });
  const maintenance = create();
  const errors: unknown[] = [];
  const record = async (controller = maintenance, kind = 'plugin:notices') => MaintenanceOperation.parse(JSON.parse(
    await readFile(join(home, 'plugin-maintenance', controller.instanceID, `${kind.replaceAll(':', '-')}.json`), 'utf8')));
  return { home, callbacks, maintenance, create, errors, record,
    start: (operation: (pass: MaintenancePass) => Promise<unknown>, controller = maintenance) => {
      globalThis.setInterval = ((callback: () => Promise<void>) => {
        callbacks.push(callback);
        return { unref() {} } as NodeJS.Timeout;
      }) as typeof setInterval;
      try { controller.start('plugin:notices', 100, operation, error => errors.push(error)); }
      finally { globalThis.setInterval = intervals; }
    } };
}

test('one timer runs one admitted pass at a time with durable instance and operation identity', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  setup.start(async pass => {
    calls++;
    await pass.phase('fixture-read', async () => { entered.resolve(); await gate.promise; });
  });
  const running = setup.callbacks[0]!();
  await entered.promise;
  const before = await setup.record();
  assert.equal(before.status, 'running');
  assert.equal(before.phase, 'fixture-read');
  assert.equal(before.instanceID, setup.maintenance.instanceID);
  assert.equal(before.admission?.maintenance?.instanceID, before.instanceID);
  assert.equal(before.admission?.maintenance?.operationID, before.operationID);
  await setup.callbacks[0]!();
  assert.equal(calls, 1);
  assert.equal((await listAdmissions(setup.home)).length, 1);
  gate.resolve();
  await running;
  assert.equal((await setup.record()).status, 'released');
  assert.deepEqual(await listAdmissions(setup.home), []);
  await setup.maintenance.dispose();
  await setup.callbacks[0]!();
  assert.equal(calls, 1);
});

test('dispose aborts a cooperative pending read and releases only after it actually settles', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  let aborted = false;
  let effects = 0;
  setup.start(async pass => {
    const client = pass.client(sessionClient({ get: options => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
      entered.resolve();
    }), promptAsync: async () => { effects++; return {}; } }));
    await client.session.get({ path: { id: 'fixture' } });
    await client.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } });
  });
  const running = setup.callbacks[0]!();
  await entered.promise;
  await setup.maintenance.dispose();
  await running;
  assert.equal(aborted, true);
  assert.equal(effects, 0);
  assert.equal((await setup.record()).status, 'released');
  assert.deepEqual(await listAdmissions(setup.home), []);
});

test('bounded dispose retains an abort-ignoring read and fences its late follow-up effect', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const gate = deferred<unknown>();
  let signal: AbortSignal | undefined;
  let effects = 0;
  setup.start(async pass => {
    const client = pass.client(sessionClient({ get: async options => {
      signal = options.signal;
      entered.resolve();
      return gate.promise;
    }, promptAsync: async () => { effects++; return {}; } }));
    await client.session.get({ path: { id: 'fixture' } });
    await client.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } });
  });
  const running = setup.callbacks[0]!();
  await entered.promise;
  let expired = false;
  const bound = setTimeout(() => { expired = true; gate.resolve({}); }, 1_000);
  await setup.maintenance.dispose();
  clearTimeout(bound);
  assert.equal(expired, false, 'dispose must return without treating the unresolved read as complete');
  assert.equal(signal?.aborted, true);
  assert.equal((await listAdmissions(setup.home)).length, 1);
  const pending = await setup.record();
  assert.equal(pending.status, 'stopping');
  assert.equal(pending.calls.length, 1);
  assert.equal(pending.calls[0]!.status, 'pending');
  gate.resolve({ data: { id: 'fixture' } });
  await running;
  assert.equal(effects, 0);
  assert.equal((await setup.record()).status, 'released');
  assert.deepEqual(await listAdmissions(setup.home), []);
});

test('a rejected concurrent SDK read does not release its still-pending sibling', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const gate = deferred<unknown>();
  setup.start(async pass => {
    const client = pass.client(sessionClient({
      get: async () => { await entered.promise; throw new Error('fixture_read_failed'); },
      status: async () => { entered.resolve(); return gate.promise; },
    }));
    await Promise.all([client.session.get({ path: { id: 'fixture' } }), client.session.status()]);
  });
  const running = setup.callbacks[0]!();
  await entered.promise;
  await eventually(async () => (await setup.record()).calls.length === 1);
  assert.equal((await listAdmissions(setup.home)).length, 1);
  await setup.maintenance.dispose();
  assert.equal((await listAdmissions(setup.home)).length, 1);
  gate.resolve({ data: {} });
  await running;
  assert.equal((await setup.record()).status, 'released');
  assert.deepEqual(await listAdmissions(setup.home), []);
});

for (const response of ['rejection', 'error-response'] as const) {
  test(`an invoked effect with ${response} retains its uncertain admission through disposal`, async context => {
    const setup = await fixture(context);
    let effects = 0;
    setup.start(async pass => {
      const client = pass.client(sessionClient({ promptAsync: async () => {
        effects++;
        if (response === 'rejection') throw new Error('fixture_ack_lost');
        return { error: { message: 'fixture_ack_lost' } };
      } }));
      await client.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } });
    });
    await setup.callbacks[0]!();
    const uncertain = await setup.record();
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.calls[0]!.effect, true);
    assert.equal(uncertain.calls[0]!.status, 'uncertain');
    await Promise.all([setup.maintenance.dispose(), setup.maintenance.dispose()]);
    assert.equal(effects, 1);
    assert.equal((await listAdmissions(setup.home))[0]!.id, uncertain.admission!.id);
    assert.equal((await setup.record()).operationID, uncertain.operationID);
  });
}

test('a late successful effect can persist its receipt but cannot start another effect', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const gate = deferred<unknown>();
  let effects = 0;
  const receipt = join(setup.home, 'fixture-receipt.json');
  setup.start(async pass => {
    const client = pass.client(sessionClient({ promptAsync: async () => {
      effects++;
      entered.resolve();
      return gate.promise;
    } }));
    const completed = await client.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } });
    await writeFile(receipt, JSON.stringify(completed));
    await client.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } });
  });
  const running = setup.callbacks[0]!();
  await entered.promise;
  await setup.maintenance.dispose();
  assert.equal((await listAdmissions(setup.home)).length, 1);
  gate.resolve({ data: { id: 'confirmed-fixture-receipt' } });
  await running;
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { data: { id: 'confirmed-fixture-receipt' } });
  assert.equal(effects, 1);
  assert.equal((await setup.record()).status, 'released');
  assert.deepEqual(await listAdmissions(setup.home), []);
});

test('a durable domain fence preserves an uncertain operation while later passes and a replacement do unrelated work', async context => {
  const setup = await fixture(context);
  const claimPath = join(setup.home, 'fixture-domain-notice-claim.json');
  let effects = 0;
  let unrelatedReads = 0;
  const operation = async (pass: MaintenancePass) => {
    const client = pass.client(sessionClient({
      promptAsync: async () => { effects++; throw new Error('fixture_notice_ack_lost'); },
      status: async () => { unrelatedReads++; return { data: {} }; },
    }));
    await pass.phase('fixture-domain-notice', async () => {
      const existing = await readFile(claimPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (existing) {
        assert.deepEqual(JSON.parse(existing), { status: 'sending', id: 'fixture-notice' });
        return;
      }
      await writeFile(claimPath, JSON.stringify({ status: 'sending', id: 'fixture-notice' }), { flag: 'wx' });
      await client.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } });
    });
    await pass.phase('unrelated-status', async () => { await client.session.status(); });
  };
  setup.start(operation);
  await setup.callbacks[0]!();
  const uncertain = await setup.record();
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(effects, 1);
  assert.equal(unrelatedReads, 0);
  const leasePath = join(setup.home, 'deploy', 'leases', `${uncertain.admission!.id}.json`);
  const exactLease = await readFile(leasePath, 'utf8');
  await setup.callbacks[0]!();
  const next = await setup.record();
  assert.equal(next.status, 'released');
  assert.notEqual(next.operationID, uncertain.operationID);
  assert.equal(unrelatedReads, 1);
  const archivePath = join(setup.home, 'plugin-maintenance', setup.maintenance.instanceID, 'uncertain', `${uncertain.operationID}.json`);
  const exactArchive = await readFile(archivePath, 'utf8');
  assert.deepEqual(MaintenanceOperation.parse(JSON.parse(exactArchive)), uncertain);
  assert.equal(await readFile(leasePath, 'utf8'), exactLease);
  const replacement = setup.create();
  setup.start(operation, replacement);
  await setup.callbacks[1]!();
  await Promise.all([setup.maintenance.dispose(), replacement.dispose()]);
  assert.equal((await setup.record(replacement)).status, 'released');
  assert.equal(unrelatedReads, 2);
  assert.equal(effects, 1);
  assert.equal(await readFile(archivePath, 'utf8'), exactArchive);
  assert.equal(await readFile(leasePath, 'utf8'), exactLease);
  assert.deepEqual((await listAdmissions(setup.home)).map(lease => lease.id), [uncertain.admission!.id]);
});

test('a completed handler cannot use a leaked pass or SDK client to start late reads or effects', async context => {
  const setup = await fixture(context);
  let savedPass: MaintenancePass | undefined;
  let savedClient: ReturnType<MaintenancePass['client']> | undefined;
  let reads = 0;
  let effects = 0;
  let phases = 0;
  setup.start(async pass => {
    savedPass = pass;
    savedClient = pass.client(sessionClient({
      get: async () => { reads++; return { data: {} }; },
      promptAsync: async () => { effects++; return {}; },
    }));
    await savedClient.session.get({ path: { id: 'fixture' } });
  });
  await setup.callbacks[0]!();
  const completed = await setup.record();
  assert.equal(completed.status, 'released');
  assert.throws(() => savedPass!.check(), /plugin_maintenance_stopped/);
  const attempts = await Promise.allSettled([
    savedPass!.phase('late-phase', async () => { phases++; }),
    savedClient!.session.get({ path: { id: 'fixture' } }),
    savedClient!.session.promptAsync({ path: { id: 'fixture' }, body: { parts: [] } }),
  ]);
  assert.ok(attempts.every(attempt => attempt.status === 'rejected'
    && attempt.reason instanceof Error && ['plugin_maintenance_stopped', 'plugin_maintenance_effect_not_started'].includes(attempt.reason.message)));
  assert.equal(reads, 1);
  assert.equal(effects, 0);
  assert.equal(phases, 0);
  assert.deepEqual(await setup.record(), completed);
  assert.deepEqual(await listAdmissions(setup.home), []);
});

test('the same instance retries terminal admission cleanup without starting another operation', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const gate = deferred();
  let operations = 0;
  setup.start(async () => { operations++; entered.resolve(); await gate.promise; });
  const running = setup.callbacks[0]!();
  await entered.promise;
  const before = await setup.record();
  const lease = join(setup.home, 'deploy', 'leases', `${before.admission!.id}.json`);
  const saved = join(setup.home, 'fixture-saved-lease.json');
  await rename(lease, saved);
  await mkdir(lease);
  gate.resolve();
  await running;
  assert.equal((await setup.record()).status, 'settled');
  assert.equal(setup.errors.length, 1);
  await rm(lease, { recursive: true });
  await rename(saved, lease);
  await Promise.all([setup.maintenance.dispose(), setup.maintenance.dispose()]);
  await eventually(async () => (await setup.record()).status === 'released');
  assert.deepEqual(await listAdmissions(setup.home), []);
  assert.equal(operations, 1);
  assert.equal((await setup.record()).operationID, before.operationID);
});

test('a replacement instance releases only its own work and leaves uncertain and legacy admissions untouched', async context => {
  const setup = await fixture(context);
  const legacy = await beginAdmission(setup.home, 'plugin:notices');
  setup.start(async pass => {
    const client = pass.client(sessionClient({ create: async () => { throw new Error('fixture_create_ack_lost'); } }));
    await client.session.create({ body: { title: 'fixture' } });
  });
  await setup.callbacks[0]!();
  const uncertain = await setup.record();
  const replacement = setup.create();
  setup.start(async pass => { await pass.phase('fresh-read', async () => undefined); }, replacement);
  await setup.callbacks[1]!();
  assert.notEqual(replacement.instanceID, setup.maintenance.instanceID);
  assert.equal((await setup.record(replacement)).status, 'released');
  await Promise.all([setup.maintenance.dispose(), replacement.dispose()]);
  const retained = (await listAdmissions(setup.home)).map(lease => lease.id).sort();
  assert.deepEqual(retained, [legacy.id, uncertain.admission!.id].sort());
  assert.deepEqual(await setup.record(), uncertain);
  await legacy.release();
});
