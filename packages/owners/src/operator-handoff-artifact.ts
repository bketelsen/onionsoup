import { OperatorJob, OperatorJobInput, OperatorTaskInput, type OperatorChild } from './operator-jobs-types.ts';
import { operatorWriteScopeDigest, operatorWriteReviewDigest, assertOperatorWriteArtifact,
  assertOperatorWriteChecks } from './operator-write-state.ts';
import { operatorWriteArtifact, readOperatorWriteSourceFiles, operatorWriteCommonDirectory, operatorWriteSha256,
  type OperatorWriteSnapshot } from './operator-write-workspace.ts';
import { writeReceipts } from './operator-write-context.ts';
import type { OperatorCheckSourceFile } from './operator-check-runner.ts';
import { OperatorHandoffArtifact, OPERATOR_HANDOFF_LIMITS, type OperatorHandoffChild,
  type OperatorHandoffCheck } from './operator-handoff-types.ts';

function fail(reason: string): never { throw new Error(`operator_handoff_${reason}`); }
function digest(value: unknown) { return operatorWriteSha256(JSON.stringify(value)); }

export function operatorHandoffArtifactDigest(artifact: Omit<OperatorHandoffArtifact, 'digest'> | OperatorHandoffArtifact) {
  return digest(OperatorHandoffArtifact.omit({ digest: true }).parse(artifact));
}

function assertCompleted(job: OperatorJob) {
  if (!['needs-synthesis', 'completed'].includes(job.status) || !job.children.length) fail('job_not_ready');
  for (const child of job.children) {
    const attempt = child.attempts.at(-1);
    if (child.status !== 'completed' || child.operation || child.uncertainty || child.blocker || child.abandonment
      || !attempt?.endedAt || child.attempts.some(candidate => !candidate.endedAt)
      || !child.evidence || child.evidence.sessionID !== child.sessionID
      || child.evidence.promptID !== attempt.messageID) fail('child_not_ready');
  }
}

function approvedWrites(job: OperatorJob) {
  const children = job.children.filter(child => child.access === 'write');
  if (!children.length) fail('write_required');
  const input = OperatorJobInput.parse({ key: job.key, goal: job.goal, constraints: job.constraints,
    tasks: job.children.map(child => OperatorTaskInput.parse(child)) });
  const baselines = Object.fromEntries(children.map(child => {
    if (!child.write?.acceptance || !child.write.artifact) fail('acceptance_required');
    return [child.id, child.write.baseline];
  }));
  const expectedScope = operatorWriteScopeDigest(job.origin, job.intake, input, baselines);
  for (const child of children) {
    if (child.write!.approval.scopeDigest !== expectedScope
      || child.write!.approval.proof.sessionID !== job.origin.sessionID
      || child.write!.acceptance!.proof.sessionID !== job.origin.sessionID) fail('approval_mismatch');
    assertOperatorWriteArtifact(child, child.write!.artifact!);
    assertOperatorWriteChecks(child, child.write!.artifact!);
    if (child.write!.acceptance!.digest !== operatorWriteReviewDigest(job, child)) fail('acceptance_stale');
  }
  return children;
}

function assertDisjoint(children: OperatorChild[]) {
  const paths: string[] = [];
  for (const child of children) {
    for (const path of child.write!.baseline.approvedPaths) {
      if (paths.some(previous => previous === path || previous.startsWith(`${path}/`) || path.startsWith(`${previous}/`))) fail('paths_overlap');
      paths.push(path);
    }
  }
}

