import type { Plugin } from '@opencode-ai/plugin';
import { exchangeClient, EXCHANGE_TRANSPORT_LIMITS } from './exchange-client.ts';
import type { PlanRevisionClient } from './plan-revision.ts';
import { ownerTranscriptTarget, routeOwnerNotice } from './owner-message-routing.ts';
import type { Runtime } from './runtime.ts';
import type { MaintenancePass } from './plugin-maintenance.ts';
import { ownerMessageId } from './owner-messages.ts';
import { matchesMessageReceipt } from './message-receipt.ts';

export function planRevisionClient(client: Parameters<Plugin>[0]['client'], routing?: { runtime: Runtime; pass: MaintenancePass }): PlanRevisionClient {
  const read = exchangeClient(client);
  const signal = () => AbortSignal.timeout(EXCHANGE_TRANSPORT_LIMITS.timeoutMs);
  const transcriptTarget = (origin: Parameters<PlanRevisionClient['exists']>[0]) =>
    routing ? ownerTranscriptTarget(routing.runtime, origin) : Promise.resolve(origin);
  return {
    async exists(origin) {
      const target = await transcriptTarget(origin);
      const reply = await client.session.get({ path: { id: origin.sessionID }, query: { directory: target.directory }, signal: signal() });
      if (reply.error) {
        if (reply.response.status === 404) return false;
        throw new Error('plan_revision_session_lookup_unavailable');
      }
      return reply.data?.id === origin.sessionID && reply.data.directory === origin.directory;
    },
    async messages(origin) { return (await read.messages(await transcriptTarget(origin))).map(message => message.info.id); },
    idle: origin => read.idle(origin),
    route: routing ? address => routeOwnerNotice(routing.runtime, client, routing.pass, {
      id: ownerMessageId(['plan-continuation', address.id]), owner: address.owner, workItem: address.item,
      origin: address.origin, change: 'plan-continuation', text: '', at: new Date().toISOString(),
    }) : undefined,
    async accepted(origin, messageID, delivery) {
      const message = (await read.messages(await transcriptTarget(origin))).find(message => message.info.id === messageID);
      if (!message) return false;
      if (!matchesMessageReceipt(message, messageID, delivery)) throw new Error('plan_continuation_message_identity_conflict');
      return true;
    },
    async prompt(origin, agent, text, messageID) {
      const reply = await client.session.promptAsync({ path: { id: origin.sessionID }, query: { directory: origin.directory },
        body: { agent, messageID, parts: [{ type: 'text', text }] }, signal: signal() });
      if (reply.error) throw new Error('plan_revision_prompt_uncertain');
    },
  };
}
