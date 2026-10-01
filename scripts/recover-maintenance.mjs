#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { beginDrain, pauseDrain } from '../packages/owners/src/deployment-admission.ts';
import { MaintenanceQuarantine, MaintenanceQuarantineAcknowledgment, maintenanceQuarantineDigest,
  maintenanceQuarantinePath } from '../packages/owners/src/maintenance-quarantine.ts';
import { withRecordLock } from '../packages/owners/src/record-lock.ts';
import { Selection, MaintenanceProof, probeMaintenanceAdmissions, inspectMaintenanceUnit,
  inspectStoppedMaintenance, verifyMaintenanceTargetLaunch, revalidateMaintenanceBeforeStop } from './maintenance-admission-probe.mjs';
import { oldSurfaceHealth } from './recover-notice-admissions.mjs';
import { backupMaintenanceEvidence, durableExclusive, optionalRecord, switchPointer } from './maintenance-recovery-storage.mjs';
import { fail, hash } from './admission-recovery-proof.mjs';

const exec = promisify(execFile);
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/);
const UNITS = ['onionsoup-owners.service', 'onionsoup-surface.service'];
const LIMITS = { readinessMs: 60_000, readinessIntervalMs: 1000 };
const Checkpoint = z.object({ version: z.literal(1), recovery: z.literal('legacy-maintenance'),
  digest: DIGEST, proof: MaintenanceProof, approvedBy: z.string().trim().min(1),
  recordedBy: z.string().trim().min(1), approvedAt: z.iso.datetime() }).strict();
const Attempt = z.object({ version: z.literal(1), digest: DIGEST, action: z.string(), at: z.iso.datetime() }).strict();
const Receipt = Checkpoint.extend({ state: z.literal('restored-quarantined'), outcome: z.literal('unknown'),
  quarantineDigest: DIGEST, restoredAt: z.iso.datetime() }).strict();

function paths(selection, digest) {
  const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (source === selection.root || source.startsWith(selection.root + sep)) throw fail('maintenance_recovery_stable_source_required');
  const deploy = join(selection.state, 'deploy');
  const archive = digest && join(selection.root, 'maintenance-recoveries', digest);
  return { checkpoint: join(deploy, 'rollback.json'), worker: join(deploy, 'worker.lock'), archive,
    marker: maintenanceQuarantinePath(selection.state),
    receipt: digest && join(deploy, 'maintenance-recoveries', `${digest}.json`) };
}

async function processStartTime(pid) {
  const bytes = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = bytes.slice(bytes.lastIndexOf(') ') + 2).split(' ');
  if (fields[0] === 'Z' || !/^\d+$/.test(fields[19] ?? '')) throw fail('maintenance_recovery_process_unverified');
  return fields[19];
}

async function targetHealth(selection, marker) {
  const address = new URL(selection.surfaceUrl);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
    || address.pathname !== '/' || address.search || address.hash || address.username || address.password) {
    throw fail('maintenance_recovery_surface_url_invalid');
  }
  const response = await fetch(new URL('/api/maintenance-quarantine', address),
    { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw fail('maintenance_recovery_target_unhealthy');
  const surface = await response.json();
  const directory = join(selection.state, 'deploy/maintenance-quarantine-ack');
  const records = await Promise.all((await readdir(directory)).map(async name =>
    MaintenanceQuarantineAcknowledgment.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))));
  for (const [index, component] of ['daemon', 'surface'].entries()) {
    const { stdout } = await exec('systemctl', ['--user', 'show', UNITS[index], '--property=MainPID', '--value'], { timeout: 10_000 });
    const pid = Number(stdout.trim());
    const startTime = await processStartTime(pid);
    if (!records.some(record => record.component === component && record.pid === pid && record.startTime === startTime
      && record.digest === marker.digest && record.recoveryDigest === marker.recoveryDigest
      && record.buildId === selection.expectedTarget)) throw fail('maintenance_recovery_ack_unverified');
    if (component === 'surface' && (surface.state !== 'active' || surface.digest !== marker.digest
      || surface.recoveryDigest !== marker.recoveryDigest || surface.buildId !== selection.expectedTarget
      || surface.pid !== pid || surface.startTime !== startTime)) throw fail('maintenance_recovery_ack_unverified');
  }
}

