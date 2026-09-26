import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Notebook } from './notebook.ts';
import { NOTICE_PREFIX } from './notices.ts';

/**
 * The operator's memory: plain markdown files in its notebook (`memory/INDEX.md` plus one topic file per subject),
 * which the operator reads and writes itself. The plugin puts the index into each of its turns, commits changed files
 * when a chat goes idle, and nudges it once per stretch of work to write down what a later chat will need.
 */
export const OPERATOR_MEMORY_LIMITS = {
  /** INDEX.md beyond this is clipped in the operator's context, with a request to consolidate. */
  indexChars: 6_000,
  /** Journaled tool calls in one session, since memory last changed, before an idle chat is nudged. */
  nudgeAfterToolCalls: 10,
  /** Sessions whose activity is kept in memory; the oldest is forgotten first. */
  trackedSessions: 256,
};
export type OperatorMemoryLimits = typeof OPERATOR_MEMORY_LIMITS;

export const MEMORY_DIRECTORY = 'memory';
export const MEMORY_INDEX = 'INDEX.md';
const INDEX_HEADER = '# Memory index: one line per topic, - [Title](file.md) — one-line hook\n';

export function operatorMemoryDirectory(notebook: Notebook) {
  return join(notebook.directory, MEMORY_DIRECTORY);
}

/** The memory directory, with an INDEX.md seeded if it has none. */
export async function ensureOperatorMemory(notebook: Notebook) {
  const directory = operatorMemoryDirectory(notebook);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, MEMORY_INDEX), INDEX_HEADER, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return directory;
}

function clipNote(limits: OperatorMemoryLimits) {
  return `(INDEX.md is longer than ${limits.indexChars} characters and was clipped here. Consolidate it: merge related `
    + 'topics, shorten the hooks, and delete what is stale, so the whole index fits.)';
}

async function readIndex(directory: string) {
  return readFile(join(directory, MEMORY_INDEX), 'utf8').catch((error: NodeJS.ErrnoException) => {
    return `(memory index unreadable: ${error.code ?? error.message})`;
  });
}

/** The memory index as the operator reads it each turn, clipped to `limits.indexChars`. */
export async function memoryIndexBlock(directory: string, limits: OperatorMemoryLimits = OPERATOR_MEMORY_LIMITS) {
  const index = await readIndex(directory);
  const isClipped = index.length > limits.indexChars;
  const lines = [
    `These are links to topic files in ${directory}. Read the ones the current task needs before acting.`,
    index.slice(0, limits.indexChars).trimEnd(),
    ...(isClipped ? [clipNote(limits)] : []),
  ];
  return `<your-memory-index>\n${lines.join('\n')}\n</your-memory-index>`;
}

/** What the memory directory holds now: changes whenever a file in it is added, removed or written. */
export async function memorySignature(directory: string) {
  const names = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
  const stamps = await Promise.all(names.sort().map(async name => {
    const info = await stat(join(directory, name)).catch(() => undefined);
    return info?.isFile() ? `${name}:${info.size}:${info.mtimeMs}` : '';
  }));
  return createHash('sha256').update(stamps.filter(Boolean).join('\n')).digest('hex');
}

/** Commit changed memory files to the notebooks repository; the files it committed. */
export async function commitOperatorMemory(notebook: Notebook) {
  const changed = await notebook.changes(MEMORY_DIRECTORY);
  if (!changed.length) return changed;
  await notebook.commit(`memory: ${changed.join(', ')}`, [MEMORY_DIRECTORY]);
  return changed;
}

export const MEMORY_NUDGE_MARKER = `${NOTICE_PREFIX} Memory check:`;

export const MEMORY_NUDGE_TEXT = `${MEMORY_NUDGE_MARKER} not a new task, and nothing to do for the person. Looking back \
over the work just finished: did you learn anything a later chat will need (how a host or service is set up, a fix \
that worked and why, a preference or decision the person stated, where something lives)? If so, update the matching \
topic file in your memory, or add one and link it in INDEX.md. If not, reply "nothing new".`;

export function isMemoryNudge(text: string) {
  return text.trimStart().startsWith(MEMORY_NUDGE_MARKER);
}

/** What the tools that change files take; a patch names its files in its text. */
const EditInput = z.object({ filePath: z.string().optional(), patchText: z.string().optional() });
type EditInput = z.infer<typeof EditInput>;

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function filePathOf(input: EditInput) {
  return input.filePath ? [input.filePath] : [];
}

function patchPaths(input: EditInput) {
  return [...(input.patchText ?? '').matchAll(PATCH_FILE)].map(match => match[1]!.trim());
}

/** The files each editing tool writes, by tool name; any other tool writes none. */
const EDITED_PATHS: Record<string, (input: EditInput) => string[]> = {
  edit: filePathOf, write: filePathOf, multiedit: filePathOf, apply_patch: patchPaths, patch: patchPaths,
};

