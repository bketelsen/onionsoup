import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AdmissionRecord } from './admission-record.ts';
import { readOperatorCheckOwner } from './operator-check-execution.ts';
import { writeHandoffFile } from './operator-handoff-file.ts';
import { withRecordLock } from './record-lock.ts';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Build = z.string().regex(/^[a-f0-9]{40}$/);
const LegacyAdmission = AdmissionRecord.omit({ maintenance: true }).strict();
export const MaintenanceQuarantineBody = z.object({ version: z.literal(1), recoveryDigest: Hash,
  targetBuildId: Build, oldBuildId: Build, admissions: z.array(LegacyAdmission).min(1), createdAt: z.iso.datetime() }).strict();
export type MaintenanceQuarantineBody = z.infer<typeof MaintenanceQuarantineBody>;
export function maintenanceQuarantineDigest(body: MaintenanceQuarantineBody) {
  return createHash('sha256').update(JSON.stringify(MaintenanceQuarantineBody.parse(body))).digest('hex');
}
export const MaintenanceQuarantine = MaintenanceQuarantineBody.extend({ digest: Hash }).superRefine((marker, context) => {
  const { digest, ...body } = marker;
  if (digest !== maintenanceQuarantineDigest(body) || marker.oldBuildId === marker.targetBuildId
    || new Set(marker.admissions.map(admission => admission.id)).size !== marker.admissions.length
    || marker.admissions.some(admission => !admission.kind.startsWith('plugin:'))) {
    context.addIssue({ code: 'custom', message: 'maintenance_quarantine_invalid' });
  }
});
export type MaintenanceQuarantine = z.infer<typeof MaintenanceQuarantine>;
export const MaintenanceQuarantineAcknowledgment = z.object({ version: z.literal(1), component: z.enum(['daemon', 'surface', 'plugin']),
  digest: Hash, recoveryDigest: Hash, buildId: Build, pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/),
  at: z.iso.datetime() }).strict();
export type MaintenanceQuarantineAcknowledgment = z.infer<typeof MaintenanceQuarantineAcknowledgment>;
export type MaintenanceQuarantineStatus = { state: 'absent' } | { state: 'invalid'; reason: string }
  | { state: 'active'; digest: string; recoveryDigest: string; targetBuildId: string; oldBuildId: string };

export function maintenanceQuarantinePath(stateDirectory: string) {
  return join(stateDirectory, 'deploy', 'maintenance-quarantine.json');
}
export async function readMaintenanceQuarantine(stateDirectory: string) {
  let contents: string;
  try {
    const path = maintenanceQuarantinePath(stateDirectory);
    if (!(await lstat(path)).isFile()) throw new Error('maintenance_quarantine_invalid');
    contents = await readFile(path, 'utf8');
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('maintenance_quarantine_unavailable', { cause: error });
  }
  try { return MaintenanceQuarantine.parse(JSON.parse(contents)); }
  catch (error) { throw new Error('maintenance_quarantine_invalid', { cause: error }); }
}
export async function maintenanceQuarantineStatus(stateDirectory: string): Promise<MaintenanceQuarantineStatus> {
  try {
    const marker = await readMaintenanceQuarantine(stateDirectory);
    return marker ? { state: 'active', digest: marker.digest, recoveryDigest: marker.recoveryDigest,
      targetBuildId: marker.targetBuildId, oldBuildId: marker.oldBuildId } : { state: 'absent' };
  } catch (error) {
    return { state: 'invalid', reason: error instanceof Error ? error.message : 'maintenance_quarantine_unavailable' };
  }
}
export function isMaintenanceQuarantineError(error: unknown) {
  return error instanceof Error && ['maintenance_quarantined', 'maintenance_quarantine_invalid',
    'maintenance_quarantine_unavailable'].includes(error.message);
}
export async function assertMaintenanceAllowed(stateDirectory: string) {
  if (await readMaintenanceQuarantine(stateDirectory)) throw new Error('maintenance_quarantined');
}

/** Read the installed package's identity, never a moving Git checkout's current HEAD. */
export async function maintenanceRuntimeBuildId() {
  const path = process.env.ONIONSOUP_RELEASE_MANIFEST
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'surface', 'release-manifest.json');
  try {
    return z.object({ buildId: Build, capabilities: z.object({ legacyMaintenanceQuarantine: z.literal(1) }).strict().optional() }).strict().parse(JSON.parse(await readFile(path, 'utf8'))).buildId;
  } catch { return undefined; }
}
export function maintenanceQuarantineAckPath(stateDirectory: string, component: MaintenanceQuarantineAcknowledgment['component'], pid: number) {
  return join(stateDirectory, 'deploy', 'maintenance-quarantine-ack', `${component}-${pid}.json`);
}

/** Acknowledgment proves this process saw the exact quarantine. It does not lift the guard or resolve old effects. */
export async function acknowledgeMaintenanceQuarantine(stateDirectory: string, buildId: string | null | undefined,
  component: MaintenanceQuarantineAcknowledgment['component']) {
  return withRecordLock(join(stateDirectory, 'deploy', 'admission.lock'), async () => {
    const marker = await readMaintenanceQuarantine(stateDirectory);
    if (!marker) return undefined;
    if (buildId !== marker.targetBuildId) throw new Error('maintenance_quarantine_build_mismatch');
    const owner = await readOperatorCheckOwner();
    const record = MaintenanceQuarantineAcknowledgment.parse({ version: 1, component, digest: marker.digest,
      recoveryDigest: marker.recoveryDigest, buildId, pid: owner.pid, startTime: owner.started, at: new Date().toISOString() });
    await writeHandoffFile(maintenanceQuarantineAckPath(stateDirectory, component, owner.pid), JSON.stringify(record) + '\n');
    return record;
  });
}