function effectsFor(input, selection) {
  return input.effects ?? {
    systemctl: async (action, unit) => {
      const { stdout } = await exec('systemctl', ['--user', action, unit], { timeout: 60_000 });
      return action === 'is-active' ? stdout.trim() === 'active' : true;
    },
    health: (_build, marker) => marker ? targetHealth(selection, marker) : oldSurfaceHealth(selection),
  };
}

async function healthy(effects, selection, marker) {
  for (const unit of UNITS) {
    if (await effects.systemctl('is-active', unit) !== true) throw fail('maintenance_recovery_service_unhealthy');
  }
  await effects.health(marker ? selection.expectedTarget : selection.expectedOld, marker);
}

async function awaitHealthy(input, effects, selection, marker) {
  const limits = input.limits ?? LIMITS;
  const deadline = performance.now() + limits.readinessMs;
  while (true) {
    try { await healthy(effects, selection, marker); return; }
    catch (error) {
      if (performance.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, limits.readinessIntervalMs));
    }
  }
}

function validateCheckpoint(checkpoint, selection, digest) {
  if (checkpoint.digest !== digest || hash(checkpoint.proof) !== digest
    || hash(checkpoint.proof.selection) !== hash(selection)) throw fail('maintenance_recovery_checkpoint_mismatch');
}

async function held(selection, checkpoint, marker) {
  const intent = JSON.parse(await readFile(join(selection.state, 'deploy/pending.json'), 'utf8'));
  if (intent.status !== 'draining' || intent.targetBuildId !== selection.expectedTarget) {
    throw fail('maintenance_recovery_drain_lost');
  }
  const current = await optionalRecord(maintenanceQuarantinePath(selection.state), MaintenanceQuarantine);
  if (!current || hash(current) !== hash(marker) || current.recoveryDigest !== checkpoint.digest) {
    throw fail('maintenance_recovery_quarantine_changed');
  }
  for (const manifest of checkpoint.proof.manifests) {
    const bytes = await readFile(join(selection.root, 'releases', manifest.build, 'packages/surface/release-manifest.json'), 'utf8');
    if (hash(bytes) !== manifest.digest) throw fail('maintenance_recovery_manifest_changed');
  }
  for (const lease of checkpoint.proof.leaseFiles) {
    const bytes = await readFile(join(selection.state, 'deploy/leases', `${lease.id}.json`), 'utf8');
    if (hash(bytes) !== lease.digest) throw fail('maintenance_recovery_lease_changed');
  }
}

async function attempt(paths, checkpoint, action) {
  const path = join(paths.archive, 'actions', `${action}.json`);
  const existing = await optionalRecord(path, Attempt);
  if (existing) {
    if (existing.digest !== checkpoint.digest || existing.action !== action) throw fail('maintenance_recovery_attempt_changed');
    return false;
  }
  await durableExclusive(path, { version: 1, digest: checkpoint.digest, action, at: new Date().toISOString() });
  return true;
}

async function stopOriginal(input, selection, paths, checkpoint, marker, effects) {
  for (const unit of UNITS) {
    await held(selection, checkpoint, marker);
    const observation = await inspectMaintenanceUnit(checkpoint.proof, unit, input.probeEffects);
    if (observation === 'stopped') continue;
    if (observation !== 'original') throw fail('maintenance_recovery_original_process_unverified');
    await revalidateMaintenanceBeforeStop(checkpoint.proof, input.probeEffects);
    if (!await attempt(paths, checkpoint, `stop-${unit}`)) throw fail('maintenance_recovery_stop_uncertain_gate_held');
    // The checkpoint is durable before the side effect; an uncertain stop is never repeated.
    await revalidateMaintenanceBeforeStop(checkpoint.proof, input.probeEffects);
    const checked = await inspectMaintenanceUnit(checkpoint.proof, unit, input.probeEffects);
    if (checked !== 'original') throw fail('maintenance_recovery_original_process_unverified');
    await effects.systemctl('stop', unit);
  }
  if ((await inspectStoppedMaintenance(checkpoint.proof, input.probeEffects)).state !== 'stopped') {
    throw fail('maintenance_recovery_stop_unverified_gate_held');
  }
  const path = join(paths.archive, 'stopped.json');
  if (!await optionalRecord(path, Attempt)) await durableExclusive(path,
    { version: 1, digest: checkpoint.digest, action: 'verified-stopped', at: new Date().toISOString() });
}

