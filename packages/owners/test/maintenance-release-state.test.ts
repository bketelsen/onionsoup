import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { maintenanceQuarantineDigest, maintenanceQuarantinePath, maintenanceQuarantineStatus,
  type MaintenanceQuarantineBody } from '../src/maintenance-quarantine.ts';
import { MaintenanceReleaseReceipt, MaintenanceReleaseAcknowledgment, maintenanceReleasePaths,
  readMaintenanceReleaseState, claimMaintenanceReleaseStartup, acknowledgeMaintenanceRelease,
  type MaintenanceReleaseObservation } from '../src/maintenance-release-state.ts';
import { beginAdmission, listAdmissions } from '../src/deployment-admission.ts';
import { Runtime } from '../src/runtime.ts';
import { daemon } from '../src/daemon.ts';
import plugin from '../src/plugin.ts';

const target = 'a'.repeat(40);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'maintenance-release-'));
  await mkdir(join(home, 'deploy'));
  const body: MaintenanceQuarantineBody = { version: 1, recoveryDigest: 'c'.repeat(64), targetBuildId: target,
    oldBuildId: 'b'.repeat(40), admissions: [{ id: randomUUID(), kind: 'plugin:notices', pid: 123, startTime: '1' }],
    createdAt: new Date().toISOString() };
  const marker = { ...body, digest: maintenanceQuarantineDigest(body) };
  await writeFile(maintenanceQuarantinePath(home), JSON.stringify(marker));
  const observation: MaintenanceReleaseObservation = { version: 1, recoveryDigest: body.recoveryDigest,
    quarantineDigest: marker.digest, targetBuildId: target, approvalDigest: 'd'.repeat(64), createdAt: body.createdAt };
  const paths = maintenanceReleasePaths(home);
  const saveObservation = () => writeFile(paths.observation, JSON.stringify(observation));
  const receipt = MaintenanceReleaseReceipt.parse({ ...observation, reconciliationDigest: 'e'.repeat(64),
    releasedAt: body.createdAt, approvedBy: 'disposable-fixture' });
  const release = () => writeFile(paths.receipt, JSON.stringify(receipt));
  const manifest = join(home, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ buildId: target,
    capabilities: { legacyMaintenanceQuarantine: 1, legacyMaintenanceRelease: 1 } }));
  return { home, marker, observation, paths, saveObservation, release, receipt, manifest };
}
async function withManifest(manifest: string, operation: () => Promise<void>) {
  const previous = process.env.ONIONSOUP_RELEASE_MANIFEST;
  process.env.ONIONSOUP_RELEASE_MANIFEST = manifest;
  try { await operation(); }
  finally {
    if (previous === undefined) delete process.env.ONIONSOUP_RELEASE_MANIFEST;
    else process.env.ONIONSOUP_RELEASE_MANIFEST = previous;
  }
}

test('observation keeps admissions blocked; exact released receipt opens gate while preserving original unknown record', async () => {
  const context = await fixture();
  await withManifest(context.manifest, async () => {
    const original = await readFile(maintenanceQuarantinePath(context.home), 'utf8');
    assert.deepEqual(await readMaintenanceReleaseState(context.home, context.marker, target, true), { phase: 'diagnostic' });
    await context.saveObservation();
    assert.equal((await readMaintenanceReleaseState(context.home, context.marker, target, true)).phase, 'observation');
    await assert.rejects(beginAdmission(context.home, 'chat:fixture'), /maintenance_quarantined/);
    await context.release();
    assert.equal((await maintenanceQuarantineStatus(context.home)).state, 'absent');
    const admission = await beginAdmission(context.home, 'chat:fixture');
    await admission.release();
    assert.equal(await readFile(maintenanceQuarantinePath(context.home), 'utf8'), original);
    assert.deepEqual(await listAdmissions(context.home), []);
  });
});

test('missing observation, wrong capability/build/binding and changed receipt all fail closed', async () => {
  const context = await fixture();
  await context.release();
  await assert.rejects(readMaintenanceReleaseState(context.home, context.marker, target, true), /observation_missing/);
  await context.saveObservation();
  await assert.rejects(readMaintenanceReleaseState(context.home, context.marker, target, false), /binding_mismatch/);
  await assert.rejects(readMaintenanceReleaseState(context.home, context.marker, 'f'.repeat(40), true), /binding_mismatch/);
  await assert.rejects(readMaintenanceReleaseState(context.home, { ...context.marker, digest: 'f'.repeat(64) }, target, true), /binding_mismatch/);
  await writeFile(context.paths.receipt, JSON.stringify({ ...context.receipt, approvalDigest: 'f'.repeat(64) }));
  await assert.rejects(readMaintenanceReleaseState(context.home, context.marker, target, true), /receipt_mismatch/);
  await withManifest(context.manifest, async () => {
    await assert.rejects(beginAdmission(context.home, 'tool:fixture'), /receipt_mismatch/);
    await writeFile(context.paths.receipt, '{');
    await assert.rejects(beginAdmission(context.home, 'tool:fixture'), /maintenance_release_invalid/);
  });
});

