import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { type OperatorJobInput, OPERATOR_INVESTIGATOR, type OperatorChild, type OperatorJob,
  type OperatorJobIntake, type OperatorJobOrigin, type OperatorSessionSnapshot, type OperatorSupervisorClient } from './operator-jobs-types.ts';
import { OperatorJobs, operatorJobEvent, operatorWriteScopeDigest, operatorWriteReviewDigest } from './operator-jobs.ts';
import { assertOperatorWriteTerminal } from './operator-write-state.ts';
import { operatorChild } from './operator-child-scope.ts';
import { withRecordLock } from './record-lock.ts';
import { snapshotOperatorWriteWorkspace, prepareOperatorFileMutation, applyOperatorFileMutation,
  operatorWriteArtifact, type OperatorWriteSnapshot } from './operator-write-workspace.ts';
import type { OperatorWritePermissions } from './operator-write-permission.ts';
import { OPERATOR_WRITE_TOOL, type OperatorFileInput } from './operator-write-call.ts';

type Context = Pick<ToolContext, 'sessionID' | 'messageID' | 'agent' | 'directory' | 'abort' | 'ask' | 'metadata'>;
const WARNING = 'Approve only these named existing text files and this exact original task. No shell, new files, deletes, '
  + 'commits, pushes or persistent grants. Each workspace remains reserved until its exact diff is accepted after verified completion. '
  + 'Unknown writes stay blocked; approval does not authorize retrying them.';

function writeChild(job: OperatorJob, id: string) {
  const child = job.children.find(candidate => candidate.id === id);
  if (!child?.write || child.access !== 'write') throw new Error('operator_write_missing_scope');
  return child as OperatorChild & { write: NonNullable<OperatorChild['write']> };
}
function receipts(child: OperatorChild) {
  if (!child.write || child.write.operations.some(operation => operation.status === 'prepared')) {
    throw new Error('operator_write_effect_uncertain');
  }
  return child.write.operations.filter(operation => operation.status === 'applied').map(operation => {
    if (!operation.receipt) throw new Error('operator_write_receipt_missing');
    return operation.receipt;
  });
}
function checkContext(origin: OperatorJobOrigin, context: Context) {
  context.abort.throwIfAborted();
  if (context.sessionID !== origin.sessionID || context.agent !== origin.operator) throw new Error('operator_write_parent_mismatch');
}

/** Host facts and effects are separate from model claims. No runtime or Git call holds the ledger lock. */
export class OperatorWrites {
  constructor(readonly jobs: OperatorJobs, readonly client: OperatorSupervisorClient,
    readonly permissions: OperatorWritePermissions) {}

  async create(originInput: OperatorJobOrigin, intakeInput: OperatorJobIntake, value: OperatorJobInput, context: Context) {
    const { origin, intake, input } = await this.jobs.prepare(originInput, intakeInput, value);
    checkContext(origin, context);
    const existing = (await this.jobs.list(origin)).find(job => job.key === input.key);
    if (existing) return this.existing(existing, origin, intake, input);
    const baselines = await this.baselines(input);
    const scopeDigest = operatorWriteScopeDigest(origin, intake, input, baselines);
    const proof = await this.permissions.ask(context, { patterns: [`create-write/${scopeDigest}`], metadata: {
      approvalScope: 'once', mode: 'create-write', action: 'Approve this exact write task', warning: WARNING, origin, intake, input,
      workspaces: Object.entries(baselines).map(([id, baseline]) => ({ id, directory: baseline.directory,
        head: baseline.head, files: baseline.approvedPaths, digest: baseline.digest })), scopeDigest,
    } });
    checkContext(origin, context);
    const current = await this.baselines(input);
    if (operatorWriteScopeDigest(origin, intake, input, current) !== scopeDigest) throw new Error('operator_write_scope_stale');
    return this.jobs.createApproved(origin, intake, input, { scopeDigest, proof, baselines: current });
  }

