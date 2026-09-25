import { z } from 'zod';

/** A span of time such as 30m, 6h or 14d: how often a duty runs, or how long until a reminder is due. */
export const Span = z.string().regex(/^\d+[mhd]$/);

const SPAN_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function spanMs(span: string) {
  return Number(span.slice(0, -1)) * SPAN_UNIT_MS[span.at(-1)!]!;
}
