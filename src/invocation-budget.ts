import { z } from 'zod';

export const InvocationBudgetSnapshot = z.object({ limit: z.number().int().min(1).max(10),
  consumed: z.number().int().min(0).max(10), remaining: z.number().int().min(0).max(10),
}).strict().refine(b => b.consumed + b.remaining === b.limit, 'Invalid invocation budget');
export type InvocationBudgetSnapshot = z.infer<typeof InvocationBudgetSnapshot>;

// Synchronous reservation precedes every await; callers cannot replenish capacity.
export function createInvocationBudget(limit: number) {
  InvocationBudgetSnapshot.parse({ limit, consumed: 0, remaining: limit });
  let consumed = 0;
  const snapshot = (): InvocationBudgetSnapshot => ({ limit, consumed, remaining: limit - consumed });
  return { snapshot, reserve(): InvocationBudgetSnapshot | undefined {
    if (consumed >= limit) return undefined;
    consumed++;
    return snapshot();
  } };
}
export type InvocationBudget = ReturnType<typeof createInvocationBudget>;
