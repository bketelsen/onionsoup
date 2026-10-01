import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { OperatorCheckInspection, OperatorCheckOwner } from './operator-check-execution.ts';
import { operatorWriteSha256, type OperatorWriteSnapshot } from './operator-write-workspace.ts';
import { OPERATOR_APPLICATION_WRITER_LIMITS, type OperatorApplicationFileIdentity, type OperatorApplicationFileIntent } from './operator-application-writer-types.ts';

export function applicationPath(path: string) {
  if (!path || isAbsolute(path) || /[\\\0]/.test(path)
    || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) throw new Error('operator_application_path_invalid');
}

export function applicationStagePath(path: string, id: string, snapshotDigest: string) {
  const name = `${OPERATOR_APPLICATION_WRITER_LIMITS.stagingPrefix}${operatorWriteSha256(JSON.stringify([id, path, snapshotDigest])).slice(0, 40)}`;
  return dirname(path) === '.' ? name : `${dirname(path)}/${name}`;
}

export async function pinApplicationParent(directory: string, path: string, parents: OperatorWriteSnapshot['parents']) {
  applicationPath(path);
  const handles: FileHandle[] = [];
  try {
    let parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    const pieces = path.split('/');
    for (let index = 0; index < pieces.length; index++) {
      if (index) {
        parent = await open(`/proc/self/fd/${parent.fd}/${pieces[index - 1]}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(parent);
      }
      const expected = parents.find(entry => entry.path === pieces.slice(0, index).join('/'));
      const actual = await parent.stat();
      if (!expected || actual.dev !== expected.device || actual.ino !== expected.inode) throw new Error('operator_application_parent_changed');
    }
    return { handle: parent, target: `/proc/self/fd/${parent.fd}/${basename(path)}`,
      close: async () => { for (const handle of handles.reverse()) await handle.close(); } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}

export async function applicationIdentity(file: FileHandle, path: string): Promise<OperatorApplicationFileIdentity> {
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(OPERATOR_APPLICATION_WRITER_LIMITS.fileBytes)) throw new Error('operator_application_file_invalid');
  const content = Buffer.alloc(Number(before.size) + 1);
  let offset = 0;
  while (offset < content.length) {
    const read = await file.read(content, offset, content.length - offset, offset);
    if (!read.bytesRead) break;
    offset += read.bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || offset !== Number(after.size) || !/^[1-9][0-9]*$/.test(after.birthtimeNs.toString())) throw new Error('operator_application_file_changed');
  return { path, sha256: operatorWriteSha256(content.subarray(0, offset)), bytes: offset, mode: Number(after.mode),
    device: Number(after.dev), inode: Number(after.ino), links: Number(after.nlink), kind: 'file', birthtimeNs: after.birthtimeNs.toString() };
}

export function sameApplicationIdentity(actual: OperatorApplicationFileIdentity, expected: OperatorApplicationFileIdentity) {
  return actual.device === expected.device && actual.inode === expected.inode && actual.mode === expected.mode
    && (!expected.birthtimeNs || actual.birthtimeNs === expected.birthtimeNs);
}

export function assertApplicationStopped(inspection: OperatorCheckInspection, owner: OperatorCheckOwner) {
  const parsed = OperatorCheckInspection.parse(inspection);
  if (parsed.state !== 'stopped' || !parsed.proof
    || JSON.stringify(parsed.proof.owner) !== JSON.stringify(OperatorCheckOwner.parse(owner))) {
    throw new Error('operator_application_process_unproven');
  }
}

export function assertApplicationIntentPaths(intent: OperatorApplicationFileIntent) {
  applicationPath(intent.mutation.path);
  if (intent.stage.path !== applicationStagePath(intent.mutation.path, intent.mutation.id, intent.mutation.snapshotDigest)) {
    throw new Error('operator_application_stage_invalid');
  }
}
