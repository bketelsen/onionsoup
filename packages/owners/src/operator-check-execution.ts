import { constants } from 'node:fs';
import { open, readFile, readlink } from 'node:fs/promises';
import { z } from 'zod';

const Identity = z.object({ pid: z.number().int().positive(), started: z.string().regex(/^\d+$/) });
export const OperatorCheckOwner = Identity.extend({ bootID: z.uuid(), pidNamespace: z.string().regex(/^pid:\[\d+\]$/) });
export type OperatorCheckOwner = z.infer<typeof OperatorCheckOwner>;
export const OperatorCheckWitness = z.object({ version: z.literal(1), owner: OperatorCheckOwner,
  launcher: Identity, namespace: Identity });
export type OperatorCheckWitness = z.infer<typeof OperatorCheckWitness>;
export const OperatorCheckInspection = z.object({ state: z.enum(['stopped', 'running', 'foreign', 'unavailable']),
  reason: z.string().min(1), proof: z.object({ owner: OperatorCheckOwner, launcher: Identity.optional(),
    namespace: Identity.optional(), observedAt: z.iso.datetime() }).optional() });
export type OperatorCheckInspection = z.infer<typeof OperatorCheckInspection>;

export function operatorCheckProcessIdentity(stat: string) {
  const boundary = stat.lastIndexOf(') ');
  const fields = stat.slice(boundary + 2).trim().split(/\s+/);
  const identity = Identity.parse({ pid: Number(stat.slice(0, stat.indexOf(' '))), started: fields[19] });
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  if (boundary < 0 || !Number.isSafeInteger(parent) || parent < 0 || !Number.isSafeInteger(group)
    || group < 1 || !fields[0]) throw new Error('operator_check_process_uncertain');
  return { ...identity, parent, group, state: fields[0] };
}

/** PID numbers are meaningful only in the same boot and proc PID view. */
export async function readOperatorCheckOwner(): Promise<OperatorCheckOwner> {
  const identity = operatorCheckProcessIdentity(await readFile('/proc/self/stat', 'utf8'));
  if (identity.pid !== process.pid) throw new Error('operator_check_process_domain_unavailable');
  return OperatorCheckOwner.parse({ pid: identity.pid, started: identity.started,
    bootID: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    pidNamespace: await readlink('/proc/self/ns/pid') });
}

function missing(error: unknown) {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function observeIdentity(expected: z.infer<typeof Identity>): Promise<OperatorCheckInspection['state']> {
  let handle;
  try { handle = await open(`/proc/${expected.pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return 'stopped'; throw error; }
  try {
    const current = operatorCheckProcessIdentity(await readFile(`/proc/self/fd/${handle.fd}/stat`, 'utf8'));
    if (current.pid !== expected.pid || current.started !== expected.started) return 'foreign';
    // Zombie and exiting leaders can still own live threads. Only full identity disappearance is stopped.
    return 'running';
  } catch (error) { if (missing(error)) return 'stopped'; throw error; }
  finally { await handle.close(); }
}

async function sameDomain(owner: OperatorCheckOwner) {
  const current = await readOperatorCheckOwner();
  return current.bootID === owner.bootID && current.pidNamespace === owner.pidNamespace;
}

export async function inspectOperatorCheckOwner(owner: OperatorCheckOwner): Promise<OperatorCheckInspection> {
  try {
    if (!await sameDomain(owner)) return { state: 'foreign', reason: 'operator_check_owner_domain_changed' };
    const state = await observeIdentity(owner);
    return { state, reason: `operator_check_owner_${state}`, ...(state === 'stopped'
      ? { proof: { owner, observedAt: new Date().toISOString() } } : {}) };
  } catch { return { state: 'unavailable', reason: 'operator_check_owner_unavailable' }; }
}

function groupGone(pid: number) {
  try { process.kill(-pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
}

/** Recovery only observes; it never signals a recorded PID or infers an exit code from disappearance. */
export async function inspectOperatorCheckWitness(witness: OperatorCheckWitness): Promise<OperatorCheckInspection> {
  try {
    if (!await sameDomain(witness.owner)) return { state: 'foreign', reason: 'operator_check_witness_domain_changed' };
    for (const identity of [witness.namespace, witness.launcher]) {
      const state = await observeIdentity(identity);
      if (state !== 'stopped') return { state, reason: `operator_check_witness_${state}` };
    }
    if (!groupGone(witness.launcher.pid)) return { state: 'running', reason: 'operator_check_group_present' };
    return { state: 'stopped', reason: 'operator_check_witness_stopped', proof: {
      owner: witness.owner, launcher: witness.launcher, namespace: witness.namespace, observedAt: new Date().toISOString() } };
  } catch { return { state: 'unavailable', reason: 'operator_check_witness_unavailable' }; }
}
