import type { Plugin } from '@opencode-ai/plugin';
import { NoticeChat, NoticeMessage, type ExchangeClient } from './exchange-notices.ts';

export const EXCHANGE_TRANSPORT_LIMITS = { timeoutMs: 10_000 };

/** The synchronous noReply endpoint persists a transcript entry without hiring or waking a model. */
export function exchangeClient(client: Parameters<Plugin>[0]['client']): ExchangeClient {
  const signal = () => AbortSignal.timeout(EXCHANGE_TRANSPORT_LIMITS.timeoutMs);
  return {
    async sessions(directory) {
      const reply = await client.session.list({ query: { directory }, signal: signal() });
      if (reply.error) throw new Error('notice_sessions_unavailable');
      return NoticeChat.array().parse(reply.data);
    },
    async messages(target) {
      const reply = await client.session.messages({ path: { id: target.sessionID }, query: { directory: target.directory }, signal: signal() });
      if (reply.error) throw new Error('notice_messages_unavailable');
      return NoticeMessage.array().parse(reply.data);
    },
    async idle(target) {
      const reply = await client.session.status({ query: { directory: target.directory }, signal: signal() });
      if (reply.error) throw new Error('notice_status_unavailable');
      const status = reply.data?.[target.sessionID];
      return !status || status.type === 'idle';
    },
    async post(target, body) {
      const reply = await client.session.prompt({ path: { id: target.sessionID }, query: { directory: target.directory }, body, signal: signal() });
      if (reply.error) throw new Error('notice_post_failed');
    },
  };
}
