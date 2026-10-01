import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { listAdmissions } from '../packages/owners/src/deployment-admission.ts';
import { MaintenanceQuarantine, MaintenanceQuarantineAcknowledgment } from '../packages/owners/src/maintenance-quarantine.ts';
import { MaintenanceReleaseAcknowledgment } from '../packages/owners/src/maintenance-release-state.ts';
import { inspectMaintenanceReleaseInventory } from '../packages/owners/src/maintenance-release-inventory.ts';
import { Receipt, Checkpoint } from './recover-maintenance.mjs';
import { backupMaintenanceEvidence, optionalRecord } from './maintenance-recovery-storage.mjs';
import { createAdmission, readOpencodeEndpoint } from './deploy-admission.mjs';
import { endpointIdentity, assertNoWork } from './notice-admission-probe.mjs';
import { fingerprintEvidence, knownDirectories, registrySnapshot, sessionEvidence, quietDirectories,
  request, readMaintenanceRuntimeIdentity, verifyMaintenanceTargetLaunch, storageEvidence } from './maintenance-admission-probe.mjs';
import { fail, hash } from './admission-recovery-proof.mjs';

export async function recoveryContext(input) {
  const receiptPath = join(input.state, 'deploy/maintenance-recoveries', `${input.recoveryDigest}.json`);
  const receipt = Receipt.parse(JSON.parse(await readFile(receiptPath, 'utf8')));
  const selection = receipt.proof.selection;
  if (receipt.digest !== input.recoveryDigest || hash(receipt.proof) !== input.recoveryDigest
    || selection.root !== input.root || selection.state !== input.state) throw fail('maintenance_release_recovery_mismatch');
  if (receipt.proof.leases.some(lease => !['plugin:notices', 'plugin:operator-jobs'].includes(lease.kind))) {
    throw fail('maintenance_release_unaudited_legacy_kind');
  }
  const marker = await optionalRecord(join(input.state, 'deploy/maintenance-quarantine.json'), MaintenanceQuarantine);
  if (!marker || marker.digest !== receipt.quarantineDigest || marker.recoveryDigest !== receipt.digest
    || marker.targetBuildId !== selection.expectedTarget) throw fail('maintenance_release_quarantine_mismatch');
  const checkpoint = await optionalRecord(join(input.state, 'deploy/rollback.json'), Checkpoint);
  if (!checkpoint || hash(checkpoint.proof) !== receipt.digest || checkpoint.digest !== receipt.digest) {
    throw fail('maintenance_release_checkpoint_mismatch');
  }
  const archive = join(selection.root, 'maintenance-recoveries', receipt.digest);
  await backupMaintenanceEvidence(receipt.proof, join(archive, 'before-stop'), true, true);
  await backupMaintenanceEvidence(receipt.proof, join(archive, 'after-stop'), false, true);
  return { receipt, selection, marker, checkpoint, archive };
}

async function originalProcessesGone(proof) {
  const bootID = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (proof.runtime.bootID !== bootID || proof.runtime.pidNamespace !== await readlink('/proc/self/ns/pid')) {
    throw fail('maintenance_release_process_domain_changed');
  }
  for (const process of proof.runtime.units.flatMap(unit => unit.processes)) {
    const bytes = await readFile(`/proc/${process.pid}/stat`, 'utf8').catch(error => {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return undefined;
      throw error;
    });
    if (!bytes) continue;
    const fields = bytes.slice(bytes.lastIndexOf(') ') + 2).split(' ');
    if (fields[0] !== 'Z' && fields[19] === process.startTime) throw fail('maintenance_release_original_process_alive');
  }
}

async function manifestAndPointer(context) {
  const { selection, receipt } = context;
  if (await realpath(join(selection.root, 'current')) !== join(selection.root, 'releases', selection.expectedTarget)) {
    throw fail('maintenance_release_pointer_changed');
  }
  for (const manifest of receipt.proof.manifests) {
    const bytes = await readFile(join(selection.root, 'releases', manifest.build, 'packages/surface/release-manifest.json'), 'utf8');
    if (hash(bytes) !== manifest.digest) throw fail('maintenance_release_manifest_changed');
    if (manifest.build === selection.expectedTarget) {
      const parsed = JSON.parse(bytes);
      if (parsed.buildId !== selection.expectedTarget || parsed.capabilities?.legacyMaintenanceRelease !== 1) {
        throw fail('maintenance_release_target_capability_missing');
      }
    }
  }
}

