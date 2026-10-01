import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { OperatorChild, OperatorJob, OperatorSupervisorClient } from './operator-jobs-types.ts';
import type { OperatorJobs } from './operator-jobs.ts';

export type OperatorWriteContext = Pick<ToolContext, 'sessionID' | 'messageID' | 'agent' | 'directory' | 'abort' | 'ask' | 'metadata'>;

export function writeChild(job: OperatorJob, id: string) {
  const child = job.children.find(candidate => candidate.id === id);
  if (!child?.write || child.access !== 'write') throw new Error('operator_write_missing_scope');
  return child as OperatorChild & { write: NonNullable<OperatorChild['write']> };
}

export function writeReceipts(child: OperatorChild) {
  if (!child.write || child.write.operations.some(operation => operation.status === 'prepared')) {
    throw new Error('operator_write_effect_uncertain');
  }
  return child.write.operations.filter(operation => operation.status === 'applied').map(operation => {
    if (!operation.receipt) throw new Error('operator_write_receipt_missing');
    return operation.receipt;
  });
}

export function operatorWriteLock(jobs: OperatorJobs, jobID: string, childID: string) {
  return join(jobs.home, 'operator-jobs', 'write-locks', `${jobID}-${childID}.lock`);
}

export async function assertOperatorWriteCall(client: OperatorSupervisorClient, child: OperatorChild,
  context: OperatorWriteContext, callID: string, tool: string) {
  const attempt = child.attempts.at(-1);
  if (!attempt || attempt.endedAt || child.abandonment || !child.sessionID || child.directory !== context.directory
    || child.write?.acceptance || !['running', 'dispatching'].includes(child.status)
    || child.blocker === 'operator_child_foreign_work') throw new Error('operator_write_child_not_running');
  const snapshot = await client.readSession(child.directory, child.sessionID);
  const known = new Set(child.attempts.map(candidate => candidate.messageID));
  const message = snapshot.messages.find(candidate => candidate.id === context.messageID && candidate.role === 'assistant');
  const call = message?.tools.find(candidate => candidate.callID === callID && candidate.tool === tool);
  if (message?.parentID !== attempt.messageID || !call || call.status !== 'running'
    || snapshot.messages.some(candidate => candidate.role === 'user' && !known.has(candidate.id))) {
    throw new Error('operator_write_call_unbound');
  }
}

/** Short ledger CAS used after slow runtime/filesystem reads. */
export function assertOperatorWriteUnchanged(current: OperatorChild, previous: OperatorChild, context: OperatorWriteContext) {
  context.abort.throwIfAborted();
  if (JSON.stringify(current.write) !== JSON.stringify(previous.write) || current.abandonment
    || current.attempts.at(-1)?.endedAt || current.attempts.at(-1)?.messageID !== previous.attempts.at(-1)?.messageID
    || current.sessionID !== context.sessionID || !['running', 'dispatching'].includes(current.status)
    || current.blocker === 'operator_child_foreign_work') throw new Error('operator_write_scope_stale');
}
