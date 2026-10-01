import { buildOperatorHandoff, operatorHandoffBaselineDigest } from './operator-handoff-artifact.ts';
import type { OperatorHandoffs } from './operator-handoff-host.ts';
import type { OperatorJobOrigin } from './operator-jobs-types.ts';
import { operatorJobDigest } from './operator-jobs.ts';
import { OPERATOR_HANDOFF_LIMITS } from './operator-handoff-types.ts';
import { snapshotOperatorWriteWorkspace, operatorWriteCommonDirectory, operatorWriteSha256 } from './operator-write-workspace.ts';
import { OperatorApplicationScope, operatorApplicationScopeDigest } from './operator-application-types.ts';

export async function applicationSource(handoffs: OperatorHandoffs, origin: OperatorJobOrigin, id: string) {
  const report = await handoffs.show(origin, id);
  if (!report.current || report.status !== 'ready' || !report.artifact.checks.length) throw new Error('operator_application_checks_not_ready');
  const job = await handoffs.jobs.get(origin, id);
  const built = await buildOperatorHandoff(job);
  if (built.artifact.digest !== report.artifact.digest) throw new Error('operator_application_source_stale');
  return { job, ...built, checks: report.checks };
}

export async function prepareApplicationScope(handoffs: OperatorHandoffs, origin: OperatorJobOrigin, id: string, directory: string) {
  const source = await applicationSource(handoffs, origin, id);
  const canonical = await handoffs.jobs.canonicalDirectory(directory);
  if (canonical !== directory || source.job.children.some(child => child.directory === canonical)) throw new Error('operator_application_target_invalid');
  const changed = source.artifact.files.filter(file => file.beforeSha256 !== file.afterSha256);
  if (!changed.length) throw new Error('operator_application_no_changes');
  const target = await snapshotOperatorWriteWorkspace({ workspace: handoffs.jobs.workspace, directory: canonical,
    files: changed.filter(file => file.beforeSha256 !== 'absent').map(file => file.path),
    createFiles: changed.filter(file => file.beforeSha256 === 'absent').map(file => file.path),
    limits: { approvedFiles: OPERATOR_HANDOFF_LIMITS.changedFiles } });
  if (target.head !== source.artifact.base.head || target.tree !== source.artifact.base.tree
    || operatorHandoffBaselineDigest(target) !== source.artifact.base.sourceDigest
    || await operatorWriteCommonDirectory(target) !== source.artifact.base.commonDirectory) {
    throw new Error('operator_application_target_base_mismatch');
  }
  const mutations = changed.map(file => {
    const bytes = source.source.find(candidate => candidate.path === file.path)?.content;
    if (!bytes || operatorWriteSha256(bytes) !== file.afterSha256) throw new Error('operator_application_source_stale');
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error('operator_application_text_required');
    return { id: `mutation_${operatorWriteSha256(JSON.stringify([source.artifact.digest, target.digest, file.path]))}`,
      path: file.path, content, beforeSha256: file.beforeSha256, afterSha256: file.afterSha256, snapshotDigest: target.digest };
  });
  const scope = { version: 1 as const, jobDigest: operatorJobDigest(source.job), artifact: source.artifact,
    checks: source.checks, target, mutations, digest: '0'.repeat(64) };
  scope.digest = operatorApplicationScopeDigest(scope);
  return { scope: OperatorApplicationScope.parse(scope), revision: source.job.revision };
}