function isWithin(path: string, root: string) {
  const inside = relative(resolve(root), path);
  return !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * Whether a tool call edited a file under one of `roots` (the person's configuration, the engine repository).
 * Relative paths are taken from `base`, where the operator's chats run.
 */
export function editsUnder(tool: string, input: unknown, roots: readonly string[], base: string) {
  const edited = EDITED_PATHS[tool];
  const parsed = EditInput.safeParse(input);
  if (!edited || !parsed.success) return false;
  return edited(parsed.data).some(path => roots.some(root => isWithin(resolve(base, path), root)));
}

/** One top-level operator session's work since its memory last changed. */
export interface OperatorActivity {
  toolCalls: number;
  /** Whether it edited the person's configuration or the engine repository. */
  hasChangedSetup: boolean;
  /** Whether its current turn answers a memory nudge; set by the nudge, cleared by the person's next message. */
  isAnsweringNudge: boolean;
  /** The memory directory's signature when this activity started counting. */
  memorySignature: string;
}

export type NudgeReason = 'answering_nudge' | 'memory_changed' | 'setup_changed' | 'enough_work' | 'too_little_work';

export interface NudgeDecision { shouldNudge: boolean; reason: NudgeReason; activity: OperatorActivity }

export function freshActivity(memorySignature: string, isAnsweringNudge = false): OperatorActivity {
  return { toolCalls: 0, hasChangedSetup: false, isAnsweringNudge, memorySignature };
}

interface NudgeRule {
  reason: NudgeReason;
  applies: (activity: OperatorActivity, signature: string, limits: OperatorMemoryLimits) => boolean;
  shouldNudge: boolean;
  next: (activity: OperatorActivity, signature: string) => OperatorActivity;
}

/** Checked in order; the first that applies decides. A nudge starts a new stretch that is answering it. */
const NUDGE_RULES: readonly NudgeRule[] = [
  { reason: 'answering_nudge', applies: activity => activity.isAnsweringNudge, shouldNudge: false, next: (_activity, signature) => freshActivity(signature, true) },
  { reason: 'memory_changed', applies: (activity, signature) => activity.memorySignature !== signature, shouldNudge: false, next: (_activity, signature) => freshActivity(signature) },
  { reason: 'setup_changed', applies: activity => activity.hasChangedSetup, shouldNudge: true, next: (_activity, signature) => freshActivity(signature, true) },
  {
    reason: 'enough_work', applies: (activity, _signature, limits) => activity.toolCalls >= limits.nudgeAfterToolCalls, shouldNudge: true,
    next: (_activity, signature) => freshActivity(signature, true),
  },
  { reason: 'too_little_work', applies: () => true, shouldNudge: false, next: activity => activity },
];

/** Whether an idle operator chat is nudged to update its memory, and the activity it goes on counting from. */
export function decideMemoryNudge(activity: OperatorActivity, signature: string, limits: OperatorMemoryLimits = OPERATOR_MEMORY_LIMITS): NudgeDecision {
  const rule = NUDGE_RULES.find(candidate => candidate.applies(activity, signature, limits))!;
  return { shouldNudge: rule.shouldNudge, reason: rule.reason, activity: rule.next(activity, signature) };
}

/** Top-level operator sessions' activity, by session id. Held in memory only: a restart starts every count over. */
export class OperatorActivityLog {
  private readonly sessions = new Map<string, OperatorActivity>();

  constructor(private readonly limits: OperatorMemoryLimits = OPERATOR_MEMORY_LIMITS) {}

  isTracked(sessionID: string) {
    return this.sessions.has(sessionID);
  }

  start(sessionID: string, signature: string) {
    if (this.sessions.has(sessionID)) return;
    if (this.sessions.size >= this.limits.trackedSessions) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(sessionID, freshActivity(signature));
  }

  /** A message in the session: the nudge starts a turn answering it; the person's next message ends that. */
  observeMessage(sessionID: string, text: string) {
    const activity = this.sessions.get(sessionID);
    if (activity) this.sessions.set(sessionID, { ...activity, isAnsweringNudge: isMemoryNudge(text) });
  }

  /** A journaled tool call made in the session or one of its subagents; answering a nudge does not count. */
  observeToolCall(sessionID: string, hasChangedSetup: boolean) {
    const activity = this.sessions.get(sessionID);
    if (!activity || activity.isAnsweringNudge) return;
    this.sessions.set(sessionID, {
      ...activity, toolCalls: activity.toolCalls + 1, hasChangedSetup: activity.hasChangedSetup || hasChangedSetup,
    });
  }

  /** Decide on idle, and keep counting from what the decision leaves; undefined for a session never started. */
  decide(sessionID: string, signature: string) {
    const activity = this.sessions.get(sessionID);
    if (!activity) return undefined;
    const decision = decideMemoryNudge(activity, signature, this.limits);
    this.sessions.set(sessionID, decision.activity);
    return decision;
  }
}