async function activateTarget(input, selection, paths, checkpoint, marker, effects) {
  const pointer = join(selection.root, 'current');
  const old = join(selection.root, 'releases', selection.expectedOld);
  const target = join(selection.root, 'releases', selection.expectedTarget);
  const current = await realpath(pointer);
  if (![old, target].includes(current)) throw fail('maintenance_recovery_pointer_changed');
  if (current === old) {
    await held(selection, checkpoint, marker);
    if (!await attempt(paths, checkpoint, 'switch')) throw fail('maintenance_recovery_switch_uncertain_gate_held');
    await switchPointer(pointer, target);
  } else {
    const switched = await optionalRecord(join(paths.archive, 'actions/switch.json'), Attempt);
    const stopped = await optionalRecord(join(paths.archive, 'stopped.json'), Attempt);
    if (switched?.digest !== checkpoint.digest || switched.action !== 'switch'
      || stopped?.digest !== checkpoint.digest || stopped.action !== 'verified-stopped') {
      throw fail('maintenance_recovery_switch_unverified');
    }
  }
  for (const unit of UNITS) {
    await held(selection, checkpoint, marker);
    await verifyMaintenanceTargetLaunch(checkpoint.proof, input.probeEffects);
    if (await realpath(pointer) !== target) throw fail('maintenance_recovery_pointer_changed');
    if (await attempt(paths, checkpoint, `start-${unit}`)) {
      if (await realpath(pointer) !== target) throw fail('maintenance_recovery_pointer_changed');
      await effects.systemctl('start', unit);
    }
  }
  // Never restart the old unprotected binary on failure: diagnostic target or stopped services remain fenced.
  await awaitHealthy(input, effects, selection, marker);
  await held(selection, checkpoint, marker);
  if (await realpath(pointer) !== target) throw fail('maintenance_recovery_pointer_changed');
}