  private existing(job: OperatorJob, origin: OperatorJobOrigin, intake: OperatorJobIntake, input: OperatorJobInput) {
    const writes = job.children.filter(child => child.write);
    if (!writes.length) throw new Error('operator_write_idempotency_conflict');
    const baselines = Object.fromEntries(writes.map(child => [child.id, child.write!.baseline]));
    const approval = writes[0]!.write!.approval;
    if (operatorWriteScopeDigest(origin, intake, input, baselines) !== approval.scopeDigest) {
      throw new Error('operator_write_idempotency_conflict');
    }
    return this.jobs.createApproved(origin, intake, input, { ...approval, baselines });
  }

  private async baselines(input: OperatorJobInput) {
    const entries: Array<[string, OperatorWriteSnapshot]> = [];
    for (const task of input.tasks.filter(task => task.access === 'write')) {
      const baseline = await snapshotOperatorWriteWorkspace({ workspace: this.jobs.workspace, directory: task.directory, files: task.files! });
      entries.push([task.id, baseline]);
    }
    return Object.fromEntries(entries);
  }

  async inspect(_job: OperatorJob, child: OperatorChild, snapshot: OperatorSessionSnapshot) {
    if (!child.write) throw new Error('operator_write_missing_scope');
    for (const operation of child.write.operations) {
      const message = snapshot.messages.find(candidate => candidate.id === operation.messageID && candidate.role === 'assistant');
      const call = message?.tools.find(candidate => candidate.callID === operation.callID && candidate.tool === OPERATOR_WRITE_TOOL);
      if (!call || !['completed', 'error'].includes(call.status)
        || !child.attempts.some(attempt => attempt.messageID === message?.parentID)) throw new Error('operator_write_call_evidence_missing');
    }
    return operatorWriteArtifact(child.write.baseline, receipts(child));
  }

  async review(origin: OperatorJobOrigin, id: string, childID: string) {
    const job = await this.jobs.get(origin, id);
    const child = writeChild(job, childID);
    if (child.status !== 'needs-review' || !child.sessionID || child.operation) throw new Error('operator_write_not_reviewable');
    const snapshot = await this.client.readSession(child.directory, child.sessionID);
    assertOperatorWriteTerminal(child, snapshot);
    const artifact = await this.inspect(job, child, snapshot);
    if (JSON.stringify(artifact) !== JSON.stringify(child.write.artifact)) throw new Error('operator_write_artifact_changed');
    const current = await this.jobs.get(origin, id);
    const digest = operatorWriteReviewDigest(job, child);
    if (operatorWriteReviewDigest(current, writeChild(current, childID)) !== digest) throw new Error('operator_write_review_stale');
    return { job, child, artifact, snapshot, digest };
  }

  async accept(origin: OperatorJobOrigin, id: string, childID: string, digest: string, context: Context) {
    checkContext(origin, context);
    const existing = await this.jobs.get(origin, id);
    const accepted = writeChild(existing, childID).write.acceptance;
    if (accepted) {
      if (accepted.digest !== digest) throw new Error('operator_write_acceptance_conflict');
      return existing;
    }
    const preview = await this.review(origin, id, childID);
    if (preview.digest !== digest) throw new Error('operator_write_review_stale');
    const proof = await this.permissions.ask(context, { patterns: [`accept-write/${id}/${childID}/${digest}`], metadata: {
      approvalScope: 'once', mode: 'accept-write', action: 'Accept this exact completed diff and release its workspace reservation',
      warning: 'This records acceptance of the shown edits, not test success or a commit. No commit, push or merge occurs. '
        + 'The workspace remains dirty; future jobs require a new clean baseline.',
      jobID: id, childID, directory: preview.child.directory,
      originalIntake: preview.job.intake, goal: preview.job.goal, constraints: preview.job.constraints,
      artifact: preview.artifact, evidence: preview.child.evidence, digest,
    } });
    checkContext(origin, context);
    const afterApproval = await this.jobs.get(origin, id);
    const concurrentAcceptance = writeChild(afterApproval, childID).write.acceptance;
    if (concurrentAcceptance) {
      if (concurrentAcceptance.digest !== digest) throw new Error('operator_write_acceptance_conflict');
      return afterApproval;
    }
    const current = await this.review(origin, id, childID);
    if (current.digest !== digest) throw new Error('operator_write_review_stale');
    return this.jobs.acceptWrite(origin, id, childID, digest, current.artifact, proof, current.snapshot);
  }

