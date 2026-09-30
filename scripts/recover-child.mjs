import { parseArgs } from 'node:util';
import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChildIdentity, childRecoverySnapshot, recordChildAbandonment } from '../packages/owners/src/child-recovery.ts';
import { withRecordLock } from '../packages/owners/src/record-lock.ts';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { createAdmission, readOpencodeEndpoint } from './deploy-admission.mjs';

/** Operator-only command: no model tool or HTTP approval endpoint exposes this authority. */
export async function recoverChild(input) {
  if (!isAbsolute(input.state ?? '') || !isAbsolute(input.config ?? '')) throw new Error('child_recovery_paths_required');
  if ((await stat(input.state)).uid !== process.getuid()) throw new Error('child_recovery_uid_mismatch');
  const identity = ChildIdentity.parse({ childID: input.child, parentID: input.parent, directory: input.directory });
  const runtime = await Runtime.open({ state: input.state, declarations: input.config });
  const admission = await createAdmission(input);
  return withRecordLock(join(input.state, 'deploy', 'admission.lock'), async () => {
    // The lock prevents new turns. Existing turns are checked repeatedly through the authenticated endpoint.
    const endpoint = await (input.admissionEffects?.endpoint ?? readOpencodeEndpoint)(input.state);
    const snapshot = childRecoverySnapshot(identity);
    if (snapshot.completed) throw new Error('child_recovery_already_completed');
    if ((await runtime.ledger.list()).some(item => item.activeRunner)) throw new Error('child_recovery_active_work');
    const candidate = { ...identity, digest: snapshot.digest };
    if (!await admission.childRecoveryQuiet(candidate, endpoint)) throw new Error('child_recovery_not_idle');
    if (childRecoverySnapshot(identity).digest !== snapshot.digest) throw new Error('child_recovery_evidence_changed');
    if (!input.approveDigest) return { ...candidate, state: 'preview', messages: snapshot.messages.length,
      parts: snapshot.parts.length, completion: 'unfinished', action: 'abandon without deleting or claiming completion' };
    if (input.approveDigest !== snapshot.digest) throw new Error('child_recovery_approval_stale');
    if (!input.approvedBy?.trim()) throw new Error('child_recovery_approver_required');
    if (!input.reason?.trim()) throw new Error('child_recovery_reason_required');
    return recordChildAbandonment(input.state, { ...candidate, version: 1, state: 'abandoned',
      approvedBy: input.approvedBy, recordedBy: userInfo().username, approvedAt: new Date().toISOString(), reason: input.reason });
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    state: { type: 'string' }, config: { type: 'string' }, child: { type: 'string' }, parent: { type: 'string' },
    directory: { type: 'string' }, 'approve-digest': { type: 'string' }, 'approved-by': { type: 'string' }, reason: { type: 'string' },
  } });
  try { console.log(JSON.stringify(await recoverChild({ ...values, approveDigest: values['approve-digest'], approvedBy: values['approved-by'] }), null, 2)); }
  catch (error) {
    // Endpoint credentials and transport responses must never reach operator logs.
    console.error(error instanceof Error && /^child_recovery_[a-z_]+$/.test(error.message) ? error.message : 'child_recovery_unavailable');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
