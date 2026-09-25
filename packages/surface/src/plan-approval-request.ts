import { z } from 'zod';
import { PLAN_APPROVAL_PERMISSION } from '@onionsoup/owners';

/** The plan an owner asks the person to approve in chat, read once from its permission prompt's metadata. */
export const PlanApprovalRequest = z.object({ item: z.string(), title: z.string(), plan: z.string() });
export type PlanApprovalRequest = z.infer<typeof PlanApprovalRequest>;

/** A plan-approval prompt gets a typed plan so the surface can show it as a plan, not as JSON. */
export function planApprovalOf(permission: { permission: string; metadata: unknown }): PlanApprovalRequest | undefined {
  if (permission.permission !== PLAN_APPROVAL_PERMISSION) return undefined;
  const parsed = PlanApprovalRequest.safeParse(permission.metadata);
  return parsed.success ? parsed.data : undefined;
}
