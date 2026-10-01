import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MaintenanceQuarantine, maintenanceQuarantineDigest, maintenanceQuarantinePath, readMaintenanceQuarantine,
  maintenanceQuarantineStatus, acknowledgeMaintenanceQuarantine, maintenanceQuarantineAckPath,
  maintenanceRuntimeBuildId, type MaintenanceQuarantineBody } from '../src/maintenance-quarantine.ts';
import { beginAdmission, listAdmissions } from '../src/deployment-admission.ts';
import { PluginMaintenance } from '../src/plugin-maintenance.ts';
import { daemon, tick, Background } from '../src/daemon.ts';
import { Runtime } from '../src/runtime.ts';
import plugin from '../src/plugin.ts';

const target = 'a'.repeat(40);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'maintenance-quarantine-'));
  await mkdir(join(home, 'deploy'));
  const body: MaintenanceQuarantineBody = { version: 1, recoveryDigest: 'c'.repeat(64), targetBuildId: target,
    oldBuildId: 'b'.repeat(40), admissions: [{ id: randomUUID(), kind: 'plugin:notices', pid: process.pid, startTime: '1' }],
    createdAt: new Date().toISOString() };
  const marker = { ...body, digest: maintenanceQuarantineDigest(body) };
  const save = () => writeFile(maintenanceQuarantinePath(home), JSON.stringify(marker));
  return { home, body, marker, save };
}

test('no quarantine preserves ordinary admissions and does not manufacture an acknowledgment', async () => {
  const context = await fixture();
  assert.deepEqual(await maintenanceQuarantineStatus(context.home), { state: 'absent' });
  assert.equal(await acknowledgeMaintenanceQuarantine(context.home, target, 'daemon'), undefined);
  const admission = await beginAdmission(context.home, 'normal-fixture');
  await admission.release();
});

test('exact marker acknowledgments retain quarantine and bind build, digest, recovery and process identity', async () => {
  const context = await fixture();
  await context.save();
  const before = await readFile(maintenanceQuarantinePath(context.home), 'utf8');
  const receipt = await acknowledgeMaintenanceQuarantine(context.home, target, 'daemon');
  assert.equal(receipt!.digest, context.marker.digest);
  assert.equal(receipt!.recoveryDigest, context.body.recoveryDigest);
  assert.equal(receipt!.buildId, target);
  assert.equal(receipt!.pid, process.pid);
  assert.match(receipt!.startTime, /^\d+$/);
  assert.deepEqual(JSON.parse(await readFile(maintenanceQuarantineAckPath(context.home, 'daemon', process.pid), 'utf8')), receipt);
  assert.equal(await readFile(maintenanceQuarantinePath(context.home), 'utf8'), before);
  await assert.rejects(beginAdmission(context.home, 'plugin:notices'), /maintenance_quarantined/);
  await assert.rejects(beginAdmission(context.home, 'surface:POST:any'), /maintenance_quarantined/);
  assert.deepEqual(await listAdmissions(context.home), []);
});

test('unknown fields, forged digests and nonlegacy identities fail closed independently of drain state', async () => {
  const context = await fixture();
  const cases = [
    { ...context.marker, unexpected: true },
    { ...context.marker, targetBuildId: 'd'.repeat(40) },
    { ...context.marker, admissions: [{ ...context.body.admissions[0], maintenance: { instanceID: randomUUID(), operationID: randomUUID(), directory: '/test' } }] },
  ];
  for (const invalid of cases) {
    assert.equal(MaintenanceQuarantine.safeParse(invalid).success, false);
    await writeFile(maintenanceQuarantinePath(context.home), JSON.stringify(invalid));
    await assert.rejects(readMaintenanceQuarantine(context.home), /maintenance_quarantine_invalid/);
    assert.equal((await maintenanceQuarantineStatus(context.home)).state, 'invalid');
    await assert.rejects(beginAdmission(context.home, 'plugin:notices'), /maintenance_quarantine_invalid/);
  }
  await writeFile(maintenanceQuarantinePath(context.home), '{');
  await assert.rejects(beginAdmission(context.home, 'daemon-tick'), /maintenance_quarantine_invalid/);
  await assert.rejects(acknowledgeMaintenanceQuarantine(context.home, target, 'surface'), /maintenance_quarantine_invalid/);
});