async function ensureQuarantine(selection, paths, checkpoint) {
  const body = { version: 1, recoveryDigest: checkpoint.digest, targetBuildId: selection.expectedTarget,
    oldBuildId: selection.expectedOld, admissions: checkpoint.proof.leases.map(({ alive, ...record }) => record),
    createdAt: checkpoint.approvedAt };
  const expected = MaintenanceQuarantine.parse({ ...body, digest: maintenanceQuarantineDigest(body) });
  const existing = await optionalRecord(paths.marker, MaintenanceQuarantine);
  if (existing) {
    if (hash(existing) !== hash(expected)) throw fail('maintenance_recovery_quarantine_changed');
    return existing;
  }
  const actions = await readdir(join(paths.archive, 'actions')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (actions.length) throw fail('maintenance_recovery_quarantine_missing_after_attempt');
  await durableExclusive(paths.marker, expected);
  return expected;
}

async function prepareCheckpoint(input, selection, paths, digest, effects) {
  await healthy(effects, selection);
  const preview = await probeMaintenanceAdmissions(selection, input.probeEffects, ['armed', 'waiting', 'draining']);
  if (preview.digest !== digest) throw fail('maintenance_recovery_evidence_changed');
  let drained = false;
  let checkpointed = false;
  try {
    const leases = await beginDrain(selection.state, selection.expectedTarget);
    drained = true;
    if (hash(leases.filter(lease => lease.alive).sort((left, right) => left.id.localeCompare(right.id))) !== hash(preview.proof.leases)) {
      throw fail('maintenance_recovery_evidence_changed');
    }
    const checked = await probeMaintenanceAdmissions(selection, input.probeEffects, ['draining']);
    if (checked.digest !== digest) throw fail('maintenance_recovery_evidence_changed');
    const proofPath = join(paths.archive, 'proof.json');
    const previousProof = await optionalRecord(proofPath, MaintenanceProof);
    if (previousProof && hash(previousProof) !== digest) throw fail('maintenance_recovery_backup_evidence_changed');
    if (!previousProof) await durableExclusive(proofPath, checked.proof);
    await backupMaintenanceEvidence(checked.proof, join(paths.archive, 'before-stop'));
    const afterBackup = await probeMaintenanceAdmissions(selection, input.probeEffects, ['draining']);
    if (afterBackup.digest !== digest) throw fail('maintenance_recovery_evidence_changed');
    const saved = Checkpoint.parse({ version: 1, recovery: 'legacy-maintenance', digest, proof: checked.proof,
      approvedBy: input.approvedBy, recordedBy: userInfo().username, approvedAt: new Date().toISOString() });
    checkpointed = true;
    await durableExclusive(paths.checkpoint, saved);
    return saved;
  } catch (error) {
    if (drained && !checkpointed) await pauseDrain(selection.state, selection.expectedTarget);
    throw error;
  }
}

async function apply(input, selection, paths, digest) {
  const effects = effectsFor(input, selection);
  const checkpoint = await optionalRecord(paths.checkpoint, Checkpoint)
    ?? await prepareCheckpoint(input, selection, paths, digest, effects);
  validateCheckpoint(checkpoint, selection, digest);
  await backupMaintenanceEvidence(checkpoint.proof, join(paths.archive, 'before-stop'), true, true);
  const marker = await ensureQuarantine(selection, paths, checkpoint);
  const receipt = await optionalRecord(paths.receipt, Receipt);
  if (receipt) {
    validateCheckpoint(receipt, selection, digest);
    if (receipt.quarantineDigest !== marker.digest) throw fail('maintenance_recovery_receipt_mismatch');
    await held(selection, checkpoint, marker);
    await backupMaintenanceEvidence(checkpoint.proof, join(paths.archive, 'after-stop'), false, true);
    if (await realpath(join(selection.root, 'current')) !== join(selection.root, 'releases', selection.expectedTarget)) {
      throw fail('maintenance_recovery_pointer_changed');
    }
    await healthy(effects, selection, marker);
    return receipt;
  }
  const current = await realpath(join(selection.root, 'current'));
  if (current === join(selection.root, 'releases', selection.expectedOld)) {
    await stopOriginal(input, selection, paths, checkpoint, marker, effects);
    await backupMaintenanceEvidence(checkpoint.proof, join(paths.archive, 'after-stop'), false);
  } else if (current !== join(selection.root, 'releases', selection.expectedTarget)) {
    throw fail('maintenance_recovery_pointer_changed');
  } else {
    await backupMaintenanceEvidence(checkpoint.proof, join(paths.archive, 'after-stop'), false, true);
  }
  await activateTarget(input, selection, paths, checkpoint, marker, effects);
  const restored = Receipt.parse({ ...checkpoint, state: 'restored-quarantined', outcome: 'unknown',
    quarantineDigest: marker.digest, restoredAt: new Date().toISOString() });
  await durableExclusive(paths.receipt, restored);
  return restored;
}

export async function recoverMaintenance(input) {
  const selection = Selection.parse({ root: input.root, state: input.state, config: input.config,
    surfaceUrl: input.surfaceUrl, expectedOld: input.expectedOld, expectedTarget: input.expectedTarget,
    leases: [...input.leases].sort(), evidenceRoots: [...input.evidenceRoots].sort() });
  const digest = input.approveDigest && DIGEST.parse(input.approveDigest);
  const locations = paths(selection, digest);
  if (!digest) {
    if (await readFile(locations.checkpoint).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      throw fail('maintenance_recovery_checkpoint_exists');
    }
    await healthy(effectsFor(input, selection), selection);
    return probeMaintenanceAdmissions(selection, input.probeEffects);
  }
  if (typeof input.approvedBy !== 'string' || !input.approvedBy.trim()) throw fail('maintenance_recovery_approver_required');
  return withRecordLock(locations.worker, () => apply(input, selection, locations, digest));
}

async function main() {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, state: { type: 'string' }, config: { type: 'string' },
      'surface-url': { type: 'string' }, 'expected-old': { type: 'string' }, 'expected-target': { type: 'string' },
      lease: { type: 'string', multiple: true }, 'evidence-root': { type: 'string', multiple: true },
      'approve-digest': { type: 'string' }, 'approved-by': { type: 'string' } } });
    const outcome = await recoverMaintenance({ ...values, surfaceUrl: values['surface-url'],
      expectedOld: values['expected-old'], expectedTarget: values['expected-target'], leases: values.lease ?? [],
      evidenceRoots: values['evidence-root'] ?? [], approveDigest: values['approve-digest'], approvedBy: values['approved-by'] });
    console.log(JSON.stringify(outcome, null, 2));
  } catch (error) {
    console.error(error?.code?.startsWith('maintenance_recovery_') ? error.code : 'maintenance_recovery_unverified_gate_held');
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
