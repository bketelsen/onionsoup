import { z } from 'zod';

export const MEMORY_DEFAULTS = {
  enabled: true,
  everyMs: 60 * 60_000,
  retryMs: 5 * 60_000,
  minEntries: 1,
  maxEntries: 100,
  maxChars: 24_000,
};

export const MemoryPolicy = z.object({
  enabled: z.boolean().default(MEMORY_DEFAULTS.enabled),
  everyMs: z.number().int().positive().default(MEMORY_DEFAULTS.everyMs),
  retryMs: z.number().int().positive().default(MEMORY_DEFAULTS.retryMs),
  minEntries: z.number().int().positive().default(MEMORY_DEFAULTS.minEntries),
  maxEntries: z.number().int().positive().default(MEMORY_DEFAULTS.maxEntries),
  maxChars: z.number().int().positive().default(MEMORY_DEFAULTS.maxChars),
}).refine(policy => policy.minEntries <= policy.maxEntries, {
  message: 'memory_min_entries_exceeds_batch',
});
export type MemoryPolicy = z.infer<typeof MemoryPolicy>;

export const JournalCursor = z.object({ file: z.string(), line: z.number().int().nonnegative() });
export type JournalCursor = z.infer<typeof JournalCursor>;

export const MemoryState = z.object({
  status: z.enum(['idle', 'running', 'failed']).default('idle'),
  cursor: JournalCursor.optional(),
  lastAttempt: z.string().optional(),
  lastCompleted: z.string().optional(),
  error: z.string().optional(),
  entries: z.number().int().nonnegative().default(0),
  edits: z.number().int().nonnegative().default(0),
});
export type MemoryState = z.infer<typeof MemoryState>;

export interface MemoryStatus extends MemoryState {
  queued: boolean;
  automatic: boolean;
}
