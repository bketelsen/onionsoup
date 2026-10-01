import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readOperatorCheckOwner } from './operator-check-execution.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';
import { withRecordLock } from './record-lock.ts';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Build = z.string().regex(/^[a-f0-9]{40}$/);
export const MaintenanceReleaseObservation = z.object({ version: z.literal(1), recoveryDigest: Hash,
  quarantineDigest: Hash, targetBuildId: Build, approvalDigest: Hash, createdAt: z.iso.datetime() }).strict();
export type MaintenanceReleaseObservation = z.infer<typeof MaintenanceReleaseObservation>;
export const MaintenanceReleaseReceipt = MaintenanceReleaseObservation.extend({ reconciliationDigest: Hash,
  releasedAt: z.iso.datetime(), approvedBy: z.string().trim().min(1) }).strict();
export type MaintenanceReleaseReceipt = z.infer<typeof MaintenanceReleaseReceipt>;
export const MaintenanceReleaseAcknowledgment = MaintenanceReleaseObservation.extend({
  component: z.enum(['surface', 'daemon', 'plugin']), phase: z.enum(['observation', 'released']),
  pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), at: z.iso.datetime(),
}).strict();
export type MaintenanceReleaseAcknowledgment = z.infer<typeof MaintenanceReleaseAcknowledgment>;
export const MaintenanceReleaseStartup = MaintenanceReleaseObservation.extend({
  pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), attemptedAt: z.iso.datetime(),
}).strict();
export type MaintenanceReleaseBinding = { digest: string; recoveryDigest: string; targetBuildId: string };
export type MaintenanceReleaseState = { phase: 'diagnostic' }
  | { phase: 'observation'; observation: MaintenanceReleaseObservation }
  | { phase: 'released'; observation: MaintenanceReleaseObservation; receipt: MaintenanceReleaseReceipt };
export const MAINTENANCE_RELEASE_LIMITS = { pollMs: 250 };
export function maintenanceReleasePaths(state: string) {
  const directory = join(state, 'deploy');
  return { observation: join(directory, 'maintenance-release-observation.json'),
    receipt: join(directory, 'maintenance-release-receipt.json'), startup: join(directory, 'maintenance-release-startup.json'),
    acknowledgments: join(directory, 'maintenance-release-ack') };
}

async function optionalRecord<Schema extends z.ZodType>(path: string, schema: Schema): Promise<z.infer<Schema> | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('maintenance_release_invalid');
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('maintenance_release_invalid', { cause: error });
  }
}

function observationIdentity(observation: MaintenanceReleaseObservation) {
  return createHash('sha256').update(JSON.stringify(MaintenanceReleaseObservation.parse({ version: observation.version, recoveryDigest: observation.recoveryDigest,
    quarantineDigest: observation.quarantineDigest, targetBuildId: observation.targetBuildId,
    approvalDigest: observation.approvalDigest, createdAt: observation.createdAt }))).digest('hex');
}

/** Callers supply the validated immutable quarantine and installed build, never model input. */
export async function readMaintenanceReleaseState(state: string, binding: MaintenanceReleaseBinding,
  buildId: string | undefined | null, capable: boolean): Promise<MaintenanceReleaseState> {
  const paths = maintenanceReleasePaths(state);
  const observation = await optionalRecord(paths.observation, MaintenanceReleaseObservation);
  const receipt = await optionalRecord(paths.receipt, MaintenanceReleaseReceipt);
  if (!observation) {
    if (receipt) throw new Error('maintenance_release_observation_missing');
    return { phase: 'diagnostic' };
  }
  if (!capable || buildId !== binding.targetBuildId || observation.targetBuildId !== binding.targetBuildId
    || observation.quarantineDigest !== binding.digest || observation.recoveryDigest !== binding.recoveryDigest) {
    throw new Error('maintenance_release_binding_mismatch');
  }
  if (!receipt) return { phase: 'observation', observation };
  if (observationIdentity(receipt) !== observationIdentity(observation)) throw new Error('maintenance_release_receipt_mismatch');
  return { phase: 'released', observation, receipt };
}

export async function acknowledgeMaintenanceRelease(state: string, observation: MaintenanceReleaseObservation,
  component: MaintenanceReleaseAcknowledgment['component'], phase: MaintenanceReleaseAcknowledgment['phase']) {
  const owner = await readOperatorCheckOwner();
  const acknowledgment = MaintenanceReleaseAcknowledgment.parse({ ...observation, component, phase,
    pid: owner.pid, startTime: owner.started, at: new Date().toISOString() });
  await writeHandoffFile(join(maintenanceReleasePaths(state).acknowledgments, `${component}-${owner.pid}.json`),
    JSON.stringify(acknowledgment) + '\n');
  return acknowledgment;
}

/** An uncertain spawn is never repeated, including by a replacement surface process. */
export async function claimMaintenanceReleaseStartup(state: string, observation: MaintenanceReleaseObservation) {
  return withRecordLock(join(state, 'deploy/admission.lock'), async () => {
    const paths = maintenanceReleasePaths(state);
    const current = await optionalRecord(paths.observation, MaintenanceReleaseObservation);
    if (!current || observationIdentity(current) !== observationIdentity(observation)) {
      throw new Error('maintenance_release_binding_mismatch');
    }
    if (await optionalRecord(paths.startup, MaintenanceReleaseStartup)) throw new Error('maintenance_release_startup_uncertain');
    const owner = await readOperatorCheckOwner();
    const attempt = MaintenanceReleaseStartup.parse({ ...observation, pid: owner.pid, startTime: owner.started,
      attemptedAt: new Date().toISOString() });
    await writeHandoffFile(paths.startup, JSON.stringify(attempt) + '\n');
    return attempt;
  });
}
