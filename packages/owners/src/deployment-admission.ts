import { readFile, readdir, rename, mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { withRecordLock } from './record-lock.ts';

/** Shared with the surface's deployment badge: state/deploy/pending.json. */
export const DeploymentIntent = z.object({
  status: z.enum(['armed', 'waiting', 'draining', 'completed', 'cancelled']),
  targetBuildId: z.string().trim().min(1),
});
export type DeploymentIntent = z.infer<typeof DeploymentIntent>;

const AdmissionRecord = z.object({
  id: z.uuid(),
  kind: z.string().trim().min(1),
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^\d+$/),
});

export type Admission = z.infer<typeof AdmissionRecord> & { alive: boolean };
export type AdmissionLease = Admission & { release(): Promise<void> };

function deployDirectory(stateDirectory: string): string {
  return join(stateDirectory, 'deploy');
}

async function withAdmissionLock<T>(stateDirectory: string, operation: () => Promise<T>): Promise<T> {
  return withRecordLock(join(deployDirectory(stateDirectory), 'admission.lock'), operation);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const directory = dirname(path);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function readIntent(stateDirectory: string): Promise<DeploymentIntent | undefined> {
  let text: string;
  try {
    text = await readFile(join(deployDirectory(stateDirectory), 'pending.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return DeploymentIntent.parse(JSON.parse(text));
  } catch {
    throw new Error('deployment_invalid_pending');
  }
}

async function writeIntent(stateDirectory: string, intent: DeploymentIntent): Promise<void> {
  await atomicJson(join(deployDirectory(stateDirectory), 'pending.json'), intent);
}

/** /proc start time disambiguates a reused PID, and errors other than disappearance fail closed. */
async function processStartTime(pid: number): Promise<string | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') {
      return undefined;
    }
    throw error;
  }
  const endOfName = stat.lastIndexOf(') ');
  const fields = stat.slice(endOfName + 2).split(' ');
  const startTime = fields[19];
  if (endOfName < 0 || !startTime || !/^\d+$/.test(startTime)) throw new Error('deployment_process_state_unknown');
  return fields[0] === 'Z' ? undefined : startTime;
}

async function readAdmissions(stateDirectory: string): Promise<Admission[]> {
  const directory = join(deployDirectory(stateDirectory), 'leases');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const admissions: Admission[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) throw new Error('deployment_invalid_lease');
    let record: z.infer<typeof AdmissionRecord>;
    try {
      record = AdmissionRecord.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
    } catch {
      throw new Error('deployment_invalid_lease');
    }
    if (`${record.id}.json` !== name) throw new Error('deployment_invalid_lease');
    admissions.push({ ...record, alive: (await processStartTime(record.pid)) === record.startTime });
  }
  return admissions;
}

/** Atomically checks the drain gate and persists a lease before returning to the caller. */
export async function beginAdmission(stateDirectory: string, kind: string): Promise<AdmissionLease> {
  const admitted = await withAdmissionLock(stateDirectory, async () => {
    const intent = await readIntent(stateDirectory);
    if (intent?.status === 'draining') throw new Error('deployment_draining');
    await readAdmissions(stateDirectory);
    const startTime = await processStartTime(process.pid);
    if (!startTime) throw new Error('deployment_process_state_unknown');
    const record = AdmissionRecord.parse({ id: randomUUID(), kind, pid: process.pid, startTime });
    await mkdir(join(deployDirectory(stateDirectory), 'leases'), { recursive: true });
    await atomicJson(join(deployDirectory(stateDirectory), 'leases', `${record.id}.json`), record);
    return record;
  });
  let released = false;
  return {
    ...admitted,
    alive: true,
    async release() {
      if (released) return;
      await withAdmissionLock(stateDirectory, async () => {
        if (released) return;
        await unlink(join(deployDirectory(stateDirectory), 'leases', `${admitted.id}.json`));
        released = true;
      });
    },
  };
}

