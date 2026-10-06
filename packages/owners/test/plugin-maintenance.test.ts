import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { listAdmissions } from '../src/deployment-admission.ts';
import { PluginMaintenance, type MaintenancePass } from '../src/plugin-maintenance.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function sessionClient(methods: Record<string, (options: { signal: AbortSignal }) => Promise<unknown>>) {
  return { session: methods } as unknown as Parameters<MaintenancePass['client']>[0];
}

function captureTimers(register: () => void) {
  const callbacks: Array<() => Promise<void>> = [];
  const intervals = globalThis.setInterval;
  globalThis.setInterval = ((callback: () => Promise<void>) => {
    callbacks.push(callback);
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setInterval;
  try { register(); }
  finally { globalThis.setInterval = intervals; }
  return callbacks;
}

async function fixture(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'plugin-maintenance-'));
  const maintenance = new PluginMaintenance(home, { budgetMs: 2_000, disposeMs: 20, effectTimeoutMs: 1_000 });
  context.after(() => maintenance.dispose());
  const errors: unknown[] = [];
  let tick!: () => Promise<void>;
  return { home, maintenance, errors, tick: () => tick(),
    start: (operation: (pass: MaintenancePass) => Promise<unknown>) => {
      [tick] = captureTimers(() => maintenance.start('plugin:fixture', 100, operation, error => errors.push(error)));
    } };
}

test('one timer runs one admitted pass at a time and releases its lease when the pass ends', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  setup.start(async pass => {
    calls++;
    await pass.phase('fixture-read', async () => { entered.resolve(); await gate.promise; });
  });
  const running = setup.tick();
  await entered.promise;
  assert.deepEqual((await listAdmissions(setup.home)).map(lease => lease.kind), ['plugin:fixture']);
  await setup.tick();
  assert.equal(calls, 1);
  gate.resolve();
  await running;
  assert.deepEqual(await listAdmissions(setup.home), []);
  await setup.maintenance.dispose();
  await setup.tick();
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
  const running = setup.tick();
  await entered.promise;
  await setup.maintenance.dispose();
  await running;
  assert.equal(aborted, true);
  assert.equal(effects, 0);
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
  const running = setup.tick();
  await entered.promise;
  let expired = false;
  const bound = setTimeout(() => { expired = true; gate.resolve({}); }, 1_000);
  await setup.maintenance.dispose();
  clearTimeout(bound);
  assert.equal(expired, false, 'dispose must return without treating the unresolved read as complete');
  assert.equal(signal?.aborted, true);
  assert.equal((await listAdmissions(setup.home)).length, 1);
  gate.resolve({ data: { id: 'fixture' } });
  await running;
  assert.equal(effects, 0);
  assert.deepEqual(await listAdmissions(setup.home), []);
});

test('a rejected concurrent SDK read does not release its still-pending sibling', async context => {
  const setup = await fixture(context);
  const entered = deferred();
  const failed = deferred();
  const gate = deferred<unknown>();
  setup.start(async pass => {
    const client = pass.client(sessionClient({
      get: async () => {
        await entered.promise;
        failed.resolve();
        throw new Error('fixture_read_failed');
      },
      status: async () => { entered.resolve(); return gate.promise; },
    }));
    await Promise.all([client.session.get({ path: { id: 'fixture' } }), client.session.status()]);
  });
  const running = setup.tick();
  await failed.promise;
  await nextTurn();
  assert.equal((await listAdmissions(setup.home)).length, 1);
  await setup.maintenance.dispose();
  assert.equal((await listAdmissions(setup.home)).length, 1);
  gate.resolve({ data: {} });
  await running;
  assert.match(String(setup.errors[0]), /fixture_read_failed/);
  assert.deepEqual(await listAdmissions(setup.home), []);
});

for (const response of ['rejection', 'error-response'] as const) {
  test(`an invoked effect with ${response} is reported uncertain and its pass still releases its lease`, async context => {
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
    await setup.tick();
    assert.equal(effects, 1);
    assert.match(String(setup.errors[0]), /plugin_maintenance_effect_uncertain/);
    assert.deepEqual(await listAdmissions(setup.home), []);
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
  const running = setup.tick();
  await entered.promise;
  await setup.maintenance.dispose();
  assert.equal((await listAdmissions(setup.home)).length, 1);
  gate.resolve({ data: { id: 'confirmed-fixture-receipt' } });
  await running;
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { data: { id: 'confirmed-fixture-receipt' } });
  assert.equal(effects, 1);
  assert.match(String(setup.errors[0]), /plugin_maintenance_effect_not_started/);
  assert.deepEqual(await listAdmissions(setup.home), []);
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
  await setup.tick();
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
  assert.deepEqual(await listAdmissions(setup.home), []);
});

test('one instance per process runs a process-wide kind; the next takes over when it is disposed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-maintenance-'));
  const runs: string[] = [];
  const first = new PluginMaintenance(home);
  const second = new PluginMaintenance(home);
  const callbacks = captureTimers(() => {
    first.start('plugin:notices', 100, async () => { runs.push('first'); }, error => { throw error; }, false);
    second.start('plugin:notices', 100, async () => { runs.push('second'); }, error => { throw error; }, false);
  });
  await callbacks[0]!();
  await callbacks[1]!();
  assert.deepEqual(runs, ['first']);
  await first.dispose();
  await callbacks[1]!();
  assert.deepEqual(runs, ['first', 'second']);
  await second.dispose();
});
