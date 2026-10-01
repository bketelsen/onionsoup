import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { operatorCheckProcessIdentity as processIdentity, readOperatorCheckOwner,
  type OperatorCheckWitness } from './operator-check-execution.ts';

export const OPERATOR_NAMESPACE_LIMITS = { metadataBytes: 4096, startupMs: 15_000,
  terminationMs: 5_000, pollMs: 20, ancestry: 8 };
type ProcessIdentity = ReturnType<typeof processIdentity>;

async function assertDescendant(identity: ProcessIdentity, launchPID: number) {
  let parent = identity.parent;
  for (let depth = 0; depth < OPERATOR_NAMESPACE_LIMITS.ancestry; depth++) {
    if (parent === launchPID) return;
    if (parent <= 1) break;
    parent = processIdentity(await readFile(`/proc/${parent}/stat`, 'utf8')).parent;
  }
  throw new Error('operator_check_process_uncertain');
}

async function pinNamespace(metadata: string, launchPID: number | undefined) {
  const report: unknown = JSON.parse(metadata);
  const pid = report && typeof report === 'object' ? Reflect.get(report, 'child-pid') : undefined;
  if (!launchPID || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('operator_check_process_uncertain');
  const handle = await open(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const path = `/proc/self/fd/${handle.fd}`;
    const identity = processIdentity(await readFile(`${path}/stat`, 'utf8'));
    const status = await readFile(`${path}/status`, 'utf8');
    const namespace = status.match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/).map(Number);
    if (identity.pid !== pid || namespace?.[0] !== pid || namespace?.at(-1) !== 1) {
      throw new Error('operator_check_process_uncertain');
    }
    await assertDescendant(identity, launchPID);
    return { handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function waitForNamespaceDeath(pinned: Awaited<ReturnType<typeof pinNamespace>>) {
  const deadline = Date.now() + OPERATOR_NAMESPACE_LIMITS.terminationMs;
  while (true) {
    let current: ProcessIdentity;
    try { current = processIdentity(await readFile(`/proc/self/fd/${pinned.handle.fd}/stat`, 'utf8')); }
    catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw new Error('operator_check_process_uncertain');
    }
    if (current.pid !== pinned.identity.pid || current.started !== pinned.identity.started) {
      throw new Error('operator_check_process_uncertain');
    }
    // A zombie init leader can still have live threads; only disappearance proves the whole identity was released.
    if (Date.now() >= deadline) throw new Error('operator_check_process_uncertain');
    await new Promise(resolve => setTimeout(resolve, OPERATOR_NAMESPACE_LIMITS.pollMs));
  }
}

/** The barrier prevents command execution until the trusted init PID has a pinned proc identity. */
export function operatorNamespaceWitness(child: ChildProcess, informationFD: number, barrierFD: number,
  onWitness?: (witness: OperatorCheckWitness) => Promise<void>) {
  const information = child.stdio[informationFD] as Duplex;
  const barrier = child.stdio[barrierFD] as Duplex;
  let metadata = '';
  let released = false;
  let decided = false;
  let pinned: Awaited<ReturnType<typeof pinNamespace>> | undefined;
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const deny = () => {
    if (decided) return;
    decided = true;
    clearTimeout(startup);
    // EOF releases bwrap's block-fd too, so retain the barrier until the process group is proved dead.
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* The caller must still prove shutdown. */ }
    finish();
  };
  const startup = setTimeout(deny, OPERATOR_NAMESPACE_LIMITS.startupMs);
  information.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(metadata) + chunk.length > OPERATOR_NAMESPACE_LIMITS.metadataBytes) return deny();
    metadata += chunk.toString();
  });
  information.once('error', deny);
  barrier.once('error', deny);
  if (onWitness) child.stdin?.once('error', deny);
  information.once('end', () => {
    if (decided) return;
    void pinNamespace(metadata, child.pid).then(async witness => {
      if (decided) { await witness.handle.close(); return; }
      pinned = witness;
      if (onWitness) {
        const launcher = processIdentity(await readFile(`/proc/${child.pid}/stat`, 'utf8'));
        if (launcher.pid !== child.pid || launcher.group !== child.pid) throw new Error('operator_check_process_uncertain');
        const identity = (process: ProcessIdentity) => ({ pid: process.pid, started: process.started });
        await onWitness({ version: 1, owner: await readOperatorCheckOwner(),
          launcher: identity(launcher), namespace: identity(witness.identity) });
        if (decided) return;
      }
      decided = true;
      clearTimeout(startup);
      released = true;
      barrier.write(Buffer.from([1]));
      if (onWitness) child.stdin!.end(Buffer.from([1]));
      finish();
    }).catch(deny);
  });
  return {
    async wait() {
      await ready;
      if (pinned) await waitForNamespaceDeath(pinned);
      return released;
    },
    async close(groupExited: boolean) {
      clearTimeout(startup);
      if (pinned) await pinned.handle.close();
      information.destroy();
      if (released || groupExited) barrier.destroy();
      // The guarded protocol refuses EOF, so closing this pipe is safe even with unproved outer shutdown.
      if (onWitness) child.stdin?.destroy();
    },
  };
}
