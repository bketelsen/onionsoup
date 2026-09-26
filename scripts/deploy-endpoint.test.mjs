import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishOpencodeEndpoint } from '../packages/surface/src/opencode.ts';
import { readOpencodeEndpoint } from './deploy-admission.mjs';
import { createAdmission } from './deploy-admission.mjs';
import { armDeployment } from '../packages/owners/src/deployment-admission.ts';
import { resolve } from 'node:path';

test('surface publishes a private endpoint and removes only its own record', async () => {
  const state = await mkdtemp(join(tmpdir(), 'deploy-endpoint-'));
  const stop = await publishOpencodeEndpoint(state, {
    url: 'http://127.0.0.1:30001', username: 'opencode', password: 'private', pid: process.pid,
  });
  const path = join(state, 'deploy', 'opencode-endpoint.json');
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.password, 'private');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(record.surfacePid, process.pid);
    assert.ok(record.surfaceStartTime);
  } finally {
    await stop();
  }
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('worker rejects an endpoint pointing at an unrelated loopback process', async () => {
  const state = await mkdtemp(join(tmpdir(), 'deploy-endpoint-'));
  await mkdir(join(state, 'deploy'));
  await writeFile(join(state, 'deploy', 'opencode-endpoint.json'), JSON.stringify({
    url: 'http://127.0.0.1:30001', username: 'opencode', password: 'private',
    surfacePid: process.pid, surfaceStartTime: '1', opencodePid: process.pid,
    opencodeStartTime: '1', instanceId: 'fake',
  }), { mode: 0o600 });
  await assert.rejects(readOpencodeEndpoint(state), /deployment_endpoint_invalid/);
});

test('caller-supplied localhost URLs cannot replace surface identity', async () => {
  const state = await mkdtemp(join(tmpdir(), 'deploy-endpoint-'));
  await assert.rejects(createAdmission({ state, config: resolve('packages/owners/test/fixtures/owners'),
    opencodeUrl: 'http://127.0.0.1:4747' }), /deployment_opencode_override_forbidden/);
});

test('missing endpoint holds the drain rather than treating missing chat status as idle', async () => {
  const state = await mkdtemp(join(tmpdir(), 'deploy-endpoint-'));
  const config = resolve('packages/owners/test/fixtures/owners');
  await armDeployment(state, 'a'.repeat(40));
  const admission = await createAdmission({ state, config });
  await admission.drain('a'.repeat(40));
  await assert.rejects(admission.quiescent(), /deployment_endpoint_invalid/);
  await assert.rejects(admission.release('completed'), /deployment_endpoint_invalid/);
  const pending = JSON.parse(await readFile(join(state, 'deploy', 'pending.json'), 'utf8'));
  assert.equal(pending.status, 'draining');
});

test('malformed status or pending reads fail closed during the drain', async () => {
  for (const invalid of [null, [], 'idle']) {
    const state = await mkdtemp(join(tmpdir(), 'deploy-endpoint-'));
    await armDeployment(state, 'a'.repeat(40));
    const admission = await createAdmission({ state, config: resolve('packages/owners/test/fixtures/owners'),
      admissionEffects: {
        endpoint: async () => ({ opencodePid: process.pid }), processes: async () => false,
        request: async (_endpoint, path) => path === '/session/status' ? invalid : [],
      },
    });
    await admission.drain('a'.repeat(40));
    await assert.rejects(admission.quiescent(), /deployment_opencode_invalid/);
  }
});

test('independent opencode holds the drain before session probes', async () => {
  const state = await mkdtemp(join(tmpdir(), 'deploy-endpoint-'));
  await armDeployment(state, 'a'.repeat(40));
  const admission = await createAdmission({ state, config: resolve('packages/owners/test/fixtures/owners'),
    admissionEffects: {
      endpoint: async () => ({ opencodePid: process.pid }), processes: async () => true,
      request: async () => { throw new Error('unexpected session read'); },
    },
  });
  await admission.drain('a'.repeat(40));
  assert.equal(await admission.quiescent(), false);
});