/** Includes dead leases for diagnostics; only alive leases prevent completing a drain. */
export async function listAdmissions(stateDirectory: string): Promise<Admission[]> {
  return withAdmissionLock(stateDirectory, () => readAdmissions(stateDirectory));
}

export async function armDeployment(stateDirectory: string, targetBuildId: string): Promise<void> {
  await withAdmissionLock(stateDirectory, async () => {
    const current = await readIntent(stateDirectory);
    if (current && ['armed', 'waiting', 'draining'].includes(current.status)) throw new Error('deployment_in_progress');
    await writeIntent(stateDirectory, DeploymentIntent.parse({ status: 'armed', targetBuildId }));
  });
}

export async function markDeploymentWaiting(stateDirectory: string, targetBuildId: string): Promise<void> {
  await withAdmissionLock(stateDirectory, async () => {
    const current = await readIntent(stateDirectory);
    if (!current || current.targetBuildId !== targetBuildId || current.status !== 'armed') {
      throw new Error('deployment_not_armed');
    }
    await writeIntent(stateDirectory, { ...current, status: 'waiting' });
  });
}

/** Cancels before drain under the same gate lock; existing admissions continue unaffected. */
export async function cancelDeployment(stateDirectory: string, targetBuildId: string): Promise<DeploymentIntent> {
  return withAdmissionLock(stateDirectory, async () => {
    const current = await readIntent(stateDirectory);
    if (!current) throw new Error('pending_missing');
    if (current.targetBuildId !== targetBuildId) throw new Error('deployment_target_mismatch');
    if (current.status === 'completed') throw new Error('cannot_cancel_completed');
    if (current.status === 'draining') throw new Error('cannot_cancel_draining');
    if (current.status === 'cancelled') return current;
    const cancelled = { ...current, status: 'cancelled' as const };
    await writeIntent(stateDirectory, cancelled);
    return cancelled;
  });
}

/** Prevents new admissions at the same lock boundary where existing leases are enumerated. */
export async function beginDrain(stateDirectory: string, targetBuildId: string): Promise<Admission[]> {
  return withAdmissionLock(stateDirectory, async () => {
    const current = await readIntent(stateDirectory);
    if (!current) throw new Error('deployment_not_armed');
    if (current.targetBuildId !== targetBuildId) throw new Error('deployment_target_mismatch');
    if (!['armed', 'waiting', 'draining'].includes(current.status)) throw new Error('deployment_not_armed');
    const admissions = await readAdmissions(stateDirectory);
    if (current.status !== 'draining') await writeIntent(stateDirectory, { ...current, status: 'draining' });
    return admissions;
  });
}

/** Resume ordinary admissions before a switch has been checkpointed; the worker serializes this with checkpoint writes. */
export async function pauseDrain(stateDirectory: string, targetBuildId: string): Promise<void> {
  await withAdmissionLock(stateDirectory, async () => {
    const current = await readIntent(stateDirectory);
    if (!current || current.status !== 'draining') throw new Error('deployment_not_draining');
    if (current.targetBuildId !== targetBuildId) throw new Error('deployment_target_mismatch');
    try {
      await readFile(join(deployDirectory(stateDirectory), 'rollback.json'));
      throw new Error('rollback_unverified_gate_held');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeIntent(stateDirectory, { ...current, status: 'waiting' });
  });
}

/** Only a drained deployment can leave the admission gate; dead leases remain visible. */
export async function releaseDrain(
  stateDirectory: string,
  targetBuildId: string,
  status: 'completed' | 'cancelled',
): Promise<void> {
  await withAdmissionLock(stateDirectory, async () => {
    const current = await readIntent(stateDirectory);
    if (!current || current.status !== 'draining') throw new Error('deployment_not_draining');
    if (current.targetBuildId !== targetBuildId) throw new Error('deployment_target_mismatch');
    if ((await readAdmissions(stateDirectory)).some(admission => admission.alive)) {
      throw new Error('deployment_admissions_active');
    }
    await writeIntent(stateDirectory, { ...current, status });
  });
}
