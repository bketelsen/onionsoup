#!/usr/bin/env node
// Install the whole worker tree, including node_modules, outside the moving release root.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const UNITS = ['onionsoup-owners.service', 'onionsoup-surface.service'];
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_INTERVAL_MS = 1_000;
const READINESS_REASONS = new Set([
  ...UNITS.map(unit => `readiness_${unit}`),
  'readiness_opencode_or_build', 'readiness_surface_unavailable',
  'readiness_surface_unverified', 'readiness_opencode_unavailable',
  'deployment_endpoint_invalid', 'deployment_distinct_endpoints_required',
  'deployment_surface_url_required',
]);
const fail = code => Object.assign(new Error(code), { code });
const workerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function coordinator() {
  try {
    return await import(new URL('../packages/owners/src/deployment-admission.ts', import.meta.url));
  } catch (error) {
    throw new Error('stable_admission_unavailable', { cause: error });
  }
}

const defaultEffects = {
  run: async (command, args, options = {}) => {
    const { stdout } = await exec(command, args, { cwd: options.cwd, timeout: 1_800_000,
      maxBuffer: 8 * 1024 * 1024 });
    return { stdout };
  },
  systemctl: async (action, unit) => {
    const { stdout } = await exec('systemctl', ['--user', action, unit], { timeout: 60_000 });
    return action === 'is-active' ? stdout.trim() === 'active' : true;
  },
};

