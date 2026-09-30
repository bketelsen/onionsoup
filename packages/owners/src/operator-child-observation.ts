import { createHash } from 'node:crypto';
import { operatorJobEvent } from './operator-jobs.ts';
import { OPERATOR_JOB_LIMITS, type OperatorChild, type OperatorJob, type OperatorSessionSnapshot } from './operator-jobs-types.ts';
import { operatorChildBlock } from './operator-scheduler.ts';
import { clearOperatorUncertainty } from './operator-uncertainty.ts';

export type OperatorUnknown = (job: OperatorJob, child: OperatorChild,
  kind: NonNullable<OperatorChild['uncertainty']>['kind'], reason: string) => void;

export function assertOperatorCurrentTurn(child: OperatorChild, snapshot: OperatorSessionSnapshot) {
  const lastUser = snapshot.messages.filter(message => message.role === 'user').at(-1);
  const attempt = child.attempts.at(-1);
  if (attempt && lastUser?.id !== attempt.messageID) throw new Error('operator_child_turn_changed_or_uncertain');
  if (!attempt && snapshot.messages.length) throw new Error('operator_child_foreign_work');
}

export function operatorChildHasNewEvidence(child: OperatorChild, snapshot: OperatorSessionSnapshot) {
  const prior = child.attempts.at(-1);
  return prior && snapshot.messages.some(message => message.parentID === prior.messageID && message.completed && !message.error);
}

function complete(job: OperatorJob, child: OperatorChild, snapshot: OperatorSessionSnapshot) {
  const attempt = child.attempts.at(-1)!;
  const replies = snapshot.messages.filter(message => message.role === 'assistant' && message.parentID === attempt.messageID);
  const final = replies.at(-1)!;
  const tools = replies.flatMap(message => message.tools);
  child.evidence = {
    sessionID: child.sessionID!, promptID: attempt.messageID, messageID: final.id,
    text: final.text.trim().slice(0, OPERATOR_JOB_LIMITS.textChars),
    truncated: final.text.length > OPERATOR_JOB_LIMITS.textChars, originalChars: final.text.length,
    fullTextDigest: createHash('sha256').update(final.text).digest('hex'),
    tools: tools.filter(tool => tool.status === 'completed' || tool.status === 'error') as NonNullable<OperatorChild['evidence']>['tools'],
  };
  attempt.endedAt ??= new Date().toISOString();
  child.status = 'completed';
  delete child.blocker;
  clearOperatorUncertainty(child);
  operatorJobEvent(job, 'progress', 'Exact child turn completed; transcript evidence recorded, conclusions remain model claims.', child.id);
}

function recoverUnsent(job: OperatorJob, child: OperatorChild, snapshot: OperatorSessionSnapshot) {
  if (!['operator_child_runtime_unavailable', 'operator_child_operation_expired'].includes(child.blocker ?? '')) return;
  if (snapshot.status !== 'idle' || snapshot.messages.length) {
    operatorChildBlock(job, child, 'operator_child_foreign_work');
    return;
  }
  child.status = 'queued';
  delete child.blocker;
  clearOperatorUncertainty(child);
  operatorJobEvent(job, 'progress', 'Unsent child session observation recovered; no prompt was previously attempted.', child.id);
}

export function observeOperatorChild(job: OperatorJob, child: OperatorChild, snapshot: OperatorSessionSnapshot,
  graceMs: number, unknown: OperatorUnknown) {
  const attempt = child.attempts.at(-1);
  if (!attempt) return recoverUnsent(job, child, snapshot);
  const knownPrompts = new Set(child.attempts.map(previous => previous.messageID));
  if (snapshot.messages.some(message => message.role === 'user' && !knownPrompts.has(message.id))) {
    operatorChildBlock(job, child, 'operator_child_foreign_work');
    clearOperatorUncertainty(child);
    return;
  }
  const receipt = snapshot.messages.find(message => message.id === attempt.messageID && message.role === 'user');
  if (!receipt) {
    if (Date.now() - Date.parse(attempt.createdAt) >= graceMs) unknown(job, child, 'dispatch', 'operator_child_dispatch_uncertain');
    return;
  }
  if (snapshot.messages.filter(message => message.role === 'user').at(-1)?.id !== attempt.messageID) {
    operatorChildBlock(job, child, 'operator_child_foreign_work');
    return;
  }
  const replies = snapshot.messages.filter(message => message.role === 'assistant' && message.parentID === attempt.messageID);
  const final = replies.at(-1);
  const hasPendingTools = replies.some(message => message.tools.some(tool => ['pending', 'running'].includes(tool.status)));
  if (snapshot.status !== 'idle' || hasPendingTools) {
    clearOperatorUncertainty(child);
    if (child.status === 'blocked' || child.status === 'dispatching') {
      child.status = 'running';
      delete child.blocker;
      operatorJobEvent(job, 'progress', 'Runtime observation recovered; the original child turn remains active.', child.id);
    }
    return;
  }
  if (final?.completed && !final.error && final.text.trim()) return complete(job, child, snapshot);
  if (Date.now() - Date.parse(attempt.sentAt ?? attempt.createdAt) < graceMs) return;
  attempt.endedAt ??= new Date().toISOString();
  attempt.reason ??= final?.error ? 'operator_child_turn_error' : 'operator_child_interrupted';
  clearOperatorUncertainty(child);
  operatorChildBlock(job, child, attempt.reason);
}
