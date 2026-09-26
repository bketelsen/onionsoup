import type { WorkStatus } from '@onionsoup/owners';

/**
 * Work an owner's host code is running right now (a runner holds it), shown in the rail under the owner: its hires
 * run on sandboxed opencode servers, so none of their sessions appear among the owner's chats.
 */
export interface RuntimeWork {
  id: string;
  /** The proposal's title. */
  title: string;
  status: WorkStatus;
}
