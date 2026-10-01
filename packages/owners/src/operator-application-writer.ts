import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperatorWriteMutation, operatorWriteSha256, type OperatorWriteSnapshot } from './operator-write-workspace.ts';
import { alreadyMemoryCapped, preflightOperatorFileWriter } from './operator-write-writer.ts';
import { executeOperatorSandbox, OPERATOR_CHECK_RUNNER_LIMITS, pinOperatorCheckRuntime,
  type PinnedOperatorCheckMount } from './operator-check-runner.ts';
import { inspectOperatorCheckWitness, readOperatorCheckOwner, type OperatorCheckWitness } from './operator-check-execution.ts';
import { applicationIdentity, applicationPath, applicationStagePath, assertApplicationIntentPaths,
  pinApplicationParent, sameApplicationIdentity } from './operator-application-writer-files.ts';
import { inspectOperatorApplicationFile } from './operator-application-writer-observation.ts';
import { OPERATOR_APPLICATION_WRITER_LIMITS, OperatorApplicationFileIntent, operatorApplicationIntentDigest } from './operator-application-writer-types.ts';

export { OperatorApplicationFileIntent, OperatorApplicationFileObservation, OperatorApplicationFileIdentity,
  OPERATOR_APPLICATION_WRITER_LIMITS } from './operator-application-writer-types.ts';
export { inspectOperatorApplicationFile, cleanupOperatorApplicationStage } from './operator-application-writer-observation.ts';
const helper = fileURLToPath(new URL('./operator-application-writer-publish.mjs', import.meta.url));

function validateMutation(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation) {
  applicationPath(mutation.path);
  const bytes = Buffer.from(mutation.content, 'utf8');
  if (!snapshot.approvedPaths.includes(mutation.path) || mutation.snapshotDigest !== snapshot.digest
    || bytes.length > Math.min(snapshot.limits.fileBytes, OPERATOR_APPLICATION_WRITER_LIMITS.fileBytes)
    || bytes.includes(0) || bytes.toString('utf8') !== mutation.content || operatorWriteSha256(bytes) !== mutation.afterSha256) {
    throw new Error('operator_application_mutation_invalid');
  }
  return bytes;
}

async function beforeIdentity(snapshot: OperatorWriteSnapshot, mutation: OperatorWriteMutation, path: string) {
  const expected = snapshot.files.find(file => file.path === mutation.path);
  if (mutation.beforeSha256 === 'absent') {
    if (expected || !snapshot.createFiles?.includes(mutation.path)) throw new Error('operator_application_creation_not_approved');
    let existing;
    try { existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent' as const; throw error; }
    await existing.close();
    throw new Error('operator_application_destination_exists');
  }
  if (!expected || expected.kind !== 'file' || expected.sha256 !== mutation.beforeSha256 || expected.links !== 1) {
    throw new Error('operator_application_before_invalid');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await applicationIdentity(file, mutation.path);
    if (!sameApplicationIdentity(actual, expected) || actual.links !== 1 || actual.sha256 !== expected.sha256) {
      throw new Error('operator_application_before_changed');
    }
    return actual;
  } finally { await file.close(); }
}

/** Call only after target approval and its exclusive managed claim. Existing staging is never silently adopted. */
export async function prepareOperatorApplicationFile(snapshot: OperatorWriteSnapshot, input: OperatorWriteMutation, mode?: number) {
  const mutation = OperatorWriteMutation.parse(input);
  const bytes = validateMutation(snapshot, mutation);
  const parent = await pinApplicationParent(snapshot.directory, mutation.path, snapshot.parents);
  try {
    const before = await beforeIdentity(snapshot, mutation, parent.target);
    const desiredMode = mode ?? (before === 'absent' ? 0o100600 : before.mode);
    if (!Number.isSafeInteger(desiredMode) || desiredMode < 0 || desiredMode > 0o100777
      || (desiredMode & ~(constants.S_IFREG | 0o777)) !== 0
      || (before !== 'absent' && (desiredMode & 0o777) !== (before.mode & 0o777))) throw new Error('operator_application_mode_invalid');
    const stagePath = applicationStagePath(mutation.path, mutation.id, mutation.snapshotDigest);
    if (snapshot.approvedPaths.includes(stagePath)) throw new Error('operator_application_stage_conflict');
    const stage = await open(`/proc/self/fd/${parent.handle.fd}/${basename(stagePath)}`,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await stage.writeFile(bytes);
      await stage.chmod(desiredMode & 0o777);
      await stage.sync();
      await parent.handle.sync();
      const identity = await applicationIdentity(stage, stagePath);
      const intent = { version: 1 as const, directory: snapshot.directory, mutation,
        parents: snapshot.parents.filter(entry => entry.path === '' || mutation.path.startsWith(`${entry.path}/`)),
        before, stage: identity, digest: '0'.repeat(64) };
      intent.digest = operatorApplicationIntentDigest(intent);
      return OperatorApplicationFileIntent.parse(intent);
    } finally { await stage.close(); }
  } finally { await parent.close(); }
}

async function pinReadonly(path: string, destination: string, mounts: PinnedOperatorCheckMount[]) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  mounts.push({ handle, destination });
  if (!(await handle.stat()).isFile()) throw new Error('operator_application_runtime_invalid');
}

