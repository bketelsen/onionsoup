import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  armDeployment, beginAdmission, beginDrain, cancelDeployment, listAdmissions, markDeploymentWaiting, releaseDrain,
  pauseDrain,
} from '../src/deployment-admission.ts';

async function stateDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'onionsoup-deployment-admission-'));
}

async function pending(state: string): Promise<{ status: string; targetBuildId: string }> {
  return JSON.parse(await readFile(join(state, 'deploy', 'pending.json'), 'utf8'));
}

test('admissions persist until release and draining atomically blocks new work', async () => {
  const state = await stateDirectory();
  const first = await beginAdmission(state, 'chat');
  assert.equal((await listAdmissions(state))[0]?.kind, 'chat');
  await armDeployment(state, 'build-next');
  await markDeploymentWaiting(state, 'build-next');
  const leases = await beginDrain(state, 'build-next');
  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.alive, true);
  assert.deepEqual(await pending(state), { status: 'draining', targetBuildId: 'build-next' });
  await assert.rejects(beginAdmission(state, 'daemon'), /deployment_draining/);
  await assert.rejects(releaseDrain(state, 'build-next', 'completed'), /deployment_admissions_active/);
  await first.release();
  await first.release();
  assert.deepEqual(await listAdmissions(state), []);
  await releaseDrain(state, 'build-next', 'completed');
  assert.equal((await pending(state)).status, 'completed');
  const next = await beginAdmission(state, 'child');
  await next.release();
});

test('a drain without a checkpoint can return to waiting so a blocked chat can finish', async () => {
  const state = await stateDirectory();
  await armDeployment(state, 'next');
  await markDeploymentWaiting(state, 'next');
  await beginDrain(state, 'next');
  await assert.rejects(beginAdmission(state, 'reply'), /deployment_draining/);
  await pauseDrain(state, 'next');
  assert.equal((await pending(state)).status, 'waiting');
  const reply = await beginAdmission(state, 'reply');
  await reply.release();
  await beginDrain(state, 'next');
  await assert.rejects(pauseDrain(state, 'different'), /deployment_target_mismatch/);
});

test('a rollback checkpoint prevents reopening the drain', async () => {
  const state = await stateDirectory();
  await armDeployment(state, 'next');
  await beginDrain(state, 'next');
  await writeFile(join(state, 'deploy', 'rollback.json'), '{"checkpoint":true}');
  await assert.rejects(pauseDrain(state, 'next'), /rollback_unverified_gate_held/);
  assert.equal((await pending(state)).status, 'draining');
});

test('cancelling armed or waiting leaves admitted work running and the gate open', async () => {
  for (const waiting of [false, true]) {
    const state = await stateDirectory();
    const lease = await beginAdmission(state, 'chat');
    await armDeployment(state, 'next');
    if (waiting) await markDeploymentWaiting(state, 'next');
    assert.deepEqual(await cancelDeployment(state, 'next'), { status: 'cancelled', targetBuildId: 'next' });
    assert.equal((await listAdmissions(state))[0]?.id, lease.id);
    const newLease = await beginAdmission(state, 'new-chat');
    await assert.rejects(beginDrain(state, 'next'), /deployment_not_armed/);
    await newLease.release();
    await lease.release();
  }
});

test('cancel and beginDrain serialize so a losing cancel cannot reopen the gate', async () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await stateDirectory();
    await armDeployment(state, 'next');
    const outcomes = await Promise.allSettled([cancelDeployment(state, 'next'), beginDrain(state, 'next')]);
    const final = await pending(state);
    if (final.status === 'cancelled') {
      assert.equal(outcomes[0]?.status, 'fulfilled');
      assert.equal(outcomes[1]?.status, 'rejected');
      const lease = await beginAdmission(state, 'new-chat');
      await lease.release();
    } else {
      assert.equal(final.status, 'draining');
      assert.equal(outcomes[0]?.status, 'rejected');
      assert.equal(outcomes[1]?.status, 'fulfilled');
      await assert.rejects(beginAdmission(state, 'new-chat'), /deployment_draining/);
      await assert.rejects(cancelDeployment(state, 'next'), /cannot_cancel_draining/);
      await releaseDrain(state, 'next', 'completed');
      const lease = await beginAdmission(state, 'new-chat');
      await lease.release();
    }
  }
});

