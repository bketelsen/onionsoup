import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OperatorCheckInspection, OperatorCheckOwner } from './operator-check-execution.ts';
import { applicationIdentity, assertApplicationIntentPaths, assertApplicationStopped,
  pinApplicationParent, sameApplicationIdentity } from './operator-application-writer-files.ts';
import { OperatorApplicationFileIntent, type OperatorApplicationFileIdentity,
  type OperatorApplicationFileObservation } from './operator-application-writer-types.ts';

async function entry(parent: number, path: string) {
  let file;
  try { file = await open(`/proc/self/fd/${parent}/${basename(path)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try { return await applicationIdentity(file, path); }
  finally { await file.close(); }
}

function stageValid(stage: OperatorApplicationFileIdentity | undefined, intent: OperatorApplicationFileIntent, linked: boolean) {
  return !stage || (sameApplicationIdentity(stage, intent.stage) && stage.sha256 === intent.stage.sha256
    && stage.links === (linked ? 2 : 1));
}

function classify(intent: OperatorApplicationFileIntent, target?: OperatorApplicationFileIdentity,
  stage?: OperatorApplicationFileIdentity): OperatorApplicationFileObservation {
  const facts = { ...(target ? { target } : {}), ...(stage ? { stage } : {}) };
  const created = intent.before === 'absent';
  if (target && sameApplicationIdentity(target, created ? intent.stage : intent.before as OperatorApplicationFileIdentity)
    && target.sha256 === intent.mutation.afterSha256 && target.links === (created && stage ? 2 : 1)
    && stageValid(stage, intent, created && !!stage)) return { state: 'after', reason: 'operator_application_after_observed', ...facts };
  if (!stage || !stageValid(stage, intent, false)) return { state: 'foreign', reason: 'operator_application_stage_changed', ...facts };
  if (created) return { state: target ? 'foreign' : 'before',
    reason: target ? 'operator_application_destination_exists' : 'operator_application_before_observed', ...facts };
  if (!target || !sameApplicationIdentity(target, intent.before as OperatorApplicationFileIdentity) || target.links !== 1) {
    return { state: 'foreign', reason: 'operator_application_target_changed', ...facts };
  }
  return { state: target.sha256 === intent.mutation.beforeSha256 ? 'before' : 'partial',
    reason: target.sha256 === intent.mutation.beforeSha256 ? 'operator_application_before_observed' : 'operator_application_partial_bytes', ...facts };
}

/** File facts become application evidence only after the caller supplies the exact attempt's positive stop proof. */
export async function inspectOperatorApplicationFile(input: OperatorApplicationFileIntent,
  inspection: OperatorCheckInspection, expectedOwner: OperatorCheckOwner): Promise<OperatorApplicationFileObservation> {
  assertApplicationStopped(inspection, expectedOwner);
  const intent = OperatorApplicationFileIntent.parse(input);
  assertApplicationIntentPaths(intent);
  let parent;
  try {
    parent = await pinApplicationParent(intent.directory, intent.mutation.path, intent.parents);
    const target = await entry(parent.handle.fd, intent.mutation.path);
    const stage = await entry(parent.handle.fd, intent.stage.path);
    return classify(intent, target, stage);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const foreign = /^operator_application_(parent_changed|file_invalid|file_changed)$/.test(reason)
      || ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
    return { state: foreign ? 'foreign' : 'unavailable', reason: foreign ? 'operator_application_identity_changed' : 'operator_application_inspection_unavailable' };
  } finally { await parent?.close(); }
}

/** The host first durably records the observed result. This only removes its exact staging name, never the target. */
export async function cleanupOperatorApplicationStage(input: OperatorApplicationFileIntent,
  inspection: OperatorCheckInspection, expectedOwner: OperatorCheckOwner) {
  const intent = OperatorApplicationFileIntent.parse(input);
  const observed = await inspectOperatorApplicationFile(intent, inspection, expectedOwner);
  if (observed.state !== 'after') throw new Error('operator_application_cleanup_unproven');
  if (!observed.stage) return;
  const parent = await pinApplicationParent(intent.directory, intent.stage.path, intent.parents);
  try {
    const stage = await entry(parent.handle.fd, intent.stage.path);
    if (!stage || !sameApplicationIdentity(stage, intent.stage) || stage.sha256 !== intent.stage.sha256
      || stage.links !== observed.stage.links) throw new Error('operator_application_stage_changed');
    await unlink(`/proc/self/fd/${parent.handle.fd}/${basename(intent.stage.path)}`);
    await parent.handle.sync();
  } finally { await parent.close(); }
}
