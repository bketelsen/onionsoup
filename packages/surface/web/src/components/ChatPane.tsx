import type { OwnerSummary } from '../types.ts';

/** Placeholder until the chat view lands. */
export function ChatPane({ owner, sessionId }: { owner: OwnerSummary; sessionId: string; directory: string }) {
  return <div className="p-6 typography-meta text-muted-foreground">Chat {sessionId} with {owner.name}</div>;
}
