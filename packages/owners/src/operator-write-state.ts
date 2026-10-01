import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import type { OperatorChild, OperatorJob, OperatorJobInput, OperatorJobIntake, OperatorJobLedger,
  OperatorJobOrigin, OperatorWriteCreateApproval, OperatorSessionSnapshot } from './operator-jobs-types.ts';
import type { OperatorWriteSnapshot, OperatorWriteArtifact } from './operator-write-workspace.ts';

export function operatorWriteScopeDigest(origin: OperatorJobOrigin, intake: OperatorJobIntake,
  input: OperatorJobInput, baselines: Record<string, OperatorWriteSnapshot>) {
  return createHash('sha256').update(JSON.stringify({ origin, intake, input,
    baselines: Object.fromEntries(Object.entries(baselines).sort(([left], [right]) => left.localeCompare(right))) })).digest('hex');
}

export function operatorWriteReviewDigest(job: OperatorJob, child: OperatorChild) {
  if (!child.write) throw new Error('operator_write_missing_scope');
  return createHash('sha256').update(JSON.stringify({ id: job.id, origin: job.origin, intake: job.intake,
    goal: job.goal, constraints: job.constraints, child: { id: child.id, goal: child.goal, directory: child.directory,
      files: child.files, access: child.access, evidence: child.evidence, attempts: child.attempts,
      baseline: child.write.baseline, approval: child.write.approval, operations: child.write.operations,
      artifact: child.write.artifact } })).digest('hex');
}

export function assertOperatorWriteApproval(origin: OperatorJobOrigin, intake: OperatorJobIntake,
  input: OperatorJobInput, approval: OperatorWriteCreateApproval, workspace: string) {
  if (approval.proof.sessionID !== origin.sessionID || approval.scopeDigest !== operatorWriteScopeDigest(origin, intake, input, approval.baselines)) {
    throw new Error('operator_write_approval_mismatch');
  }
  const writes = input.tasks.filter(task => task.access === 'write');
  if (!writes.length || Object.keys(approval.baselines).length !== writes.length) throw new Error('operator_write_baselines_mismatch');
  for (const task of writes) {
    const baseline = approval.baselines[task.id];
    if (!baseline || baseline.workspace !== workspace || baseline.directory !== task.directory
      || JSON.stringify([...baseline.approvedPaths].sort()) !== JSON.stringify(task.files)) throw new Error('operator_write_baseline_mismatch');
  }
}

function overlaps(left: string, right: string) {
  const inside = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
  };
  return inside(left, right) || inside(right, left);
}

export function operatorChildHoldsWorkspace(child: OperatorChild) {
  if (child.access === 'write') return !child.write?.acceptance;
  return !['completed', 'cancelled', 'abandoned'].includes(child.status);
}

export function assertOperatorWorkspaceClaims(ledger: OperatorJobLedger, incoming: OperatorJob) {
  const claimed = ledger.jobs.flatMap(job => job.children).filter(operatorChildHoldsWorkspace);
  for (const child of incoming.children) {
    for (const other of claimed) {
      if (child.access !== 'write' && other.access !== 'write') continue;
      if (overlaps(child.write?.baseline.directory ?? child.directory, other.write?.baseline.directory ?? other.directory)) {
        throw new Error(`operator_workspace_conflict: ${child.id} conflicts with ${other.id}`);
      }
    }
    claimed.push(child);
  }
}

export function assertOperatorWriteArtifact(child: OperatorChild, artifact: OperatorWriteArtifact) {
  const { digest, ...body } = artifact;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest
    || createHash('sha256').update(artifact.diff).digest('hex') !== artifact.diffSha256) throw new Error('operator_write_artifact_digest_mismatch');
  const baseline = child.write?.baseline;
  if (!baseline || artifact.snapshotDigest !== baseline.digest || artifact.head !== baseline.head || artifact.tree !== baseline.tree
    || artifact.files.some(file => !baseline.approvedPaths.includes(file.path))) throw new Error('operator_write_artifact_scope_mismatch');
  if (child.write!.operations.some(operation => operation.status === 'prepared')) throw new Error('operator_write_mutation_unresolved');
}

export function assertOperatorWriteTerminal(child: OperatorChild, snapshot: OperatorSessionSnapshot) {
  if (snapshot.status !== 'idle' || !child.evidence || !child.sessionID) throw new Error('operator_write_runtime_not_settled');
  const known = new Set(child.attempts.map(attempt => attempt.messageID));
  const prompt = child.attempts.at(-1)?.messageID;
  const lastUser = snapshot.messages.filter(message => message.role === 'user').at(-1);
  const replies = snapshot.messages.filter(message => message.role === 'assistant' && message.parentID === prompt);
  const final = replies.at(-1);
  if (lastUser?.id !== prompt || snapshot.messages.some(message => message.role === 'user' && !known.has(message.id))
    || !final?.completed || final.error || final.id !== child.evidence.messageID || !final.text.trim()
    || (child.evidence.fullTextDigest !== undefined && createHash('sha256').update(final.text).digest('hex') !== child.evidence.fullTextDigest)
    || replies.some(message => message.tools.some(tool => ['pending', 'running'].includes(tool.status)))) {
    throw new Error('operator_write_runtime_evidence_mismatch');
  }
}