test('concurrent bootstrap claims persist one exact attempt and never repeat an uncertain start', async () => {
  const context = await fixture();
  await context.saveObservation();
  const attempts = await Promise.allSettled([
    claimMaintenanceReleaseStartup(context.home, context.observation),
    claimMaintenanceReleaseStartup(context.home, context.observation),
  ]);
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  const bytes = await readFile(context.paths.startup, 'utf8');
  const saved = JSON.parse(bytes);
  assert.equal(saved.pid, process.pid);
  assert.match(saved.startTime, /^\d+$/);
  assert.equal(saved.approvalDigest, context.observation.approvalDigest);
  await assert.rejects(claimMaintenanceReleaseStartup(context.home, context.observation), /startup_uncertain/);
  assert.equal(await readFile(context.paths.startup, 'utf8'), bytes);
  await writeFile(context.paths.observation, JSON.stringify({ ...context.observation, approvalDigest: 'f'.repeat(64) }));
  await assert.rejects(claimMaintenanceReleaseStartup(context.home, context.observation), /binding_mismatch/);
});

test('runtime acknowledgments bind phase, current process and exact observation approval', async () => {
  const context = await fixture();
  await context.saveObservation();
  const receipt = await acknowledgeMaintenanceRelease(context.home, context.observation, 'surface', 'observation');
  const saved = MaintenanceReleaseAcknowledgment.parse(JSON.parse(await readFile(
    join(context.paths.acknowledgments, `surface-${process.pid}.json`), 'utf8')));
  assert.deepEqual(saved, receipt);
  assert.equal(saved.approvalDigest, context.observation.approvalDigest);
  assert.equal(saved.phase, 'observation');
  assert.equal(saved.pid, process.pid);
});

test('observation plugin has future tools but rejects chat/tool effects and never initializes notebooks', async () => {
  const context = await fixture();
  await context.saveObservation();
  await withManifest(context.manifest, async () => {
    const hooks = await plugin.server({ client: {} } as Parameters<typeof plugin.server>[0],
      { declarations: 'packages/owners/test/fixtures/owners', state: context.home });
    try {
      assert.ok(Object.keys(hooks.tool!).length > 1);
      const config = { mcp: { fixture: { type: 'local' as const, command: ['must-not-start'], enabled: true } } };
      await hooks.config!(config);
      assert.equal(config.mcp.fixture.enabled, false);
      assert.deepEqual(Object.keys(config.mcp), ['fixture']);
      await assert.rejects(hooks['chat.message']!({ sessionID: 'fixture' } as never, {} as never), /maintenance_quarantined/);
      await assert.rejects(hooks['tool.execute.before']!({ tool: 'bash' } as never, {} as never), /maintenance_quarantined/);
      await assert.rejects(readFile(join(context.home, 'notebooks/odrade/MEMORY.md')), { code: 'ENOENT' });
      assert.deepEqual(await listAdmissions(context.home), []);
    } finally { await hooks.dispose?.(); }
    await context.release();
    await assert.rejects(hooks['chat.message']!({ sessionID: 'fixture' } as never, {} as never), /plugin_instance_disposed/);
    await assert.rejects(hooks['tool.execute.before']!({ tool: 'bash' } as never, {} as never), /plugin_instance_disposed/);
    await assert.rejects(hooks.config!({}), /plugin_instance_disposed/);
    await assert.rejects(readFile(join(context.home, 'notebooks/odrade/MEMORY.md')), { code: 'ENOENT' });
    const replacement = await plugin.server({ client: {} } as Parameters<typeof plugin.server>[0],
      { declarations: 'packages/owners/test/fixtures/owners', state: context.home });
    try {
      const config = { mcp: { fixture: { type: 'local' as const, command: ['fixture-only'], enabled: true } }, agent: {} };
      await replacement.config!(config);
      assert.equal(config.mcp.fixture.enabled, true);
      assert.ok(Object.keys(config.agent).length > 0);
    } finally { await replacement.dispose?.(); }
  });
});

test('waiting daemon activates once after exact release without process restart or replay before receipt', async () => {
  const context = await fixture();
  await context.saveObservation();
  await withManifest(context.manifest, async () => {
    const runtime = await Runtime.open({ declarations: 'packages/owners/test/fixtures/owners', state: context.home });
    const stop = new AbortController();
    let startups = 0;
    runtime.ledger.markInterrupted = async () => { startups++; stop.abort(); return 0; };
    const running = daemon(runtime, { error: () => {}, duty: () => {}, item: () => {}, request: () => {} }, stop.signal);
    try {
      const ackPath = join(context.paths.acknowledgments, `daemon-${process.pid}.json`);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(ackPath).then(() => true, () => false)) break;
        await delay(5);
      }
      assert.equal(JSON.parse(await readFile(ackPath, 'utf8')).phase, 'observation');
      assert.equal(startups, 0);
      await context.release();
      await running;
      assert.equal(startups, 1);
      assert.equal(JSON.parse(await readFile(ackPath, 'utf8')).phase, 'released');
    } finally { stop.abort(); await running; }
  });
});
