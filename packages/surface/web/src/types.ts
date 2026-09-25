// Shapes the surface server returns. Kept loose where the engine or opencode owns the detail.

export interface OwnerSummary {
  id: string; name: string; title: string; source: string; icon: string; color: string; model: string; domain: string;
  chat: boolean; hasDesk: boolean; waiting: number; running: number; activity: OwnerActivity;
}

import type { OwnerActivity } from '../../src/activity.ts';
export type { OwnerActivity };

import type { QuestionRequest, PermissionRequest } from '@opencode-ai/sdk/v2';
export type { QuestionInfo } from '@opencode-ai/sdk/v2';
export type PendingQuestion = QuestionRequest;
export type PendingPermission = PermissionRequest;

export interface InboxEntry {
  kind: 'plan' | 'push' | 'create' | 'delete' | 'permission' | 'question' | 'attention' | 'request-recovery' | 'initiative' | 'provider-auth';
  id: string; owner: string; title: string; detail: string; at?: string; sessionID?: string;
  attentionStatus?: string;
  permission?: PendingPermission; planApproval?: PlanApprovalRequest; question?: PendingQuestion;
}

import type { InboxReadError } from '../../src/inbox-errors.ts';
import type { PlanApprovalRequest } from '../../src/plan-approval-request.ts';
export interface SurfaceState {
  owners: OwnerSummary[];
  /** The person's operator, when declared: a chat of its own, apart from the owners. */
  operator?: OwnerSummary;
  inbox: InboxEntry[];
  inboxErrors?: InboxReadError[];
  frictionCount: number;
  opencode?: { ok: boolean; error?: string };
  /** Model providers failing authentication, and those recently recovered. */
  providerHealth?: ProviderHealthView[];
}

export type { PublicFrictionRecord as FrictionRecord } from '../../src/friction-public.ts';
export type { ItemSession } from '../../src/item-session-public.ts';
export type { InitiativeSummary, OrgEntry, PublicAssignment, PublicInitiative } from '../../src/initiative-public.ts';

export interface JournalNote { at: string; kind: string; note?: string; quote?: string; outcome?: string; stage?: string; session?: string; workItem?: string; retracted?: boolean }

export interface DeskState {
  owner: { id: string; name: string; title: string; source: string; model: string; desk: string };
  work: { id: string; status: string; title: string }[];
  recent: { id: string; status: string; title: string; url?: string }[];
  activity: { id: string; status: string; title: string; from: string; to: string; detail: string; at: string }[];
  notes: JournalNote[];
  registers: Record<string, string>;
  reminders: ReminderSummary[];
}

import type { ProviderHealthView, ReminderSummary } from '@onionsoup/owners';
export type { ProviderHealthView, ReminderSummary, WorkItem } from '@onionsoup/owners';

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
