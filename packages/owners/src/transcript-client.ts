import type { Plugin } from '@opencode-ai/plugin';
import { z } from 'zod';

export const TranscriptMessage = z.object({
  info: z.object({ id: z.string(), role: z.string(), agent: z.string().optional(), time: z.object({ created: z.number() }) }),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional(), synthetic: z.boolean().optional(), ignored: z.boolean().optional() })),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;
type Target = { sessionID: string; directory: string };

export interface TranscriptClient {
  messages(target: Target): Promise<TranscriptMessage[]>;
  idle(target: Target): Promise<boolean>;
}

export const TRANSCRIPT_TRANSPORT_LIMITS = { timeoutMs: 10_000 };

/** Bounded reads of one session's transcript and status, for host deliveries that must not post twice. */
export function transcriptClient(client: Parameters<Plugin>[0]['client']): TranscriptClient {
  const signal = () => AbortSignal.timeout(TRANSCRIPT_TRANSPORT_LIMITS.timeoutMs);
  return {
    async messages(target) {
      const reply = await client.session.messages({ path: { id: target.sessionID }, query: { directory: target.directory }, signal: signal() });
      if (reply.error) throw new Error('transcript_messages_unavailable');
      return TranscriptMessage.array().parse(reply.data);
    },
    async idle(target) {
      const reply = await client.session.status({ query: { directory: target.directory }, signal: signal() });
      if (reply.error) throw new Error('transcript_status_unavailable');
      const status = reply.data?.[target.sessionID];
      return !status || status.type === 'idle';
    },
  };
}