function sandboxArguments(mounts: PinnedOperatorCheckMount[], writable: string) {
  const binds = mounts.flatMap((mount, index) => [mount.destination === writable ? '--bind-fd' : '--ro-bind-fd', String(index + 3), mount.destination]);
  return ['--unshare-all', '--as-pid-1', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--info-fd', String(mounts.length + 3), '--block-fd', String(mounts.length + 4), ...binds,
    '--proc', '/proc', '--dev', '/dev', '--size', String(OPERATOR_CHECK_RUNNER_LIMITS.temporaryBytes), '--tmpfs', '/tmp',
    '--remount-ro', '/proc', '--remount-ro', '/dev', '--remount-ro', '/', '--clearenv',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/runtime',
    '--', '/runtime/node', '--max-old-space-size=128', '/runtime/operator-application-writer-publish.mjs'];
}

async function launchCommand(mounts: PinnedOperatorCheckMount[], writable: string) {
  const args = sandboxArguments(mounts, writable);
  const limits = OPERATOR_CHECK_RUNNER_LIMITS;
  if (await alreadyMemoryCapped(limits.memoryBytes, limits.tasksMax)) return { executable: '/usr/bin/bwrap', args };
  return { executable: '/usr/bin/systemd-run', args: ['--user', '--scope', '--quiet', '-p', `MemoryMax=${limits.memoryBytes}`,
    '-p', 'MemorySwapMax=0', '-p', `TasksMax=${limits.tasksMax}`, '--', '/usr/bin/bwrap', ...args] };
}

async function pinApplicationEffects(intent: OperatorApplicationFileIntent, parent: Awaited<ReturnType<typeof pinApplicationParent>>,
  mounts: PinnedOperatorCheckMount[]) {
  if (intent.before === 'absent') {
    const handle = await open(`/proc/self/fd/${parent.handle.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
    mounts.push({ handle, destination: '/target-parent' });
    return '/target-parent';
  }
  const file = await open(parent.target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  mounts.push({ handle: file, destination: '/target' });
  const identity = await applicationIdentity(file, intent.mutation.path);
  if (!sameApplicationIdentity(identity, intent.before) || identity.links !== 1 || identity.sha256 !== intent.mutation.beforeSha256) {
    throw new Error('operator_application_before_changed');
  }
  await pinReadonly(`/proc/self/fd/${parent.handle.fd}/${basename(intent.stage.path)}`, '/stage', mounts);
  return '/target';
}

/** The root host must durably save the intent and each attempt before calling; the awaited hook saves its witness. */
export async function runOperatorApplicationFile(input: OperatorApplicationFileIntent,
  options: { onWitness(witness: OperatorCheckWitness): Promise<void> }) {
  const intent = OperatorApplicationFileIntent.parse(input);
  assertApplicationIntentPaths(intent);
  const owner = await readOperatorCheckOwner();
  let parent: Awaited<ReturnType<typeof pinApplicationParent>> | undefined;
  const mounts: PinnedOperatorCheckMount[] = [];
  let temporary: string | undefined;
  let witness: OperatorCheckWitness | undefined;
  let launched = false;
  const noExecution = { state: 'stopped' as const, reason: 'operator_application_permit_not_sent',
    proof: { owner, observedAt: new Date().toISOString() } };
  try {
    parent = await pinApplicationParent(intent.directory, intent.mutation.path, intent.parents);
    const writable = await pinApplicationEffects(intent, parent, mounts);
    const { node } = await preflightOperatorFileWriter();
    await pinOperatorCheckRuntime(node, mounts);
    await pinReadonly(helper, '/runtime/operator-application-writer-publish.mjs', mounts);
    temporary = await mkdtemp(join(tmpdir(), 'operator-application-runtime-'));
    const payload = join(temporary, 'intent.json');
    await writeFile(payload, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
    await pinReadonly(payload, '/runtime/intent.json', mounts);
    const command = await launchCommand(mounts, writable);
    launched = true;
    const outcome = await executeOperatorSandbox(command, mounts, {
      onWitness: async identity => { witness = identity; await options.onWitness(identity); },
    });
    const inspection = witness ? await inspectOperatorCheckWitness(witness) : noExecution;
    const observation = await inspectOperatorApplicationFile(intent, inspection, owner);
    return { exitCode: outcome.exitCode, observation, inspection };
  } catch (error) {
    if (launched) throw error;
    return { exitCode: 125, observation: await inspectOperatorApplicationFile(intent, noExecution, owner), inspection: noExecution };
  } finally {
    for (const mount of mounts.reverse()) await mount.handle.close();
    await parent?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
