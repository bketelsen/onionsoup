import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { maintenanceQuarantineDigest, maintenanceQuarantinePath, acknowledgeMaintenanceQuarantine } from '@onionsoup/owners';
import { quarantineSurfaceServer } from '../src/server.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'surface-quarantine-'));
  await mkdir(join(home, 'deploy'));
  const body = { version: 1 as const, recoveryDigest: 'c'.repeat(64), targetBuildId: 'a'.repeat(40), oldBuildId: 'b'.repeat(40),
    createdAt: new Date().toISOString(), admissions: [{ id: randomUUID(), kind: 'plugin:notices', pid: process.pid, startTime: '1' }] };
  const marker = { ...body, digest: maintenanceQuarantineDigest(body) };
  await writeFile(maintenanceQuarantinePath(home), JSON.stringify(marker));
  return { home, marker };
}

test('diagnostic-only surface reports exact quarantine acknowledgment, honest unavailable OpenCode and rejects all writes', async context => {
  const setup = await fixture();
  const acknowledgment = await acknowledgeMaintenanceQuarantine(setup.home, setup.marker.targetBuildId, 'surface');
  const { server } = quarantineSurfaceServer(setup.home, { buildId: setup.marker.targetBuildId, acknowledgment });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const status = await (await fetch(`${base}/api/maintenance-quarantine`)).json();
  assert.equal(status.state, 'active');
  assert.equal(status.digest, setup.marker.digest);
  assert.equal(status.recoveryDigest, setup.marker.recoveryDigest);
  assert.equal(status.buildId, setup.marker.targetBuildId);
  assert.equal(status.pid, process.pid);
  assert.equal(status.acknowledged, true);
  assert.equal(status.admissions, undefined, 'public diagnostics do not expose selected lease identities');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.readOnly, true);
  assert.equal(state.opencode.ok, false);
  assert.equal(state.maintenanceQuarantine.digest, setup.marker.digest);
  for (const [method, path] of [['POST', '/api/owners/odrade/sessions'], ['PUT', '/api/settings/owner-order'],
    ['DELETE', '/api/anything'], ['POST', '/wiki/anything']]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'maintenance_quarantined');
  }
  assert.equal((await fetch(`${base}/api/owners/odrade`)).status, 503, 'normal state readers may prepare workspaces and remain paused');
});

test('invalid or changed marker never reuses an earlier successful surface acknowledgment', async context => {
  const setup = await fixture();
  const acknowledgment = await acknowledgeMaintenanceQuarantine(setup.home, setup.marker.targetBuildId, 'surface');
  const { server } = quarantineSurfaceServer(setup.home, { buildId: setup.marker.targetBuildId, acknowledgment });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  await writeFile(maintenanceQuarantinePath(setup.home), '{}');
  const status = await (await fetch(`${base}/api/maintenance-quarantine`)).json();
  assert.equal(status.state, 'invalid');
  assert.equal(status.acknowledged, false);
  assert.equal(status.pid, undefined);
  assert.equal((await fetch(`${base}/api/chat`, { method: 'POST' })).status, 503);
});


test('real surface entrypoint restores only diagnostics without contacting or launching OpenCode', async context => {
  const setup = await fixture();
  const state = join(setup.home, 'state');
  await mkdir(join(state, 'deploy'), { recursive: true });
  await writeFile(maintenanceQuarantinePath(state), JSON.stringify(setup.marker));
  const manifest = join(setup.home, 'release-manifest.json');
  await writeFile(manifest, JSON.stringify({ buildId: setup.marker.targetBuildId,
    capabilities: { legacyMaintenanceQuarantine: 1 } }));
  let contacts = 0;
  const trap = createServer((_request, response) => { contacts++; response.end('{}'); });
  trap.listen(0, '127.0.0.1');
  await once(trap, 'listening');
  context.after(() => new Promise<void>(resolve => trap.close(() => resolve())));
  const remote = trap.address();
  assert.ok(remote && typeof remote === 'object');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const destination = reservation.address();
  assert.ok(destination && typeof destination === 'object');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const { NODE_OPTIONS: _nodeOptions, ...environment } = process.env;
  const child = spawn(process.execPath, ['--conditions=onionsoup-source', '--import', 'tsx', 'packages/surface/src/main.ts'], {
    env: { ...environment, ONIONSOUP_HOME: setup.home, ONIONSOUP_CONFIG: resolve('packages/owners/test/fixtures/owners'),
      ONIONSOUP_RELEASE_MANIFEST: manifest, SURFACE_PORT: String(destination.port), OPENCODE_URL: `http://127.0.0.1:${remote.port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const base = `http://127.0.0.1:${destination.port}`;
  const deadline = Date.now() + 10_000;
  let status: { acknowledged?: boolean; pid?: number; digest?: string } | undefined;
  while (Date.now() < deadline && !status) {
    status = await fetch(`${base}/api/maintenance-quarantine`).then(response => response.json()).catch(() => undefined);
    if (!status) await delay(20);
  }
  assert.ok(status, logs);
  assert.equal(status.acknowledged, true);
  assert.equal(status.pid, child.pid);
  assert.equal(status.digest, setup.marker.digest);
  const view = await (await fetch(`${base}/api/state`)).json();
  assert.equal(view.opencode.ok, false);
  assert.equal(contacts, 0);
  assert.equal((await fetch(`${base}/api/owners/odrade/sessions`, { method: 'POST' })).status, 503);
  await assert.rejects(readFile(join(state, 'deploy', 'opencode-endpoint.json')), { code: 'ENOENT' });
});
