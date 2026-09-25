/**
 * A session the surface shows beside a work item: a hire onionsoup ran for it (read from opencode's store), or the
 * owner session carrying out its plan and that session's subagents (read from the surface's opencode).
 */
export interface ItemSession {
  id: string;
  title: string;
  /** What the activity rail calls it: the hire's stage, "work session", or the subagent's task. */
  label: string;
  kind: 'hire' | 'owner';
  directory: string;
  time: { created: number; updated: number };
}
