import type { Plugin } from '@opencode-ai/plugin';
import { exchangeClient, EXCHANGE_TRANSPORT_LIMITS } from './exchange-client.ts';
import type { PlanRevisionClient } from './plan-revision.ts';

export function planRevisionClient(client: Parameters<Plugin>[0]['client']): PlanRevisionClient {
  const read = exchangeClient(client);
  const signal = () => AbortSignal.timeout(EXCHANGE_TRANSPORT_LIMITS.timeoutMs);
  return {
    async exists(origin) {
      const reply = await client.session.get({ path: { id: origin.sessionID }, query: { directory: origin.directory }, signal: signal() });
      if (reply.error) {
        if (reply.response.status === 404) return false;
        throw new Error('plan_revision_session_lookup_unavailable');
      }
      return reply.data?.id === origin.sessionID && reply.data.directory === origin.directory;
    },
    async messages(origin) { return (await read.messages(origin)).map(message => message.info.id); },
    idle: origin => read.idle(origin),
    async prompt(origin, agent, text, messageID) {
      const reply = await client.session.promptAsync({ path: { id: origin.sessionID }, query: { directory: origin.directory },
        body: { agent, messageID, parts: [{ type: 'text', text }] }, signal: signal() });
      if (reply.error) throw new Error('plan_revision_prompt_uncertain');
    },
  };
}
