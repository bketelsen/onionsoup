export const SESSION_LIMITS = { parentDepth: 4, cachedSessions: 512 };

/** Reads a session's parent; the plugin passes the opencode client's `session.get`. */
export type ParentLookup = (sessionID: string) => Promise<string | undefined>;

/**
 * Which owner (or the operator) a session belongs to. A person's chat with an owner (and an execution session) is a
 * top-level session of the owner's persona agent; subagents run in child sessions, which belong to their parent's
 * owner so their tool calls are journaled there. A failed lookup is not cached, so a transient error recovers on the
 * next event.
 */
export class SessionOwners<Holder> {
  private readonly topLevel = new Map<string, Holder>();
  private readonly parents = new Map<string, string | null>();

  constructor(private readonly parentOf: ParentLookup) {}

  /** A message from an owner's persona marks its session as that owner's top-level session. */
  claim(sessionID: string, owner: Holder) {
    this.topLevel.set(sessionID, owner);
  }

  /** The owner of a top-level session, never of a child. */
  ownerOf(sessionID: string) {
    return this.topLevel.get(sessionID);
  }

  /** The owner of a subagent's child session, found through its parents. */
  async ownerOfChild(sessionID: string) {
    let current: string | undefined = sessionID;
    for (let depth = 0; current && depth < SESSION_LIMITS.parentDepth; depth += 1) {
      current = await this.parent(current);
      const owner = current ? this.topLevel.get(current) : undefined;
      if (owner) return owner;
    }
    return undefined;
  }

  async isChild(sessionID: string) {
    return Boolean(await this.parent(sessionID).catch(() => undefined));
  }

  private async parent(sessionID: string) {
    const known = this.parents.get(sessionID);
    if (known !== undefined) return known ?? undefined;
    const parentID = await this.parentOf(sessionID);
    if (this.parents.size >= SESSION_LIMITS.cachedSessions) this.parents.delete(this.parents.keys().next().value!);
    this.parents.set(sessionID, parentID ?? null);
    return parentID;
  }
}
