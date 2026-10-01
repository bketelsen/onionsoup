import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { OperatorHandoffs } from './operator-handoff-host.ts';
import type { OperatorJobOrigin } from './operator-jobs-types.ts';
import type { OperatorWritePermissions } from './operator-write-permission.ts';
import { OperatorApplicationStore } from './operator-application-store.ts';
import { OperatorApplicationWorker } from './operator-application-worker.ts';
import { prepareApplicationScope } from './operator-application-preview.ts';
import { operatorApplicationEffects } from './operator-application-files.ts';
import { OPERATOR_APPLICATION_LIMITS, type OperatorApplication } from './operator-application-types.ts';

type Context = Pick<ToolContext, 'ask' | 'abort' | 'messageID' | 'sessionID' | 'agent' | 'directory'>;
const WARNING = 'Apply this exact checked combined result only to the shown clean integration worktree. '
  + 'No commit, push, merge or publication. HEAD/index and original child artifacts stay unchanged. '
  + 'Interrupted partial or uncertain writes keep their reservation; this approval never authorizes overwriting foreign changes.';

/** A separately approved destination effect; accepting child evidence alone never authorizes application. */
export class OperatorApplications {
  readonly store: OperatorApplicationStore;
  readonly worker: OperatorApplicationWorker;
  constructor(readonly handoffs: OperatorHandoffs, readonly permissions: OperatorWritePermissions,
    effects = operatorApplicationEffects) {
    this.store = new OperatorApplicationStore(handoffs.jobs.home);
    this.worker = new OperatorApplicationWorker(handoffs, effects);
  }
  private context(origin: OperatorJobOrigin, context: Context) {
    context.abort.throwIfAborted();
    if (context.agent !== this.handoffs.jobs.operator || context.sessionID !== origin.sessionID || context.directory !== origin.directory) {
      throw new Error('operator_application_origin_mismatch');
    }
  }
  private bound(record: OperatorApplication, origin: OperatorJobOrigin, directory: string, digest: string) {
    if (JSON.stringify(record.scope.artifact.origin) !== JSON.stringify(origin)
      || record.scope.target.directory !== directory || record.scope.digest !== digest) throw new Error('operator_application_scope_mismatch');
  }
  async preview(origin: OperatorJobOrigin, id: string, directory: string) {
    await this.handoffs.jobs.get(origin, id);
    const existing = await this.store.read(id);
    if (existing) {
      this.bound(existing, origin, directory, existing.scope.digest);
      return this.show(origin, id);
    }
    const { scope } = await prepareApplicationScope(this.handoffs, origin, id, directory);
    return { kind: 'operator-application-preview' as const, digest: scope.digest, target: scope.target.directory,
      head: scope.target.head, handoffDigest: scope.artifact.digest, originalIntake: scope.artifact.intake,
      goal: scope.artifact.goal, constraints: scope.artifact.constraints,
      diffPreview: scope.artifact.diff.slice(0, OPERATOR_APPLICATION_LIMITS.diffPreviewChars),
      diffPreviewTruncated: scope.artifact.diff.length > OPERATOR_APPLICATION_LIMITS.diffPreviewChars,
      files: scope.mutations.map(mutation => mutation.path), checks: scope.checks, warning: WARNING };
  }
  async show(origin: OperatorJobOrigin, id: string) {
    await this.handoffs.jobs.get(origin, id);
    const record = await this.store.read(id);
    if (!record) throw new Error('operator_application_missing');
    if (JSON.stringify(record.scope.artifact.origin) !== JSON.stringify(origin)) throw new Error('operator_application_origin_mismatch');
    return { kind: 'operator-application' as const, jobID: id, id: record.id, digest: record.scope.digest,
      status: record.status, reason: record.reason, target: record.scope.target.directory,
      cleanupPending: record.status === 'applied' && (!record.claimReleasedAt || record.workers.some(worker => !worker.endedAt)),
      head: record.scope.target.head, handoffDigest: record.scope.artifact.digest,
      operations: record.operations.map(operation => ({ path: operation.intent?.mutation.path,
        status: operation.status, attempts: operation.attempts.length, observation: operation.attempts.at(-1)?.observation?.state })),
      result: record.result ? { sourceDigest: record.result.sourceDigest, diffSha256: record.result.diffSha256, at: record.result.at } : undefined,
      recordPath: this.store.path(id), warning: WARNING };
  }
  async apply(origin: OperatorJobOrigin, id: string, directory: string, digest: string, context: Context) {
    this.context(origin, context);
    await this.handoffs.jobs.get(origin, id);
    const existing = await this.store.read(id);
    if (existing) this.bound(existing, origin, directory, digest);
    else await this.approve(origin, id, directory, digest, context);
    this.context(origin, context);
    this.worker.enqueue(id);
    return this.show(origin, id);
  }
  private async approve(origin: OperatorJobOrigin, id: string, directory: string, digest: string, context: Context) {
    const { scope } = await prepareApplicationScope(this.handoffs, origin, id, directory);
    if (scope.digest !== digest) throw new Error('operator_application_scope_stale');
    const proof = await this.permissions.ask(context, { patterns: [`apply-handoff/${id}/${digest}`], metadata: {
      approvalScope: 'once', mode: 'apply-handoff', originalIntake: scope.artifact.intake,
      goal: scope.artifact.goal, constraints: scope.artifact.constraints, directory,
      artifact: { head: scope.target.head, diff: scope.artifact.diff, files: scope.artifact.files },
      checks: scope.checks, digest, handoffDigest: scope.artifact.digest, jobID: id, warning: WARNING,
    } });
    this.context(origin, context);
    const fresh = await prepareApplicationScope(this.handoffs, origin, id, directory);
    if (fresh.scope.digest !== digest) throw new Error('operator_application_scope_stale');
    await this.store.transaction(id, async (record, save) => {
      this.context(origin, context);
      if (record) return this.bound(record, origin, directory, digest);
      await save({ version: 1, id: `application_${randomUUID()}`, token: randomUUID(), scope: fresh.scope,
        approval: { proof, at: new Date().toISOString() }, status: 'approved', operations: [], workers: [] });
    });
  }
  async reconcile(signal?: AbortSignal) {
    signal?.throwIfAborted();
    let names: string[];
    try { names = await readdir(join(this.handoffs.jobs.home, 'operator-applications')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const id = name.slice(0, -5);
      const record = await this.store.read(id);
      signal?.throwIfAborted();
      if (record && (['approved', 'applying'].includes(record.status)
        || (record.status === 'applied' && (!record.claimReleasedAt || record.workers.some(worker => !worker.endedAt))))) this.worker.enqueue(id);
    }
  }
}
