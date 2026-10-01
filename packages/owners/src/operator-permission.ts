import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { OperatorPermissionProof } from './operator-jobs-types.ts';

export const OPERATOR_PERMISSION_LIMITS = { eventGraceMs: 1_000 };
interface Binding { permission: string; errorPrefix: string; nonceKey: string }
const Asked = z.object({ type: z.literal('permission.asked'), properties: z.object({
  id: z.string().min(1), sessionID: z.string(), permission: z.string(),
  patterns: z.array(z.string()), metadata: z.record(z.string(), z.unknown()), always: z.array(z.string()),
  tool: z.object({ messageID: z.string(), callID: z.string().min(1) }),
}) });
const Replied = z.object({ type: z.literal('permission.replied'), properties: z.object({
  sessionID: z.string(), requestID: z.string(), reply: z.enum(['once', 'always', 'reject']),
}) });
type Context = Pick<ToolContext, 'ask' | 'abort' | 'sessionID' | 'messageID'>;
interface Active {
  sessionID: string;
  messageID: string;
  patterns: string[];
  nonce: string;
  asked?: z.infer<typeof Asked>['properties'];
  proof?: OperatorPermissionProof;
  failure?: string;
  changed?: () => void;
}

/** A resolved ask can be an automatic allow. Only an observed native request AND reply proves this gate was answered. */
export class NativeOperatorPermissions {
  private readonly active = new Map<string, Active>();
  constructor(readonly binding: Binding, readonly limits = OPERATOR_PERMISSION_LIMITS) {}

  event(event: unknown) {
    const asked = Asked.safeParse(event);
    if (asked.success) return this.asked(asked.data.properties);
    const replied = Replied.safeParse(event);
    if (replied.success) this.replied(replied.data.properties);
  }

  private asked(request: z.infer<typeof Asked>['properties']) {
    if (request.permission !== this.binding.permission) return;
    const nonce = request.metadata[this.binding.nonceKey];
    if (typeof nonce !== 'string') return;
    const active = this.active.get(nonce);
    if (!active || request.sessionID !== active.sessionID || request.tool.messageID !== active.messageID
      || JSON.stringify(request.patterns) !== JSON.stringify(active.patterns) || request.always.length) return;
    if (active.asked && JSON.stringify(active.asked) !== JSON.stringify(request)) {
      active.failure = `${this.binding.errorPrefix}_permission_ambiguous`;
    } else {
      active.asked = request;
    }
    for (const other of this.active.values()) {
      if (other !== active && other.asked?.id === request.id) {
        other.failure = `${this.binding.errorPrefix}_permission_ambiguous`;
        active.failure = other.failure;
        other.changed?.();
      }
    }
    active.changed?.();
  }

  private replied(reply: z.infer<typeof Replied>['properties']) {
    // A reply received before its exact asked event is not buffered or guessed into a later gate.
    for (const active of this.active.values()) {
      if (active.asked?.id !== reply.requestID || active.sessionID !== reply.sessionID) continue;
      if (reply.reply === 'reject') active.failure = `${this.binding.errorPrefix}_permission_rejected`;
      else if (reply.reply === 'always') active.failure = `${this.binding.errorPrefix}_permission_once_required`;
      else active.proof = { permissionID: reply.requestID, reply: reply.reply, sessionID: active.sessionID,
        messageID: active.messageID, callID: active.asked.tool.callID, nonce: active.nonce };
      active.changed?.();
    }
  }

  async ask(context: Context, request: { patterns: string[]; metadata: Record<string, unknown> }): Promise<OperatorPermissionProof> {
    if (context.abort.aborted) throw new Error(`${this.binding.errorPrefix}_permission_aborted`);
    const active: Active = { sessionID: context.sessionID, messageID: context.messageID,
      patterns: [...request.patterns], nonce: randomUUID() };
    this.active.set(active.nonce, active);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(`${this.binding.errorPrefix}_permission_aborted`));
      context.abort.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const nativeAsk = Promise.resolve().then(() => {
        if (context.abort.aborted) throw new Error(`${this.binding.errorPrefix}_permission_aborted`);
        return context.ask({ permission: this.binding.permission, patterns: [...active.patterns],
          always: [], metadata: { ...request.metadata, [this.binding.nonceKey]: active.nonce } });
      });
      await Promise.race([nativeAsk, aborted]);
      await Promise.race([this.waitForProof(active), aborted]);
      if (context.abort.aborted) throw new Error(`${this.binding.errorPrefix}_permission_aborted`);
      if (active.failure) throw new Error(active.failure);
      if (!active.proof) throw new Error(active.asked
        ? `${this.binding.errorPrefix}_permission_reply_unobserved` : `${this.binding.errorPrefix}_human_permission_unobserved`);
      return active.proof;
    } finally {
      context.abort.removeEventListener('abort', onAbort);
      this.active.delete(active.nonce);
      active.changed?.();
    }
  }

  private waitForProof(active: Active) {
    if (active.proof || active.failure) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timeout = setTimeout(() => { active.changed = undefined; resolve(); }, this.limits.eventGraceMs);
      active.changed = () => {
        if (!active.proof && !active.failure && this.active.has(active.nonce)) return;
        clearTimeout(timeout);
        active.changed = undefined;
        resolve();
      };
    });
  }
}
