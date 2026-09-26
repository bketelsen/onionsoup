import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDeploymentView, readReleaseBuildId } from '../src/deployment-view.ts';

test('installed identity remains the running build while an armed deployment waits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-deploy-'));
  const manifestPath = join(root, 'release.json');
  const stateDirectory = join(root, 'state');
  await mkdir(join(stateDirectory, 'deploy'), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ buildId: 'old-abc123' }));
  const buildId = await readReleaseBuildId(manifestPath);
  const pendingPath = join(stateDirectory, 'deploy', 'pending.json');
  for (const status of ['armed', 'waiting', 'draining']) {
    await writeFile(pendingPath, JSON.stringify({ status, targetBuildId: 'new-def456' }));
    assert.deepEqual(await readDeploymentView({ buildId, stateDirectory }), {
      buildId: 'old-abc123', pending: { status, targetBuildId: 'new-def456' }, isPending: true,
    });
  }
  for (const status of ['completed', 'cancelled']) {
    await writeFile(pendingPath, JSON.stringify({ status, targetBuildId: 'new-def456' }));
    assert.deepEqual(await readDeploymentView({ buildId, stateDirectory }), {
      buildId: 'old-abc123', isPending: false,
    });
  }
});

test('migration without a release manifest or pending record has no false alarm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-deploy-'));
  const buildId = await readReleaseBuildId(join(root, 'missing.json'));
  assert.deepEqual(await readDeploymentView({ buildId, stateDirectory: join(root, 'state') }), {
    buildId: null, isPending: false,
  });
});

test('malformed release identity and intent fail explicitly rather than showing an incorrect build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surface-deploy-'));
  const manifestPath = join(root, 'release.json');
  const stateDirectory = join(root, 'state');
  await mkdir(join(stateDirectory, 'deploy'), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ buildId: '' }));
  await assert.rejects(readReleaseBuildId(manifestPath), /deployment_invalid_manifest/);
  await writeFile(manifestPath, JSON.stringify({ buildId: 'v1' }));
  const buildId = await readReleaseBuildId(manifestPath);
  await writeFile(join(stateDirectory, 'deploy', 'pending.json'), JSON.stringify({ status: 'surprise', targetBuildId: 'v2' }));
  await assert.rejects(readDeploymentView({ buildId, stateDirectory }), /deployment_invalid_pending/);
});
