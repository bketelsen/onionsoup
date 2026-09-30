import { randomUUID } from 'node:crypto';
import { beginAdmission } from './deployment-admission.ts';
import type { ExchangeClient } from './exchange-notices.ts';

type Target = Parameters<ExchangeClient['post']>[0];
type Body = Parameters<ExchangeClient['post']>[1];
type Permit = { target: Target; body: Body; nonce: string; expires: number; consumed: boolean };
const permits = new Map<string, Permit>();
const DELIVERY_METADATA = 'onionsoupNoticeDelivery';
export const NOTICE_DELIVERY_LIMITS = { timeoutMs: 10_000 };

function key(state: string, id: string) {
  return JSON.stringify([state, id]);
}

/** A durable notice ID or a copied prefix never authorizes a hook bypass. */
export async function postExchangeNotice(state: string, target: Target, body: Body, post: ExchangeClient['post']) {
  const identity = key(state, body.messageID);
  if (permits.has(identity)) throw new Error('notice_delivery_already_pending');
  const lease = await beginAdmission(state, `notice:${body.messageID}`);
  const permit: Permit = { target, body, nonce: randomUUID(), expires: performance.now() + NOTICE_DELIVERY_LIMITS.timeoutMs, consumed: false };
  try {
    if (permits.has(identity)) throw new Error('notice_delivery_already_pending');
    permits.set(identity, permit);
    await post(target, { ...body, parts: body.parts.map(part => ({ ...part, metadata: { [DELIVERY_METADATA]: permit.nonce } })) });
  } finally {
    if (permits.get(identity) === permit) permits.delete(identity);
    await lease.release();
  }
}

type HookMessage = { id?: string; role?: string; agent?: string; parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean; metadata?: Record<string, unknown> }[] };

export function hasPendingExchangeNoticeDelivery(state: string, id: string | undefined) {
  return !!id && permits.has(key(state, id));
}

/** Call only after resolving the actual top-level session, then consume without another await. */
export function consumeExchangeNoticeDelivery(state: string, target: Target, message: HookMessage) {
  if (!message.id) return false;
  const permit = permits.get(key(state, message.id));
  const part = message.parts[0];
  if (!permit || permit.consumed || performance.now() >= permit.expires || message.role !== 'user'
    || message.agent !== permit.body.agent || target.sessionID !== permit.target.sessionID
    || target.directory !== permit.target.directory || message.parts.length !== 1 || part?.type !== 'text'
    || part.synthetic || part.ignored || part.text !== permit.body.parts[0]?.text
    || part.metadata?.[DELIVERY_METADATA] !== permit.nonce) return false;
  permit.consumed = true;
  delete part.metadata[DELIVERY_METADATA];
  return true;
}
