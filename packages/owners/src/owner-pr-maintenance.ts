import { canChange, type OwnerDeclaration } from './declarations.ts';
import { recordDutyRun } from './daemon.ts';
import { maintainPullRequests } from './rebase.ts';
import type { Runtime } from './runtime.ts';
import { advance } from './work-recovery.ts';

export function configuredPrMaintenanceDuty(owner: OwnerDeclaration) {
  return canChange(owner) ? owner.duties.find(duty => duty.kind === 'maintain-prs') : undefined;
}

/**
 * A manual invocation of declared maintenance, never model-selected repository/head authority. With `refresh`, a
 * mergeable PR whose head lacks the base tip is brought up to date too (the periodic duty never refreshes).
 */
export async function updateOwnerPullRequests(runtime: Runtime, ownerId: string, options: { refresh?: boolean } = {}) {
  const duty = configuredPrMaintenanceDuty(runtime.owner(ownerId));
  if (!duty) throw new Error('owner_pr_updates_not_configured');
  await runtime.notebook(ownerId).ensureJournal();
  const maintenance = await maintainPullRequests(runtime, ownerId, options);
  await recordDutyRun(runtime, ownerId, duty.id);
  const updates = [];
  for (const item of maintenance.opened) {
    const current = await advance(runtime, item.id);
    updates.push({ id: current.id, status: current.status, reason: current.reason });
  }
  return { summary: maintenance.summary, updates };
}