test('bad or unknown pending status fails closed and does not write a lease', async () => {
  const state = await stateDirectory();
  await mkdir(join(state, 'deploy'));
  await writeFile(join(state, 'deploy', 'pending.json'), '{"status":"mystery","targetBuildId":"next"}');
  await assert.rejects(beginAdmission(state, 'chat'), /deployment_invalid_pending/);
  await assert.rejects(beginDrain(state, 'next'), /deployment_invalid_pending/);
  assert.deepEqual(await listAdmissions(state), []);
  await writeFile(join(state, 'deploy', 'pending.json'), '{bad');
  await assert.rejects(beginAdmission(state, 'chat'), /deployment_invalid_pending/);
  await assert.rejects(armDeployment(state, 'another'), /deployment_invalid_pending/);
  await writeFile(join(state, 'deploy', 'pending.json'), '{"status":"draining","targetBuildId":"next"}');
  await assert.rejects(beginDrain(state, 'other'), /deployment_target_mismatch/);
  await assert.rejects(armDeployment(state, 'other'), /deployment_in_progress/);
});

test('a crashed process leaves a detectable lease and cannot prevent recovery forever', async () => {
  const state = await stateDirectory();
  const module = new URL('../src/deployment-admission.ts', import.meta.url).href;
  const script = `import { beginAdmission } from ${JSON.stringify(module)};
    await beginAdmission(${JSON.stringify(state)}, 'child');
    process.stdout.write('ready');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
      child.once('exit', () => reject(new Error('admission_child_exited')));
    });
    assert.equal((await listAdmissions(state))[0]?.alive, true);
  } finally {
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.once('close', resolve));
    }
  }
  const dead = await listAdmissions(state);
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.alive, false);
  await armDeployment(state, 'next');
  assert.equal((await beginDrain(state, 'next'))[0]?.alive, false);
  await releaseDrain(state, 'next', 'completed');
});

test('concurrent admission and drain serialize across processes', async () => {
  const state = await stateDirectory();
  await armDeployment(state, 'next');
  const module = new URL('../src/deployment-admission.ts', import.meta.url).href;
  const script = `import { beginAdmission } from ${JSON.stringify(module)};
    try { const lease = await beginAdmission(${JSON.stringify(state)}, 'child');
      process.stdout.write('admitted'); await lease.release();
    } catch (error) { process.stdout.write(error.message); }`;
  const attempts = Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`child_exit_${code}`)));
  }));
  await beginDrain(state, 'next');
  const outcomes = await Promise.all(attempts);
  assert.ok(outcomes.every(outcome => outcome === 'admitted' || outcome === 'deployment_draining'));
  assert.deepEqual(await listAdmissions(state), []);
});

test('external flock holds the admission operation until it is released', async () => {
  const state = await stateDirectory();
  await mkdir(join(state, 'deploy'));
  const blocker = spawn('flock', ['--exclusive', join(state, 'deploy', 'admission.lock'), 'sh', '-c', 'printf ready; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.stdout.once('data', () => resolve());
      blocker.once('error', reject);
    });
    let settled = false;
    const admission = beginAdmission(state, 'chat').then(lease => { settled = true; return lease; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    blocker.stdin.end();
    const lease = await admission;
    await lease.release();
  } finally {
    blocker.stdin.end();
  }
});

test('lock failure cannot admit work', async () => {
  const state = await stateDirectory();
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(beginAdmission(state, 'chat'), /ENOENT/);
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(await listAdmissions(state), []);
});

test('simultaneous release calls are idempotent', async () => {
  const state = await stateDirectory();
  const lease = await beginAdmission(state, 'chat');
  await Promise.all([lease.release(), lease.release()]);
  assert.deepEqual(await listAdmissions(state), []);
});

test('malformed lease state refuses drain and admission instead of assuming zero work', async () => {
  const state = await stateDirectory();
  await mkdir(join(state, 'deploy', 'leases'), { recursive: true });
  await writeFile(join(state, 'deploy', 'leases', 'unknown.json'), '{bad');
  await armDeployment(state, 'next');
  await assert.rejects(listAdmissions(state), /deployment_invalid_lease/);
  await assert.rejects(beginAdmission(state, 'chat'), /deployment_invalid_lease/);
  await assert.rejects(beginDrain(state, 'next'), /deployment_invalid_lease/);
  assert.equal((await pending(state)).status, 'armed');
});
