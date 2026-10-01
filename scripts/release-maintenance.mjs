#!/usr/bin/env node
import { readFile, readdir, lstat, open, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { withRecordLock } from '../packages/owners/src/record-lock.ts';
import { writeHandoffFile } from '../packages/owners/src/operator-handoff-file.ts';
import { MaintenanceReleaseObservation, MaintenanceReleaseReceipt, maintenanceReleasePaths } from '../packages/owners/src/maintenance-release-state.ts';
import { inspectMaintenanceReleaseInventory, assertMaintenanceReleaseInventoryFresh } from '../packages/owners/src/maintenance-release-inventory.ts';
import { fingerprintEvidence } from './maintenance-admission-probe.mjs';
import { recoveryContext, observationProof, reconciliationProof, validateReleaseFence,
  verifyReleaseRuntimeIdentity } from './maintenance-release-probe.mjs';
import { activationState, activationHealth, prepareMaintenanceActivation } from './maintenance-release-activation.mjs';
import { durableExclusive, optionalRecord } from './maintenance-recovery-storage.mjs';
import { fail, hash } from './admission-recovery-proof.mjs';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().refine(value => isAbsolute(value) && resolve(value) === value);
const Input = z.object({ root: Absolute, state: Absolute, recoveryDigest: Digest,
  mode: z.enum(['observation', 'release']).default('observation'), beginObservationDigest: Digest.optional(),
  releaseDigest: Digest.optional(), approvedBy: z.string().trim().min(1).optional() }).strict();
const Approval = z.object({ version: z.literal(1), digest: Digest, proof: z.record(z.string(), z.unknown()),
  approvedBy: z.string().trim().min(1), recordedBy: z.string().trim().min(1), at: z.iso.datetime() }).strict();

function locations(input, digest) {
  const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (source === input.root || source.startsWith(input.root + sep)) throw fail('maintenance_release_stable_source_required');
  return { ...maintenanceReleasePaths(input.state), worker: join(input.state, 'deploy/worker.lock'),
    admission: join(input.state, 'deploy/admission.lock'),
    archive: digest && join(input.root, 'maintenance-releases', digest),
    pending: join(input.state, 'deploy/pending.json'), marker: join(input.state, 'deploy/maintenance-quarantine.json'),
    checkpoint: join(input.state, 'deploy/rollback.json') };
}

async function leasesEvidence(state) {
  const directory = join(state, 'deploy/leases');
  return Promise.all((await readdir(directory)).sort().map(async name => {
    if (!name.endsWith('.json') || !(await lstat(join(directory, name))).isFile()) throw fail('maintenance_release_invalid_lease');
    return { name, digest: hash(await readFile(join(directory, name))) };
  }));
}

async function stableProof(read, input) {
  const first = await read();
  const admissions = await leasesEvidence(input.state);
  const second = await read();
  if (hash(first) !== hash(second) || hash(admissions) !== hash(await leasesEvidence(input.state))) {
    throw fail('maintenance_release_evidence_changed');
  }
  return { ...second, admissions };
}

function approval(proof, approvedBy) {
  if (!approvedBy) throw fail('maintenance_release_approver_required');
  return Approval.parse({ version: 1, digest: hash(proof), proof, approvedBy,
    recordedBy: userInfo().username, at: new Date().toISOString() });
}

async function saveSame(path, value, schema) {
  const previous = await optionalRecord(path, schema);
  if (previous) {
    if (hash(previous) !== hash(value)) throw fail('maintenance_release_archive_changed');
    return previous;
  }
  await durableExclusive(path, value);
  return value;
}

async function saveApproval(path, proof, approvedBy) {
  const previous = await optionalRecord(path, Approval);
  if (previous) {
    if (previous.digest !== hash(proof) || hash(previous.proof) !== hash(proof)) {
      throw fail('maintenance_release_archive_changed');
    }
    return previous;
  }
  const decision = approval(proof, approvedBy);
  await durableExclusive(path, decision);
  return decision;
}

async function observation(input, effects) {
  const context = await recoveryContext(input);
  const paths = locations(input);
  const existing = await optionalRecord(paths.observation, MaintenanceReleaseObservation);
  if (existing) {
    if (existing.recoveryDigest !== input.recoveryDigest || existing.quarantineDigest !== context.marker.digest
      || (input.beginObservationDigest && existing.approvalDigest !== input.beginObservationDigest)) {
      throw fail('maintenance_release_observation_mismatch');
    }
    await validateReleaseFence(context, effects);
    return { state: 'observation-starting', observation: existing, outcome: 'unknown' };
  }
  const proof = await stableProof(() => observationProof(context, effects), input);
  const digest = hash(proof);
  if (!input.beginObservationDigest) return { state: 'observation-preview', digest, proof };
  if (input.beginObservationDigest !== digest) throw fail('maintenance_release_evidence_changed');
  const archive = locations(input, digest).archive;
  const decision = await saveApproval(join(archive, 'observation-approval.json'), proof, input.approvedBy);
  const intent = MaintenanceReleaseObservation.parse({ version: 1, recoveryDigest: input.recoveryDigest,
    quarantineDigest: context.marker.digest, targetBuildId: context.selection.expectedTarget,
    approvalDigest: digest, createdAt: decision.at });
  await saveSame(join(archive, 'original-quarantine.json'), context.marker, z.record(z.string(), z.unknown()));
  await saveSame(join(archive, 'original-checkpoint.json'), context.checkpoint, z.record(z.string(), z.unknown()));
  await withRecordLock(paths.admission, async () => {
    await verifyLocalSnapshot(context, proof, effects);
    await durableExclusive(paths.observation, intent);
  });
  return { state: 'observation-starting', observation: intent, outcome: 'unknown' };
}

async function preparedProof(input, context, intent, effects) {
  const archive = locations(input, intent.approvalDigest).archive;
  const files = await readdir(join(archive, 'activation')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const attempts = files.filter(name => name.endsWith('-attempt.json'));
  if (!attempts.length) return undefined;
  if (attempts.length !== 1) throw fail('maintenance_release_activation_ambiguous');
  const digest = Digest.parse(attempts[0].slice(0, -'-attempt.json'.length));
  if (input.releaseDigest !== digest) throw fail('maintenance_release_activation_retry_requires_original_digest');
  const saved = await activationState(archive, digest);
  if (!saved.confirmed) throw fail('maintenance_release_activation_uncertain_gate_held');
  const decision = await optionalRecord(join(archive, 'release-approvals', `${digest}.json`), Approval);
  if (!decision || decision.digest !== digest || hash(decision.proof) !== digest
    || decision.proof.observationDigest !== hash(intent)) throw fail('maintenance_release_activation_receipt_invalid');
  await validateReleaseFence(context, effects);
  await activationHealth(context, decision.proof, effects);
  await verifyReleaseRuntimeIdentity(context, decision.proof, effects);
  return decision.proof;
}

async function verifyLocalSnapshot(context, proof, effects) {
  const { selection, marker } = context;
  await verifyReleaseRuntimeIdentity(context, proof, effects);
  if (hash(await leasesEvidence(selection.state)) !== hash(proof.admissions)) throw fail('maintenance_release_admissions_changed');
  if (hash(await inspectMaintenanceReleaseInventory(selection.state)) !== hash(proof.inventory)) {
    throw fail('maintenance_release_inventory_changed');
  }
  const pending = JSON.parse(await readFile(join(selection.state, 'deploy/pending.json'), 'utf8'));
  if (pending.status !== 'draining' || pending.targetBuildId !== selection.expectedTarget) throw fail('maintenance_release_drain_lost');
  if (hash(JSON.parse(await readFile(join(selection.state, 'deploy/maintenance-quarantine.json'), 'utf8'))) !== hash(marker)) {
    throw fail('maintenance_release_quarantine_changed');
  }
  const directories = proof.directories ?? context.receipt.proof.directories;
  if (hash(await (effects.fingerprint ?? fingerprintEvidence)(selection, directories)) !== hash(proof.evidence)) {
    throw fail('maintenance_release_evidence_changed');
  }
}

async function removeSame(path, expected) {
  const bytes = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (bytes === undefined) return;
  if (hash(JSON.parse(bytes)) !== hash(expected)) throw fail('maintenance_release_cleanup_changed');
  await unlink(path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Cleanup never re-runs reconciliation or restarts anything after the admission gate opens. */
async function cleanupReleased(input, receipt) {
  const paths = locations(input, receipt.approvalDigest);
  const decision = await optionalRecord(join(paths.archive, 'release-approvals', `${receipt.reconciliationDigest}.json`), Approval);
  if (!decision || decision.digest !== receipt.reconciliationDigest || hash(decision.proof) !== decision.digest
    || decision.proof.recoveryDigest !== input.recoveryDigest) throw fail('maintenance_release_receipt_unverified');
  const original = JSON.parse(await readFile(join(paths.archive, 'original-quarantine.json'), 'utf8'));
  const checkpoint = JSON.parse(await readFile(join(paths.archive, 'original-checkpoint.json'), 'utf8'));
  if (original.digest !== receipt.quarantineDigest || checkpoint.digest !== input.recoveryDigest
    || checkpoint.proof.selection.root !== input.root || checkpoint.proof.selection.state !== input.state) {
    throw fail('maintenance_release_receipt_unverified');
  }
  await saveSame(join(paths.archive, 'release-receipt.json'), receipt, MaintenanceReleaseReceipt);
  const cleaned = await optionalRecord(join(paths.archive, 'cleanup-receipt.json'), MaintenanceReleaseReceipt);
  if (cleaned) {
    if (hash(cleaned) !== hash(receipt)) throw fail('maintenance_release_cleanup_changed');
    return { state: 'released', outcome: 'unknown', receipt, recoveryDigest: input.recoveryDigest };
  }
  await withRecordLock(paths.admission, async () => {
    // Both originals are already immutable in the archive. Do not remove later/foreign checkpoints.
    await removeSame(paths.checkpoint, checkpoint);
    await removeSame(paths.marker, original);
  });
  await durableExclusive(join(paths.archive, 'cleanup-receipt.json'), receipt);
  return { state: 'released', outcome: 'unknown', receipt, recoveryDigest: input.recoveryDigest };
}

async function validateObservationArchive(input, context, intent) {
  const archive = locations(input, intent.approvalDigest).archive;
  const decision = await optionalRecord(join(archive, 'observation-approval.json'), Approval);
  if (!decision || decision.digest !== intent.approvalDigest || hash(decision.proof) !== decision.digest
    || decision.proof.quarantineDigest !== context.marker.digest || decision.proof.recoveryDigest !== input.recoveryDigest
    || hash(JSON.parse(await readFile(join(archive, 'original-quarantine.json'), 'utf8'))) !== hash(context.marker)
    || hash(JSON.parse(await readFile(join(archive, 'original-checkpoint.json'), 'utf8'))) !== hash(context.checkpoint)) {
    throw fail('maintenance_release_observation_archive_invalid');
  }
}

async function restoreInterruptedCommit(input, context, intent) {
  const paths = locations(input, intent.approvalDigest);
  const pending = JSON.parse(await readFile(paths.pending, 'utf8'));
  if (pending.status !== 'completed') return;
  if (!input.releaseDigest) throw fail('maintenance_release_commit_retry_requires_original_digest');
  const decision = await optionalRecord(join(paths.archive, 'release-approvals', `${input.releaseDigest}.json`), Approval);
  if (!decision || decision.digest !== input.releaseDigest || hash(decision.proof) !== decision.digest
    || decision.proof.observationDigest !== hash(intent) || pending.targetBuildId !== intent.targetBuildId) {
    throw fail('maintenance_release_commit_unverified');
  }
  await withRecordLock(paths.admission, async () => {
    if (await optionalRecord(paths.receipt, MaintenanceReleaseReceipt)) throw fail('maintenance_release_commit_changed');
    if (hash(JSON.parse(await readFile(paths.marker, 'utf8'))) !== hash(context.marker)
      || hash(await leasesEvidence(input.state)) !== hash(decision.proof.admissions)) {
      throw fail('maintenance_release_commit_changed');
    }
    // No receipt means all runtime guards still reject effects. Restore the drain before fresh proof.
    await writeHandoffFile(paths.pending, JSON.stringify({ status: 'draining', targetBuildId: intent.targetBuildId }) + '\n');
  });
}

async function release(input, effects) {
  const paths = locations(input);
  const existingReceipt = await optionalRecord(paths.receipt, MaintenanceReleaseReceipt);
  if (existingReceipt) {
    if (existingReceipt.recoveryDigest !== input.recoveryDigest
      || (input.releaseDigest && existingReceipt.reconciliationDigest !== input.releaseDigest)) {
      throw fail('maintenance_release_receipt_mismatch');
    }
    return cleanupReleased(input, existingReceipt);
  }
  const context = await recoveryContext(input);
  const intent = await optionalRecord(paths.observation, MaintenanceReleaseObservation);
  if (!intent || intent.recoveryDigest !== input.recoveryDigest || intent.quarantineDigest !== context.marker.digest
    || intent.targetBuildId !== context.selection.expectedTarget) throw fail('maintenance_release_observation_required');
  await validateObservationArchive(input, context, intent);
  await restoreInterruptedCommit(input, context, intent);
  const proof = await preparedProof(input, context, intent, effects)
    ?? await stableProof(() => reconciliationProof(context, intent, effects), input);
  const digest = hash(proof);
  const blockers = proof.inventory.decisions.filter(decision => decision.classification === 'blocked');
  if (!input.releaseDigest) return { state: 'release-preview', digest, eligible: proof.inventory.eligible, blockers, proof };
  if (input.releaseDigest !== digest) throw fail('maintenance_release_evidence_changed');
  if (!proof.inventory.eligible) throw fail('maintenance_release_unresolved_continuations');
  const archive = locations(input, intent.approvalDigest).archive;
  const decision = await saveApproval(join(archive, 'release-approvals', `${digest}.json`), proof, input.approvedBy);
  const receipt = MaintenanceReleaseReceipt.parse({ ...intent, reconciliationDigest: digest,
    releasedAt: decision.at, approvedBy: decision.approvedBy });
  await prepareMaintenanceActivation(context, proof, digest, archive, effects);
  await withRecordLock(paths.admission, async () => {
    await effects.beforeGateCommit?.();
    await verifyLocalSnapshot(context, proof, effects);
    // Receipt is the single commit point. A crash before it retains the quarantine even after pending completes.
    await writeHandoffFile(paths.pending, JSON.stringify({ status: 'completed', targetBuildId: intent.targetBuildId }) + '\n');
    await effects.afterPendingCommit?.();
    assertMaintenanceReleaseInventoryFresh(proof.inventory);
    await durableExclusive(paths.receipt, receipt);
    await effects.afterReleaseCommit?.();
  });
  return cleanupReleased(input, receipt);
}

export async function releaseMaintenance(input) {
  const { probeEffects = {}, ...fields } = input;
  const selected = Input.parse(fields);
  if (selected.beginObservationDigest && selected.releaseDigest) throw fail('maintenance_release_action_ambiguous');
  if ((selected.beginObservationDigest || selected.releaseDigest) && !selected.approvedBy) {
    throw fail('maintenance_release_approver_required');
  }
  const operation = selected.mode === 'release' || selected.releaseDigest ? release : observation;
  const paths = locations(selected);
  return withRecordLock(paths.worker, () => operation(selected, probeEffects));
}

async function main() {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, state: { type: 'string' },
      'recovery-digest': { type: 'string' }, mode: { type: 'string' },
      'begin-observation-digest': { type: 'string' }, 'release-digest': { type: 'string' }, 'approved-by': { type: 'string' } } });
    const outcome = await releaseMaintenance({ root: values.root, state: values.state, recoveryDigest: values['recovery-digest'],
      mode: values.mode, beginObservationDigest: values['begin-observation-digest'], releaseDigest: values['release-digest'],
      approvedBy: values['approved-by'] });
    console.log(JSON.stringify(outcome, null, 2));
  } catch (error) {
    console.error(error?.code?.startsWith('maintenance_release_') ? error.code : 'maintenance_release_unverified_gate_held');
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
