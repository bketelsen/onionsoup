// Shapes the surface server returns. Kept loose where the engine or opencode owns the detail.

export interface OwnerSummary {
  id: string; name: string; title: string; source: string; icon: string; color: string; model: string; domain: string;
  chat: boolean; waiting: number; running: number;
}

export interface PendingPermission { id: string; sessionID: string; permission: string; patterns: string[]; metadata: Record<string, unknown>; always: string[] }
export interface QuestionInfo { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }
export interface PendingQuestion { id: string; sessionID: string; questions: QuestionInfo[] }

export interface InboxEntry {
  kind: 'plan' | 'push' | 'publish' | 'create' | 'delete' | 'permission' | 'question' | 'attention' | 'request-recovery';
  id: string; owner: string; title: string; detail: string; at?: string; sessionID?: string;
  attentionStatus?: string;
  permission?: PendingPermission; question?: PendingQuestion;
}

export interface SurfaceState { owners: OwnerSummary[]; inbox: InboxEntry[]; opencode?: { ok: boolean; error?: string } }

export interface JournalNote { at: string; kind: string; note?: string; quote?: string; outcome?: string; stage?: string; session?: string; workItem?: string; retracted?: boolean }

export interface DeskState {
  owner: { id: string; name: string; title: string; source: string; model: string; desk: string };
  work: { id: string; status: string; title: string }[];
  recent: { id: string; status: string; title: string; url?: string }[];
  activity: { id: string; status: string; title: string; from: string; to: string; detail: string; at: string }[];
  notes: JournalNote[];
  registers: Record<string, string>;
}

export interface WorkItem {
  activeRunner?: number;
  id: string; owner: string; status: string; reason?: string; createdAt: string; updatedAt: string;
  proposal: { title: string; goal: string; rationale: string; acceptance: string[]; size: string; repository?: string };
  plan?: { summary: string; steps: { description: string; files: string[] }[]; tests: string[]; risks: string[]; outOfScope?: string[] };
  planApproval?: { by: string; at: string; note?: string };
  implementations: { report: { summary: string }; diffStat: string; verification: { command: string; exitCode: number; output: string }[] }[];
  verdicts: { decision: string; summary: string; findings: { severity?: string; file?: string; description?: string }[] }[];
  hires: { stage: string; craft: string; model: string; family: string; sessionID: string; outcome: string; cost: number; startedAt: string; finishedAt: string; error?: string }[];
  humanNotes: { kind: string; by: string; note: string }[];
  branch?: string; landedCommit?: string;
  publication?: { url: string; state: string };
  rebaseOf?: { prUrl: string };
}

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
