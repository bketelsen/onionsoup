import { z } from 'zod';
import type { NoticeMessage } from './exchange-notices.ts';

export const MessageDeliveryBody = z.object({ agent: z.string(), text: z.string() });
export type MessageDeliveryBody = z.infer<typeof MessageDeliveryBody>;

export function matchesMessageReceipt(message: NoticeMessage, messageID: string, delivery: MessageDeliveryBody) {
  return message.info.id === messageID && message.info.role === 'user' && message.info.agent === delivery.agent
    && message.parts.length === 1 && message.parts[0]?.type === 'text'
    && !message.parts[0].synthetic && !message.parts[0].ignored && message.parts[0].text === delivery.text;
}
