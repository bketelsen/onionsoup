import { z } from 'zod';
import { IssueSnapshot } from './contracts.ts';

export const Repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
export const Observation = z.object({
  number: z.number().int().positive(), title: z.string().max(500), state: z.enum(['open', 'closed']),
  updatedAt: z.iso.datetime(), observedAt: z.iso.datetime(), commentsExcluded: z.number().int().nonnegative(),
  snapshot: IssueSnapshot.optional(), rejection: z.literal('invalid_snapshot').optional(),
}).strict().refine(x => Boolean(x.snapshot) !== Boolean(x.rejection), 'Snapshot or rejection required');
export type Observation = z.infer<typeof Observation>;
