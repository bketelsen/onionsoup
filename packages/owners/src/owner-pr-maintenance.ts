import { canChange, type OwnerDeclaration } from './declarations.ts';
import { recordDutyRun } from './daemon.ts';
import { wake } from './owner.ts';
import type { Runtime } from './runtime.ts';
import { advance } from './work-recovery.ts';

export function configuredPrMaintenanceDuty(owner: OwnerDeclaration) {
  return canChange(owner) ? owner.duties.find(duty => duty.kind === 'maintain-prs') : undefined;
}

/** A manual invocation of declared maintenance, never model-selected repository/head authority. */
export async function updateOwnerPullRequests(runtime: Runtime, ownerId: string) {
  const duty = configuredPrMaintenanceDuty(runtime.owner(ownerId));
  if (!duty) throw new Error('owner_pr_updates_not_configured');
  const maintenance = await wake(runtime, ownerId, duty.id);
  await recordDutyRun(runtime, ownerId, duty.id);
  const updates = [];
  for (const item of maintenance.items) {
    const current = await advance(runtime, item.id);
    updates.push({ id: current.id, status: current.status, reason: current.reason });
  }
  return { summary: maintenance.survey.summary, updates };
}
