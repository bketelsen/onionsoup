#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { beginDrain, pauseDrain } from '../packages/owners/src/deployment-admission.ts';
import { withRecordLock } from '../packages/owners/src/record-lock.ts';
import { readOpencodeEndpoint } from './deploy-admission.mjs';
import { EndpointIdentity, RecoveryProof, Selection, endpointIdentity, fail, hash,
  probeNoticeAdmissions, requestEndpoint, selectedLeases } from './notice-admission-probe.mjs';

const exec = promisify(execFile);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Checkpoint = z.object({ version: z.literal(1), bootstrap: z.literal('old-surface-restart'),
  recovery: z.literal('notice-admissions'), digest, proof: RecoveryProof,
  approvedBy: z.string().trim().min(1), recordedBy: z.string().trim().min(1),
  approvedAt: z.string().datetime() }).strict();
const Receipt = Checkpoint.extend({ state: z.literal('completed'), completedAt: z.string().datetime(),
  nextEndpoint: EndpointIdentity });
const LIMITS = { readinessMs: 60_000, readinessIntervalMs: 1000 };

async function optionalRecord(path, schema) {
  const text = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return text === undefined ? undefined : schema.parse(JSON.parse(text));
}

async function durableExclusive(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(resolve(path, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

async function publishReceipt(path, receipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await durableExclusive(temporary, receipt);
    await link(temporary, path);
    const directory = await open(resolve(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function removeCheckpoint(path) {
  await unlink(path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function recoveryPaths(selection, approvedDigest) {
  const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (source === selection.root || source.startsWith(selection.root + sep)) {
    throw fail('notice_recovery_stable_source_required');
  }
  const deploy = join(selection.state, 'deploy');
  return { checkpoint: join(deploy, 'rollback.json'), workerLock: join(deploy, 'worker.lock'),
    receipts: join(deploy, 'notice-admission-recoveries'),
    receipt: approvedDigest && join(deploy, 'notice-admission-recoveries', `${approvedDigest}.json`) };
}

export async function oldSurfaceHealth(selection, endpointProbe = readOpencodeEndpoint) {
  const url = new URL(selection.surfaceUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username
    || url.password || url.search || url.hash || url.pathname !== '/') throw fail('notice_recovery_surface_url_invalid');
  const endpoint = await endpointProbe(selection.state);
  if (url.port === new URL(endpoint.url).port) throw fail('notice_recovery_distinct_endpoints_required');
  const response = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw fail('notice_recovery_health_unavailable');
  const state = await response.json();
  if (state.deployment?.buildId !== selection.expectedOld || state.opencode?.ok !== true) {
    throw fail('notice_recovery_old_build_unhealthy');
  }
  const health = await requestEndpoint(endpoint, '/global/health', '/');
  if (health?.healthy !== true) throw fail('notice_recovery_opencode_unhealthy');
}

function effectsFor(input, selection) {
  return input.effects ?? {
    systemctl: async (action, unit) => {
      const { stdout } = await exec('systemctl', ['--user', action, unit], { timeout: 60_000 });
      return action === 'is-active' ? stdout.trim() === 'active' : true;
    },
    health: () => oldSurfaceHealth(selection),
  };
}

async function healthy(effects) {
  for (const unit of ['onionsoup-owners.service', 'onionsoup-surface.service']) {
    if (await effects.systemctl('is-active', unit) !== true) throw fail('notice_recovery_old_build_unhealthy');
  }
  await effects.health();
}

async function awaitHealthy(effects, limits) {
  const deadline = performance.now() + limits.readinessMs;
  while (true) {
    try { await healthy(effects); return; } catch {
      if (performance.now() >= deadline) throw fail('notice_recovery_health_unverified_gate_held');
      await new Promise(resolve => setTimeout(resolve, limits.readinessIntervalMs));
    }
  }
}

function validateCheckpoint(checkpoint, selection, approvedDigest) {
  if (checkpoint.digest !== approvedDigest || hash(checkpoint.proof) !== approvedDigest
    || hash(checkpoint.proof.selection) !== hash(selection)) throw fail('notice_recovery_checkpoint_mismatch');
}

async function finishRecovery(input, selection, paths, checkpoint, effects) {
  await awaitHealthy(effects, input.limits ?? LIMITS);
  const current = await probeNoticeAdmissions(selection, input.admissionEffects, ['draining'], true);
  const previous = checkpoint.proof;
  if (current.proof.endpoint.instanceId === previous.endpoint.instanceId
    || (current.proof.endpoint.opencodePid === previous.endpoint.opencodePid
      && current.proof.endpoint.opencodeStartTime === previous.endpoint.opencodeStartTime)
    || hash(current.proof.manifests) !== hash(previous.manifests)
    || hash([current.proof.sessions, current.proof.failedTool]) !== hash([previous.sessions, previous.failedTool])) throw fail('notice_recovery_health_unverified_gate_held');
  const receipt = Receipt.parse({ ...checkpoint, state: 'completed', completedAt: new Date().toISOString(),
    nextEndpoint: current.proof.endpoint });
  await mkdir(paths.receipts, { recursive: true, mode: 0o700 });
  const existing = await optionalRecord(paths.receipt, Receipt);
  if (existing) validateCheckpoint(existing, selection, checkpoint.digest);
  else await publishReceipt(paths.receipt, receipt);
  await removeCheckpoint(paths.checkpoint);
  return existing ?? receipt;
}

async function applyRecovery(input, selection, paths, approvedDigest) {
  const effects = effectsFor(input, selection);
  const checkpoint = await optionalRecord(paths.checkpoint, Checkpoint);
  const receipt = await optionalRecord(paths.receipt, Receipt);
  if (checkpoint) {
    validateCheckpoint(checkpoint, selection, approvedDigest);
    // An interrupted restart is never repeated; only a positively verified replacement can finish it.
    try { return await finishRecovery(input, selection, paths, checkpoint, effects); }
    catch { throw fail('notice_recovery_health_unverified_gate_held'); }
  }
  if (receipt) { validateCheckpoint(receipt, selection, approvedDigest); return receipt; }
  await healthy(effects);
  // The same digest can resume an interrupted pre-checkpoint drain; no restart was durably attempted.
  const preview = await probeNoticeAdmissions(selection, input.admissionEffects, ['armed', 'waiting', 'draining']);
  if (preview.digest !== approvedDigest) throw fail('notice_recovery_evidence_changed');
  let checkpointed = false;
  let drained = false;
  try {
    const leases = await beginDrain(selection.state, selection.expectedTarget);
    drained = true;
    if (hash(selectedLeases(leases, selection, preview.proof.endpoint)) !== hash(preview.proof.leases)) {
      throw fail('notice_recovery_evidence_changed');
    }
    const checked = await probeNoticeAdmissions(selection, input.admissionEffects, ['draining']);
    if (checked.digest !== approvedDigest) throw fail('notice_recovery_evidence_changed');
    const saved = Checkpoint.parse({ version: 1, bootstrap: 'old-surface-restart', recovery: 'notice-admissions',
      digest: approvedDigest, proof: checked.proof, approvedBy: input.approvedBy,
      recordedBy: userInfo().username, approvedAt: new Date().toISOString() });
    // An incomplete checkpoint also blocks old workers and pauseDrain; never remove it on uncertainty.
    checkpointed = true;
    await durableExclusive(paths.checkpoint, saved);
    await effects.systemctl('restart', 'onionsoup-surface.service');
    return await finishRecovery(input, selection, paths, saved, effects);
  } catch (error) {
    if (checkpointed) throw fail('notice_recovery_health_unverified_gate_held');
    if (drained) await pauseDrain(selection.state, selection.expectedTarget);
    throw error;
  }
}

export async function recoverNoticeAdmissions(input) {
  const selection = Selection.parse({ root: input.root, state: input.state, config: input.config,
    surfaceUrl: input.surfaceUrl, expectedOld: input.expectedOld, expectedTarget: input.expectedTarget,
    sessions: [...input.sessions].sort(), ...(input.failedTool ? { failedTool: input.failedTool } : {}) });
  const approvedDigest = input.approveDigest && digest.parse(input.approveDigest);
  const paths = recoveryPaths(selection, approvedDigest);
  if (!approvedDigest) {
    if (await optionalRecord(paths.checkpoint, Checkpoint)) throw fail('notice_recovery_checkpoint_exists');
    await healthy(effectsFor(input, selection));
    return probeNoticeAdmissions(selection, input.admissionEffects);
  }
  if (typeof input.approvedBy !== 'string' || !input.approvedBy.trim()) {
    throw fail('notice_recovery_approver_required');
  }
  return withRecordLock(paths.workerLock, () => applyRecovery(input, selection, paths, approvedDigest));
}

async function main() {
  try {
    const { values } = parseArgs({ options: {
      root: { type: 'string' }, state: { type: 'string' }, config: { type: 'string' },
      'surface-url': { type: 'string' }, 'expected-old': { type: 'string' }, 'expected-target': { type: 'string' },
      session: { type: 'string', multiple: true }, 'approve-digest': { type: 'string' },
      'approved-by': { type: 'string' }, 'failed-tool-proof': { type: 'string' },
    } });
    const failedTool = values['failed-tool-proof']
      ? JSON.parse(await readFile(values['failed-tool-proof'], 'utf8')) : undefined;
    const outcome = await recoverNoticeAdmissions({ ...values, surfaceUrl: values['surface-url'],
      expectedOld: values['expected-old'], expectedTarget: values['expected-target'], sessions: values.session ?? [],
      failedTool, approveDigest: values['approve-digest'], approvedBy: values['approved-by'] });
    console.log(JSON.stringify(outcome, null, 2));
  } catch (error) {
    console.error(typeof error.code === 'string' && error.code.startsWith('notice_recovery_')
      ? error.code : 'notice_recovery_probe_unavailable');
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