/** All old records stay intact. Dead executor identity is not a claim about its external effect. */
export async function validateReleaseFence(context, effects = {}) {
  const { selection, receipt, marker } = context;
  await manifestAndPointer(context);
  await (effects.originalProcessesGone ?? originalProcessesGone)(receipt.proof);
  await verifyMaintenanceTargetLaunch(receipt.proof, effects);
  const pending = JSON.parse(await readFile(join(selection.state, 'deploy/pending.json'), 'utf8'));
  if (pending.targetBuildId !== selection.expectedTarget || pending.status !== 'draining') {
    throw fail('maintenance_release_drain_lost');
  }
  if (hash(await optionalRecord(join(selection.state, 'deploy/maintenance-quarantine.json'), MaintenanceQuarantine)) !== hash(marker)) {
    throw fail('maintenance_release_quarantine_changed');
  }
  for (const lease of receipt.proof.leaseFiles) {
    if (hash(await readFile(join(selection.state, 'deploy/leases', `${lease.id}.json`), 'utf8')) !== lease.digest) {
      throw fail('maintenance_release_legacy_evidence_changed');
    }
  }
  if ((await listAdmissions(selection.state)).some(lease => lease.alive)) throw fail('maintenance_release_active_admissions');
}

async function readAcknowledgments(directory, schema) {
  const names = await readdir(directory);
  return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(async name =>
    schema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))));
}