function baselineDigest(snapshot: OperatorWriteSnapshot) {
  return digest(snapshot.files.map(file => ({ path: file.path, sha256: file.sha256, mode: file.mode, kind: file.kind }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

export function operatorHandoffSourceDigest(source: OperatorCheckSourceFile[]) {
  return digest(source.map(file => ({ path: file.path, sha256: operatorWriteSha256(file.content), mode: file.mode }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

function childProvenance(child: OperatorChild): OperatorHandoffChild {
  return { ...OperatorTaskInput.parse(child), evidence: child.evidence!, ...(child.write ? {
    artifactDigest: child.write.artifact!.digest, approvalScopeDigest: child.write.approval.scopeDigest,
    acceptanceDigest: child.write.acceptance!.digest, approval: child.write.approval, acceptance: child.write.acceptance,
  } : {}) };
}

function combinedChecks(children: OperatorChild[]) {
  const checks = new Map<string, OperatorHandoffCheck>();
  for (const child of children) {
    for (const check of child.checks ?? []) {
      const key = JSON.stringify(check.command);
      const combined = checks.get(key) ?? { id: `check_${digest(check.command)}`, command: check.command, provenance: [] };
      combined.provenance.push({ childID: child.id, checkID: check.id });
      checks.set(key, combined);
    }
  }
  if (checks.size > OPERATOR_HANDOFF_LIMITS.checks) fail('check_limit');
  return [...checks.values()];
}

async function inspectChild(child: OperatorChild) {
  const baseline = child.write!.baseline;
  const commonDirectory = await operatorWriteCommonDirectory(baseline);
  const receipts = writeReceipts(child);
  const artifact = await operatorWriteArtifact(baseline, receipts);
  if (JSON.stringify(artifact) !== JSON.stringify(child.write!.artifact)) fail('artifact_stale');
  const source = await readOperatorWriteSourceFiles(baseline, receipts);
  if (JSON.stringify(await operatorWriteArtifact(baseline, receipts)) !== JSON.stringify(artifact)
    || await operatorWriteCommonDirectory(baseline) !== commonDirectory) fail('source_changed');
  return { artifact, source, commonDirectory };
}

function combineChild(source: Map<string, OperatorCheckSourceFile>, child: OperatorChild,
  inspected: Awaited<ReturnType<typeof inspectChild>>, files: OperatorHandoffArtifact['files']) {
  const byPath = new Map(inspected.source.map(file => [file.path, file]));
  for (const file of inspected.artifact.files) {
    const current = byPath.get(file.path);
    if (!current || operatorWriteSha256(current.content) !== file.afterSha256) fail('source_changed');
    source.set(file.path, { ...current, content: Buffer.from(current.content) });
    files.push({ ...file, childID: child.id, mode: current.mode });
  }
}

function boundedSource(source: Map<string, OperatorCheckSourceFile>) {
  const files = [...source.values()].sort((left, right) => left.path.localeCompare(right.path));
  if (files.length > OPERATOR_HANDOFF_LIMITS.sourceFiles
    || files.reduce((total, file) => total + file.content.length, 0) > OPERATOR_HANDOFF_LIMITS.sourceBytes) fail('source_limit');
  return files;
}

/** Read-only builder. The host additionally proves live session finality before publishing or checking this snapshot. */
export async function buildOperatorHandoff(jobInput: OperatorJob) {
  const job = OperatorJob.parse(jobInput);
  assertCompleted(job);
  const children = approvedWrites(job);
  assertDisjoint(children);
  const checks = combinedChecks(children);
  const first = children[0]!;
  const base = { commonDirectory: await operatorWriteCommonDirectory(first.write!.baseline),
    head: first.write!.baseline.head, tree: first.write!.baseline.tree, sourceDigest: baselineDigest(first.write!.baseline) };
  const source = new Map<string, OperatorCheckSourceFile>();
  const files: OperatorHandoffArtifact['files'] = [];
  let diff = '';
  for (const child of children) {
    const baseline = child.write!.baseline;
    if (baseline.head !== base.head || baseline.tree !== base.tree || baselineDigest(baseline) !== base.sourceDigest) fail('base_mismatch');
    const inspected = await inspectChild(child);
    if (inspected.commonDirectory !== base.commonDirectory) fail('repository_mismatch');
    if (!source.size) for (const file of inspected.source) source.set(file.path, { ...file, content: Buffer.from(file.content) });
    combineChild(source, child, inspected, files);
    diff += inspected.artifact.diff;
    if (Buffer.byteLength(diff) > OPERATOR_HANDOFF_LIMITS.diffBytes) fail('diff_limit');
  }
  for (const child of children) {
    const current = await operatorWriteArtifact(child.write!.baseline, writeReceipts(child));
    if (JSON.stringify(current) !== JSON.stringify(child.write!.artifact)
      || await operatorWriteCommonDirectory(child.write!.baseline) !== base.commonDirectory) fail('source_changed');
  }
  const combined = boundedSource(source);
  const body = { version: 1 as const, jobID: job.id, origin: job.origin, intake: job.intake, goal: job.goal,
    constraints: job.constraints, base, children: job.children.map(childProvenance), files, diff,
    diffSha256: operatorWriteSha256(diff), sourceDigest: operatorHandoffSourceDigest(combined), checks };
  return { artifact: OperatorHandoffArtifact.parse({ ...body, digest: operatorHandoffArtifactDigest(body) }), source: combined };
}
