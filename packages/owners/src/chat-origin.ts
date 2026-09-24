import { z } from 'zod';

/** A chat that work or an initiative was opened from, so the runtime can tell its owner there how it went. */
export const ChatOrigin = z.object({ sessionID: z.string(), directory: z.string() });
export type ChatOrigin = z.infer<typeof ChatOrigin>;