test('missing or stale running build never acknowledges but still blocks work', async () => {
  const context = await fixture();
  await context.save();
  for (const build of [undefined, null, context.body.oldBuildId]) {
    await assert.rejects(acknowledgeMaintenanceQuarantine(context.home, build, 'surface'), /build_mismatch/);
  }
  await assert.rejects(readFile(maintenanceQuarantineAckPath(context.home, 'surface', process.pid)), { code: 'ENOENT' });
  await assert.rejects(beginAdmission(context.home, 'tool:write'), /maintenance_quarantined/);
});

test('maintenance controllers and daemon dispatch remain inert while quarantine is present', async () => {
  const context = await fixture();
  await context.save();
  const originalInterval = globalThis.setInterval;
  let callback!: () => Promise<void>;
  const controller = new PluginMaintenance(context.home, '/fixture');
  const errors: unknown[] = [];
  let effects = 0;
  globalThis.setInterval = ((operation: () => Promise<void>) => {
    callback = operation;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setInterval;
  try { controller.start('plugin:notices', 1, async () => { effects++; }, error => errors.push(error), false); }
  finally { globalThis.setInterval = originalInterval; }
  await callback();
  await controller.dispose();
  assert.equal(effects, 0);
  assert.equal(errors.length, 1);
  const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.home });
  runtime.ledger.markInterrupted = async () => { effects++; return 0; };
  await tick(runtime, { error: () => {}, duty: () => {}, item: () => {}, request: () => {} });
  const background = new Background(1, context.home, 'daemon-fixture');
  assert.equal(await background.start('effect', async () => { effects++; }), false);
  assert.equal(effects, 0);
  assert.deepEqual(await listAdmissions(context.home), []);
});

test('daemon acknowledges the target manifest then remains alive without recovering old work', async () => {
  const context = await fixture();
  await context.save();
  const manifest = join(context.home, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ buildId: target, capabilities: { legacyMaintenanceQuarantine: 1 } }));
  const previous = process.env.ONIONSOUP_RELEASE_MANIFEST;
  process.env.ONIONSOUP_RELEASE_MANIFEST = manifest;
  const stopped = new AbortController();
  try {
    assert.equal(await maintenanceRuntimeBuildId(), target);
    const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.home });
    runtime.ledger.markInterrupted = async () => { throw new Error('unexpected_recovery'); };
    const errors: unknown[] = [];
    const running = daemon(runtime, { error: (_label, error) => errors.push(error), duty: () => {}, item: () => {}, request: () => {} }, stopped.signal);
    const path = maintenanceQuarantineAckPath(context.home, 'daemon', process.pid);
    let receipt: string | undefined;
    for (let attempt = 0; attempt < 100 && !receipt; attempt++) {
      receipt = await readFile(path, 'utf8').catch(() => undefined);
      if (!receipt) await delay(5);
    }
    assert.ok(receipt);
    assert.deepEqual(errors, []);
    stopped.abort();
    await running;
  } finally {
    stopped.abort();
    if (previous === undefined) delete process.env.ONIONSOUP_RELEASE_MANIFEST;
    else process.env.ONIONSOUP_RELEASE_MANIFEST = previous;
  }
});

test('quarantined plugin starts diagnostic hooks without SDK calls, timers or notebook mutation', async () => {
  const context = await fixture();
  await context.save();
  const hooks = await plugin.server({} as Parameters<typeof plugin.server>[0],
    { declarations: 'packages/owners/test/fixtures/owners', state: context.home });
  assert.deepEqual(Object.keys(hooks.tool!), ['onionsoup_status']);
  await assert.rejects(hooks['chat.message']!({} as never, {} as never), /maintenance_quarantined/);
  await assert.rejects(hooks['tool.execute.before']!({ tool: 'bash' } as never, {} as never), /maintenance_quarantined/);
  const status = await hooks.tool!.onionsoup_status!.execute({}, {} as never);
  assert.equal(JSON.parse(String(status)).digest, context.marker.digest);
  await assert.rejects(readFile(join(context.home, 'notebooks', 'odrade', 'MEMORY.md')), { code: 'ENOENT' });
  assert.deepEqual(await listAdmissions(context.home), []);
});
