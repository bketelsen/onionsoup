import { z } from 'zod';

/** A local Git ref, not a reflog or remote branch, durably retains unique terminal plan commits. */
export const PlanWorktreeArchive = z.object({
  ref: z.string().startsWith('refs/onionsoup/archive/plans/'),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  base: z.string().regex(/^[a-f0-9]{40,64}$/),
  directory: z.string().min(1),
  generation: z.string().optional(),
  archivedAt: z.string().datetime(),
});
export type PlanWorktreeArchive = z.infer<typeof PlanWorktreeArchive>;