async function surfaceHealth(input, buildId) {
  let address;
  try {
    address = new URL(input.surfaceUrl);
  } catch {
    throw fail('deployment_surface_url_required');
  }
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port ||
    address.username || address.password || address.search || address.hash || address.pathname !== '/') {
    throw fail('deployment_surface_url_required');
  }
  const { readOpencodeEndpoint } = await import('./deploy-admission.mjs');
  const endpoint = await readOpencodeEndpoint(input.state);
  if (address.port === new URL(endpoint.url).port) throw fail('deployment_distinct_endpoints_required');
  const response = await fetch(new URL('/api/state', address), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw fail('readiness_surface_unavailable');
  const state = await response.json();
  if (state.deployment?.buildId !== buildId || state.opencode?.ok !== true) {
    throw fail('readiness_surface_unverified');
  }
  const health = await fetch(new URL('/global/health', endpoint.url), {
    headers: { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok) throw fail('readiness_opencode_unavailable');
  return { ok: true, buildId };
}

function paths(input) {
  if (!isAbsolute(input.root ?? '') || !isAbsolute(input.state ?? '')) throw fail('absolute_root_and_state_required');
  const root = resolve(input.root);
  const state = resolve(input.state);
  if (workerRoot === root || workerRoot.startsWith(root + sep)) throw fail('worker_inside_release_root');
  return { root, state, directory: join(state, 'deploy'), pointer: join(root, 'current'),
    releases: join(root, 'releases') };
}

async function pending(layout) {
  let text;
  try {
    text = await readFile(join(layout.directory, 'pending.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const { DeploymentIntent } = await coordinator();
  try {
    const record = DeploymentIntent.parse(JSON.parse(text));
    if (!SHA.test(record.targetBuildId)) throw fail('pending_invalid');
    return record;
  } catch {
    throw fail('pending_invalid');
  }
}

async function currentTarget({ pointer, releases }) {
  const target = await realpath(pointer).catch(error => {
    if (error.code === 'ENOENT') throw fail('current_missing');
    throw error;
  });
  if (!target.startsWith(`${releases}${sep}`)) throw fail('current_outside_releases');
  if (!(await lstat(pointer)).isSymbolicLink()) throw fail('current_not_symlink');
  return target;
}

async function switchPointer(pointer, target) {
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  try {
    await symlink(target, temporary);
    await rename(temporary, pointer);
  } finally {
    await rm(temporary, { force: true });
  }
}

const rollbackPath = layout => join(layout.directory, 'rollback.json');

async function rollbackCheckpoint(layout) {
  let text;
  try {
    text = await readFile(rollbackPath(layout), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(text);
  } catch {
    throw fail('rollback_checkpoint_invalid');
  }
  if (!checkpoint || !SHA.test(checkpoint.oldBuildId) || !SHA.test(checkpoint.targetBuildId) ||
    checkpoint.original !== join(layout.releases, checkpoint.oldBuildId) ||
    (checkpoint.phase !== undefined && !['pre-switch', 'switch-attempted'].includes(checkpoint.phase))) {
    throw fail('rollback_checkpoint_invalid');
  }
  return checkpoint;
}

async function saveRollback(layout, checkpoint) {
  const temporary = `${rollbackPath(layout)}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(checkpoint));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, rollbackPath(layout));
    const directory = await open(layout.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function manifestMatches(release, buildId) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(release, 'packages', 'surface', 'release-manifest.json'), 'utf8'));
  } catch {
    throw fail('manifest_invalid');
  }
  if (manifest.buildId !== buildId) throw fail('manifest_mismatch');
}

async function manifestBuildId(release) {
  const manifest = JSON.parse(await readFile(join(release, 'packages', 'surface', 'release-manifest.json'), 'utf8'));
  if (!SHA.test(manifest.buildId)) throw fail('old_manifest_invalid');
  return manifest.buildId;
}

async function runSandboxed(command, args, location) {
  const { runStageCommand } = await import('./deploy-stage.mjs');
  await runStageCommand(command, args, location);
}

async function stage(input, location, buildId) {
  const archive = join(location, `${randomUUID()}.tar`);
  try {
    await defaultEffects.run('git', ['archive', '--format=tar', '-o', archive, buildId], { cwd: input.source });
    await runSandboxed('tar', ['-xf', archive, '-C', location], location);
    await runSandboxed('npm', ['ci'], location);
    await runSandboxed('npm', ['run', 'verify'], location);
    await mkdir(join(location, 'packages', 'surface'), { recursive: true });
    await writeFile(join(location, 'packages', 'surface', 'release-manifest.json'),
      JSON.stringify({ buildId }) + '\n', { flag: 'wx' });
    await manifestMatches(location, buildId);
  } finally {
    await rm(archive, { force: true });
  }
}

async function seal(location) {
  const entries = await readdir(location, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(location, entry.name);
    if (entry.isDirectory()) await seal(path);
    if (!entry.isSymbolicLink()) {
      const metadata = await lstat(path);
      await chmod(path, metadata.mode & ~0o222);
    }
  }
  const metadata = await lstat(location);
  await chmod(location, metadata.mode & ~0o222);
}

export async function arm(input) {
  const layout = paths(input);
  if (!isAbsolute(input.source ?? '') || !SHA.test(input.commit ?? '')) throw fail('explicit_commit_and_source_required');
  const { armDeployment } = await coordinator();
  const previous = await pending(layout);
  if (previous && ['armed', 'waiting', 'draining'].includes(previous.status)) throw fail('deployment_already_pending');
  if (await rollbackCheckpoint(layout)) await rm(rollbackPath(layout));
  await currentTarget(layout);
  const resolved = await defaultEffects.run('git', ['rev-parse', '--verify', `${input.commit}^{commit}`], { cwd: input.source });
  const buildId = resolved.stdout.trim();
  if (buildId !== input.commit) throw fail('commit_unverified');
  await mkdir(layout.releases, { recursive: true });
  const release = join(layout.releases, buildId);
  if (await lstat(release).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    throw fail('release_already_exists');
  }
  const temporary = join(layout.releases, `.staging-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await stage(input, temporary, buildId);
    await rename(temporary, release);
    await seal(release);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await armDeployment(layout.state, buildId);
  return pending(layout);
}

export async function status(input) {
  return pending(paths(input));
}

export async function cancel(input) {
  const layout = paths(input);
  const { withRecordLock } = await import(new URL('../packages/owners/src/record-lock.ts', import.meta.url));
  return withRecordLock(join(layout.directory, 'worker.lock'), async () => {
    const record = await pending(layout);
    if (!record) throw fail('pending_missing');
    if (await rollbackCheckpoint(layout)) throw fail('rollback_unverified_gate_held');
    const { cancelDeployment } = await coordinator();
    return cancelDeployment(layout.state, record.targetBuildId);
  });
}

async function ready(buildId, effects) {
  for (const unit of UNITS) {
    if (await effects.systemctl('is-active', unit) !== true) throw fail(`readiness_${unit}`);
  }
  const health = await effects.opencode(buildId);
  if (health?.ok !== true || health.buildId !== buildId) throw fail('readiness_opencode_or_build');
}

async function waitForReady(buildId, effects, readiness = {}) {
  const timeoutMs = readiness.timeoutMs ?? READINESS_TIMEOUT_MS;
  const intervalMs = readiness.intervalMs ?? READINESS_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 ||
    !Number.isFinite(intervalMs) || intervalMs <= 0) throw fail('readiness_limits_invalid');
  const deadline = performance.now() + timeoutMs;
  let lastReason;
  while (true) {
    try {
      await ready(buildId, effects);
      return;
    } catch (error) {
      // Error messages from fetch, systemctl or endpoint files may include credentials.
      const reason = READINESS_REASONS.has(error.code) ? error.code : 'readiness_probe_unavailable';
      if (reason !== lastReason) console.error(JSON.stringify({ readiness: reason }));
      lastReason = reason;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw fail(reason);
      await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
    }
  }
}

async function restart(effects) {
  for (const unit of UNITS) await effects.systemctl('restart', unit);
}

async function recover(layout, record, effects, admission, checkpoint, readiness) {
  if (checkpoint.targetBuildId !== record.targetBuildId) throw fail('rollback_target_mismatch');
  try {
    if (checkpoint.phase === 'pre-switch') {
      if (await currentTarget(layout) !== checkpoint.original) throw fail('rollback_pointer_changed');
      await rm(rollbackPath(layout));
      const { pauseDrain } = await coordinator();
      await pauseDrain(layout.state, record.targetBuildId);
      return;
    }
    await admission.quiescentOrThrow();
    await switchPointer(layout.pointer, checkpoint.original);
    await admission.quiescentOrThrow();
    await restart(effects);
    await waitForReady(checkpoint.oldBuildId, effects, readiness);
    if (await currentTarget(layout) !== checkpoint.original) throw fail('rollback_pointer_changed');
    await admission.quiescentOrThrow();
    await admission.release('cancelled');
    await rm(rollbackPath(layout));
  } catch (error) {
    throw new Error('rollback_unverified_gate_held', { cause: error });
  }
}

async function activate(layout, record, effects, admission, readiness) {
  const release = join(layout.releases, record.targetBuildId);
  if (!(await lstat(release)).isDirectory() || await realpath(release) !== release) throw fail('release_not_directory');
  await manifestMatches(release, record.targetBuildId);
  const original = await currentTarget(layout);
  if (original === release) throw fail('release_already_current');
  const oldBuildId = await manifestBuildId(original);
  if (await admission.quiet() !== true) throw fail('drain_not_held');
  await ready(oldBuildId, effects);
  if (await admission.quiescent() !== true) throw fail('drain_not_held');
  const checkpoint = { original, oldBuildId, targetBuildId: record.targetBuildId, phase: 'pre-switch' };
  await saveRollback(layout, checkpoint);
  let switchAttempted = false;
  try {
    if (await admission.quiescent() !== true) throw fail('drain_not_held');
    await saveRollback(layout, { ...checkpoint, phase: 'switch-attempted' });
    switchAttempted = true;
    await switchPointer(layout.pointer, release);
    await restart(effects);
    await waitForReady(record.targetBuildId, effects, readiness);
  } catch (error) {
    if (!switchAttempted) {
      await rm(rollbackPath(layout));
      throw error;
    }
    try {
      await recover(layout, record, effects, admission,
        { ...checkpoint, phase: 'switch-attempted' }, readiness);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'rollback_unverified_gate_held');
    }
    throw error;
  }
  await admission.release('completed');
  await rm(rollbackPath(layout));
  return 'completed';
}

export async function worker(input) {
  const layout = paths(input);
  const { withRecordLock } = await import(new URL('../packages/owners/src/record-lock.ts', import.meta.url));
  return withRecordLock(join(layout.directory, 'worker.lock'), async () => {
    const record = await pending(layout);
    if (!record) return null;
    if (!['armed', 'waiting', 'draining'].includes(record.status)) {
      if (await rollbackCheckpoint(layout)) await rm(rollbackPath(layout));
      return record;
    }
    const { createAdmission } = await import('./deploy-admission.mjs');
    const admission = await createAdmission({ ...input, state: layout.state, root: layout.root });
    if (record.status === 'armed') await admission.markWaiting(record.targetBuildId);
    const checkpoint = await rollbackCheckpoint(layout);
    if (!checkpoint && record.status !== 'draining') {
      const { listAdmissions } = await coordinator();
      if ((await listAdmissions(layout.state)).some(lease => lease.alive)) throw fail('deployment_waiting_for_turns');
    }
    await admission.drain(record.targetBuildId);
    const effects = input.effects ?? { ...defaultEffects, opencode: buildId => surfaceHealth(input, buildId) };
    if (checkpoint) {
      await recover(layout, record, effects, admission, checkpoint, input.readiness);
      return pending(layout);
    }
    const { pauseDrain } = await coordinator();
    try {
      if (await admission.quiet() !== true) throw fail('drain_not_held');
      await activate(layout, record, effects, admission, input.readiness);
    } catch (error) {
      if ((await pending(layout)).status === 'draining' && !await rollbackCheckpoint(layout)) {
        await pauseDrain(layout.state, record.targetBuildId);
      }
      if (error.code === 'drain_not_held') throw fail('deployment_waiting_for_turns');
      throw error;
    }
    return pending(layout);
  });
}

async function main() {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
       root: { type: 'string' }, state: { type: 'string' }, source: { type: 'string' },
       commit: { type: 'string' }, config: { type: 'string' }, 'opencode-url': { type: 'string' },
      'surface-url': { type: 'string' },
    } });
    const [command] = positionals;
    if (positionals.length !== 1) throw fail('command_required');
    const handlers = { arm, worker, status, cancel };
    if (!Object.hasOwn(handlers, command)) throw fail('unknown_command');
    console.log(JSON.stringify(await handlers[command]({ ...values,
       opencodeUrl: values['opencode-url'], surfaceUrl: values['surface-url'],
    })));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? error.message ?? 'deploy_failed' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
