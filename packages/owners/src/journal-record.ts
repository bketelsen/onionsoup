import { z } from 'zod';

/** Shared read boundary for journal consumers; incomplete or malformed lines are not records. */
export const JournalRecord = z.object({
  at: z.string().datetime(), owner: z.string().optional(), kind: z.string(),
  note: z.string().optional(), quote: z.string().optional(), outcome: z.string().optional(),
  session: z.string().optional(), workItem: z.string().optional(), stage: z.string().optional(),
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
