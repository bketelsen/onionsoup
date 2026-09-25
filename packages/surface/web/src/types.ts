// Shapes the surface server returns. Kept loose where the engine or opencode owns the detail.

export interface OwnerSummary {
  id: string; name: string; title: string; source: string; icon: string; color: string; model: string; domain: string;
  chat: boolean; waiting: number; running: number;
}

import type { QuestionRequest, PermissionRequest } from '@opencode-ai/sdk/v2';
export type { QuestionInfo } from '@opencode-ai/sdk/v2';
export type PendingQuestion = QuestionRequest;
export type PendingPermission = PermissionRequest;

export interface InboxEntry {
  kind: 'plan' | 'push' | 'create' | 'delete' | 'permission' | 'question' | 'attention' | 'request-recovery' | 'initiative';
  id: string; owner: string; title: string; detail: string; at?: string; sessionID?: string;
  attentionStatus?: string;
  permission?: PendingPermission; question?: PendingQuestion;
}

import type { InboxReadError } from '../../src/inbox-errors.ts';
export interface SurfaceState {
  owners: OwnerSummary[];
  inbox: InboxEntry[];
  inboxErrors?: InboxReadError[];
  frictionCount: number;
  opencode?: { ok: boolean; error?: string };
}

export type { PublicFrictionRecord as FrictionRecord } from '../../src/friction-public.ts';
export type { InitiativeSummary, OrgEntry, PublicAssignment, PublicInitiative } from '../../src/initiative-public.ts';

export interface JournalNote { at: string; kind: string; note?: string; quote?: string; outcome?: string; stage?: string; session?: string; workItem?: string; retracted?: boolean }

export interface DeskState {
  owner: { id: string; name: string; title: string; source: string; model: string; desk: string };
  work: { id: string; status: string; title: string }[];
  recent: { id: string; status: string; title: string; url?: string }[];
  activity: { id: string; status: string; title: string; from: string; to: string; detail: string; at: string }[];
  notes: JournalNote[];
  registers: Record<string, string>;
}

export type { WorkItem } from '@onionsoup/owners';

// opencode's session and message shapes, trimmed to what the chat reads.
export interface Session { id: string; title: string; directory: string; parentID?: string; time: { created: number; updated: number } }
export interface MessageInfo {
  id: string; sessionID: string; role: 'user' | 'assistant'; agent?: string; modelID?: string; providerID?: string;
  time: { created: number; completed?: number }; error?: { name?: string; data?: { message?: string } }; cost?: number;
}
export interface Part {
  id: string; messageID: string; sessionID: string; type: string;
  text?: string; synthetic?: boolean; ignored?: boolean;
  tool?: string; callID?: string;
  state?: { status: 'pending' | 'running' | 'completed' | 'error'; input?: Record<string, unknown>; output?: string; error?: string; title?: string; metadata?: Record<string, unknown>; time?: { start: number; end?: number } };
  time?: { start: number; end?: number };
}
export interface Message { info: MessageInfo; parts: Part[] }
