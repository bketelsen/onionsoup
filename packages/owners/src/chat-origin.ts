import { z } from 'zod';

/** A chat that work was opened from, so the runtime can tell its owner there how it went. */
export function chatOriginShape<StringSchema>(string: () => StringSchema) {
  return { sessionID: string(), directory: string() };
}
export const ChatOrigin = z.object(chatOriginShape(() => z.string()));
export type ChatOrigin = z.infer<typeof ChatOrigin>;