async function diagnosticHealth(context) {
  const address = new URL(context.selection.surfaceUrl);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
    || address.pathname !== '/' || address.search || address.hash || address.username || address.password) {
    throw fail('maintenance_release_surface_url_invalid');
  }
  const response = await fetch(new URL('/api/maintenance-quarantine', address),
    { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw fail('maintenance_release_diagnostic_unhealthy');
  return response.json();
}

async function diagnosticRuntime(context, effects) {
  const observed = await (effects.diagnosticHealth ?? diagnosticHealth)(context);
  if (observed.state !== 'active' || observed.digest !== context.marker.digest
    || observed.buildId !== context.selection.expectedTarget) throw fail('maintenance_release_diagnostic_unverified');
  const endpoint = { surfacePid: observed.pid, surfaceStartTime: observed.startTime,
    opencodePid: observed.pid, opencodeStartTime: observed.startTime };
  const runtime = await (effects.runtimeIdentity ?? readMaintenanceRuntimeIdentity)(endpoint);
  const acknowledgments = await (effects.quarantineAcknowledgments ?? readAcknowledgments)(
    join(context.selection.state, 'deploy/maintenance-quarantine-ack'), MaintenanceQuarantineAcknowledgment);
  for (const component of ['surface', 'daemon']) {
    const unitName = component === 'surface' ? 'onionsoup-surface.service' : 'onionsoup-owners.service';
    const unit = runtime.units.find(unit => unit.unit === unitName);
    if (!unit || !acknowledgments.some(ack => ack.component === component && ack.pid === unit.mainPID
      && unit.processes.some(process => process.pid === ack.pid && process.startTime === ack.startTime)
      && ack.digest === context.marker.digest && ack.buildId === context.selection.expectedTarget)) {
      throw fail('maintenance_release_ack_unverified');
    }
  }
  return runtime;
}

/** Rebind both service generations without initializing any OpenCode directory. */
export async function verifyReleaseRuntimeIdentity(context, proof, effects = {}) {
  let endpoint;
  if (proof.endpoint) {
    endpoint = await (effects.endpoint ?? readOpencodeEndpoint)(context.selection.state);
    if (hash(endpointIdentity(endpoint)) !== hash(proof.endpoint)) throw fail('maintenance_release_endpoint_changed');
  } else {
    const surface = proof.runtime.units.find(unit => unit.unit === 'onionsoup-surface.service');
    const process = surface?.processes.find(process => process.pid === surface.mainPID);
    if (!process) throw fail('maintenance_release_runtime_changed');
    endpoint = { surfacePid: process.pid, surfaceStartTime: process.startTime,
      opencodePid: process.pid, opencodeStartTime: process.startTime };
  }
  const current = await (effects.runtimeIdentity ?? readMaintenanceRuntimeIdentity)(endpoint);
  if (hash(current) !== hash(proof.runtime)) throw fail('maintenance_release_runtime_changed');
}

export async function observationProof(context, effects = {}) {
  await validateReleaseFence(context, effects);
  const runtime = await diagnosticRuntime(context, effects);
  const evidence = await (effects.fingerprint ?? fingerprintEvidence)(context.selection, context.receipt.proof.directories);
  const inventory = await inspectMaintenanceReleaseInventory(context.selection.state);
  await validateReleaseFence(context, effects);
  return { version: 1, recoveryDigest: context.receipt.digest, quarantineDigest: context.marker.digest,
    targetBuildId: context.selection.expectedTarget, runtime, evidence, inventory,
    checkpointDigest: hash(context.checkpoint), recoveryReceiptDigest: hash(context.receipt) };
}

async function releaseAcknowledgments(context, observation, runtime, endpoint, effects) {
  const records = await (effects.releaseAcknowledgments ?? readAcknowledgments)(
    join(context.selection.state, 'deploy/maintenance-release-ack'), MaintenanceReleaseAcknowledgment);
  const expected = new Map([
    ['surface', endpoint.surfacePid], ['plugin', endpoint.opencodePid],
    ['daemon', runtime.units.find(unit => unit.unit === 'onionsoup-owners.service')?.mainPID],
  ]);
  const selected = [];
  for (const [component, pid] of expected) {
    const ack = records.find(record => record.component === component && record.pid === pid
      && record.phase === 'observation' && record.approvalDigest === observation.approvalDigest
      && record.quarantineDigest === context.marker.digest && record.recoveryDigest === context.receipt.digest
      && record.targetBuildId === context.selection.expectedTarget && record.createdAt === observation.createdAt
      && runtime.units.some(unit => unit.processes.some(process => process.pid === pid && process.startTime === record.startTime)));
    if (!ack) throw fail('maintenance_release_ack_unverified');
    // A heartbeat timestamp is not release evidence; the bound process generation is.
    const { at, ...identity } = MaintenanceReleaseAcknowledgment.parse(ack);
    selected.push(identity);
  }
  return selected;
}

export async function reconciliationProof(context, observation, effects = {}) {
  await validateReleaseFence(context, effects);
  const { selection } = context;
  const endpoint = await (effects.endpoint ?? readOpencodeEndpoint)(selection.state);
  const read = effects.request ?? request;
  const runtimeIdentity = await (effects.runtimeIdentity ?? readMaintenanceRuntimeIdentity)(endpoint);
  const runtime = await Runtime.open({ state: selection.state, declarations: selection.config });
  try {
    await assertNoWork(runtime);
    const registry = await registrySnapshot(endpoint, read);
    const directories = [...new Set([...await knownDirectories(runtime), ...registry.map(session => session.directory)])].sort();
    const sessions = await sessionEvidence(endpoint, registry, read);
    for (const original of context.receipt.proof.sessions) {
      const restored = sessions.find(session => session.id === original.id);
      if (!restored || restored.directory !== original.directory || restored.parentID !== original.parentID
        || restored.transcriptDigest !== original.transcriptDigest || restored.childrenDigest !== original.childrenDigest) {
        throw fail('maintenance_release_original_history_changed');
      }
    }
    await quietDirectories(endpoint, directories, read);
    // Directory reads instantiate the restricted plugin; global health alone never loads it.
    const acknowledgments = await releaseAcknowledgments(context, observation, runtimeIdentity, endpoint, effects);
    const storage = await storageEvidence(selection, endpoint, effects);
    if (hash(storage) !== hash(context.receipt.proof.runtimeStorage)) throw fail('maintenance_release_storage_changed');
    const inventory = await inspectMaintenanceReleaseInventory(selection.state);
    const evidence = await (effects.fingerprint ?? fingerprintEvidence)(selection, directories);
    const admission = await createAdmission({ ...selection, admissionEffects: { ...effects, request: read } });
    if (!await admission.bootstrapQuiet([], endpoint)) throw fail('maintenance_release_runtime_not_quiet');
    await validateReleaseFence(context, effects);
    return { version: 1, recoveryDigest: context.receipt.digest, quarantineDigest: context.marker.digest,
      targetBuildId: selection.expectedTarget, observationDigest: hash(observation), endpoint: endpointIdentity(endpoint),
      runtime: runtimeIdentity, acknowledgments, registryDigest: hash(registry), sessions, directories,
      storage, inventory, evidence, recoveryReceiptDigest: hash(context.receipt) };
  } finally { runtime.close(); }
}
