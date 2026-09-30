import { z } from 'zod';

/** Host-emitted condition identity includes its generation; resolved generations never reopen automatically. */
export const AttentionCondition = z.object({ key: z.string().min(1).max(512), state: z.enum(['open', 'resolved']) });
export type AttentionCondition = z.infer<typeof AttentionCondition>;

/** Shared read boundary for journal consumers; incomplete or malformed lines are not records. */
export const JournalRecord = z.object({
  at: z.string().datetime(), owner: z.string().optional(), kind: z.string(),
  note: z.string().optional(), quote: z.string().optional(), outcome: z.string().optional(),
  session: z.string().optional(), workItem: z.string().optional(), stage: z.string().optional(),
  condition: AttentionCondition.optional(),
  model: z.string().optional(), source: z.string().optional(), observedAt: z.string().optional(),
});
export type JournalRecord = z.infer<typeof JournalRecord>;

export function parseJournalRecord(line: string) {
  try {
    const parsed = JournalRecord.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
