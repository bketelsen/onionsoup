import { z } from 'zod';

export interface TrackedToolCall { sessionID: string; callID: string; tool: string; userID?: string }

const CallIdentity = z.object({ sessionID: z.string(), callID: z.string() });
const FailedToolPart = z.object({
  id: z.string().min(1), sessionID: z.string().min(1), messageID: z.string().min(1),
  type: z.literal('tool'), callID: z.string().min(1), tool: z.string().min(1),
  state: z.object({ status: z.literal('error'), error: z.string(),
    time: z.object({ start: z.number().finite(), end: z.number().finite() }),
  }),
});
const Transcript = z.array(z.object({
  info: z.object({ id: z.string(), role: z.string(), sessionID: z.string().optional(), parentID: z.string().optional() }),
  parts: z.array(z.unknown()),
}));

/** Never infer completion from an event, elapsed time, or a different turn's failed call. */
export function failedToolInTranscript(transcript: unknown, tracked: TrackedToolCall): boolean {
  const parsed = Transcript.safeParse(transcript);
  if (!parsed.success || !tracked.userID) return false;
  const messages = parsed.data;
  const userIndex = messages.findIndex(message => message.info.id === tracked.userID && message.info.role === 'user');
  if (userIndex < 0 || messages[userIndex]!.info.sessionID !== tracked.sessionID
    || messages.filter(message => message.info.id === tracked.userID).length !== 1) return false;
  const calls = messages.flatMap((message, index) => message.parts.flatMap(part => {
    const identity = CallIdentity.safeParse(part);
    if (!identity.success || identity.data.callID !== tracked.callID || identity.data.sessionID !== tracked.sessionID) return [];
    return [{ message, index, part }];
  }));
  if (calls.length !== 1) return false;
  const { message, index } = calls[0]!;
  const failed = FailedToolPart.safeParse(calls[0]!.part);
  if (!failed.success) return false;
  const part = failed.data;
  return index > userIndex && !messages.slice(userIndex + 1, index).some(message => message.info.role === 'user')
    && message.info.role === 'assistant' && message.info.sessionID === tracked.sessionID
    && message.info.parentID === tracked.userID && part.messageID === message.info.id
    && part.tool === tracked.tool && part.state.time.end >= part.state.time.start;
}