  async file(context: Context, callID: string, input: OperatorFileInput) {
    if (context.agent !== OPERATOR_INVESTIGATOR) throw new Error('operator_write_child_only');
    const bound = await operatorChild(this.jobs, context.sessionID);
    if (!bound?.child.write) throw new Error('operator_write_child_unbound');
    const lock = join(this.jobs.home, 'operator-jobs', 'write-locks', `${bound.job.id}-${bound.child.id}.lock`);
    return withRecordLock(lock, () => this.apply(context, callID, input, bound.job.id, bound.child.id, bound.job.origin));
  }

  private async apply(context: Context, callID: string, input: OperatorFileInput,
    id: string, childID: string, origin: OperatorJobOrigin) {
    context.abort.throwIfAborted();
    const job = await this.jobs.get(origin, id);
    const child = writeChild(job, childID);
    await this.assertCall(child, context, callID);
    const previous = child.write.operations.find(operation => operation.callID === callID && operation.messageID === context.messageID);
    if (previous) throw new Error('operator_write_call_already_recorded');
    const prior = receipts(child);
    const mutation = await prepareOperatorFileMutation(child.write.baseline, prior, { ...input, id: randomUUID() });
    const before = JSON.stringify(child.write);
    await this.jobs.transaction(async (ledger, save) => {
      context.abort.throwIfAborted();
      const current = writeChild(this.jobs.bound(ledger, origin, id), childID);
      if (JSON.stringify(current.write) !== before || current.abandonment || current.attempts.at(-1)?.endedAt
        || current.attempts.at(-1)?.messageID !== child.attempts.at(-1)?.messageID
        || current.sessionID !== context.sessionID || !['running', 'dispatching'].includes(current.status)
        || current.blocker === 'operator_child_foreign_work') throw new Error('operator_write_scope_stale');
      current.write.operations.push({ callID, messageID: context.messageID, mutation, status: 'prepared', preparedAt: new Date().toISOString() });
      await save();
    });
    const receipt = await applyOperatorFileMutation(child.write.baseline, prior, mutation);
    return this.jobs.transaction(async (ledger, save) => {
      const currentJob = this.jobs.bound(ledger, origin, id);
      const current = writeChild(currentJob, childID);
      const operation = current.write.operations.find(candidate => candidate.mutation.id === mutation.id);
      if (!operation || operation.status !== 'prepared' || JSON.stringify(operation.mutation) !== JSON.stringify(mutation)) {
        throw new Error('operator_write_receipt_unbound');
      }
      operation.status = 'applied';
      operation.receipt = receipt;
      operation.resolvedAt = new Date().toISOString();
      operatorJobEvent(currentJob, 'progress', `Host verified named-file edit ${mutation.path}; final diff review remains required.`, childID);
      await save();
      return receipt;
    });
  }

  private async assertCall(child: OperatorChild, context: Context, callID: string) {
    const attempt = child.attempts.at(-1);
    if (!attempt || attempt.endedAt || child.abandonment || !child.sessionID || child.directory !== context.directory || child.write?.acceptance
      || !['running', 'dispatching'].includes(child.status) || child.blocker === 'operator_child_foreign_work') {
      throw new Error('operator_write_child_not_running');
    }
    const snapshot = await this.client.readSession(child.directory, child.sessionID);
    const known = new Set(child.attempts.map(candidate => candidate.messageID));
    const message = snapshot.messages.find(candidate => candidate.id === context.messageID && candidate.role === 'assistant');
    const call = message?.tools.find(candidate => candidate.callID === callID && candidate.tool === OPERATOR_WRITE_TOOL);
    if (message?.parentID !== attempt.messageID || !call || call.status !== 'running'
      || snapshot.messages.some(candidate => candidate.role === 'user' && !known.has(candidate.id))) {
      throw new Error('operator_write_call_unbound');
    }
  }
}
