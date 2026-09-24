import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrigin } from './chat-origin.ts';
import type { WorkItem } from './ledger.ts';
import type { Runtime } from './runtime.ts';

/**
 * Owners hear how their work went. Each daemon tick compares every work item with what was last seen; a change the
 * owner should act on (landed, failed, rejected, its PR merged or closed) goes into the owner's journal, and, when
 * the work was opened from a chat, into a queue the opencode plugin delivers into that chat. The owner then decides
 * what to do next in front of the person. Deterministic host code throughout; no model is hired here.
 */
export const NOTICE_PREFIX = '[onionsoup notice]';

export function isRuntimeNotice(text: string) {
  return text.trimStart().startsWith(NOTICE_PREFIX);
}

/** A message the plugin posts into an owner's chat as a turn, waking the owner there. */
export const WorkNotice = z.object({
  id: z.string(),
  owner: z.string(),
  workItem: z.string().optional(),
  initiative: z.string().optional(),
  change: z.string(),
  text: z.string(),
  origin: ChatOrigin.optional(),
  at: z.string(),
});
export type WorkNotice = z.infer<typeof WorkNotice>;

const NOTABLE = new Set(['landed', 'failed', 'rejected']);

function key(item: WorkItem) {
  return `${item.status}|${item.publication?.state ?? ''}`;
}

function directories(runtime: Runtime) {
  const root = join(runtime.stateDirectory, 'notices');
  return { root, seen: join(root, 'seen.json'), pending: join(root, 'pending'), delivered: join(root, 'delivered') };
}

/** What changed, in the owner's terms, or undefined when nothing it should act on did. */
interface Described { change: string; text: string }

export function describeChange(item: WorkItem, previous: string | undefined): Described | undefined {
  const [before, beforePr] = (previous ?? '|').split('|');
  const title = `"${item.proposal.title}"`;
  const pr = item.publication;
  // A desk can publish and merge between ticks; preserve failures in post-merge follow-ups.
  const hasNewFailure = item.status === 'failed' && item.status !== before;
  if (!hasNewFailure && pr && pr.state !== beforePr && (pr.state === 'merged' || pr.state === 'closed') && beforePr !== undefined) {
    return { change: `pr-${pr.state}`, text: `The PR for ${item.id} ${title} was ${pr.state}: ${pr.url}.${pr.state === 'closed' ? ' It was closed without merging; find out why before proposing it again.' : ''}` };
  }
  if (item.status !== before && NOTABLE.has(item.status)) {
    if (item.status === 'failed') {
      const timedOut = /Aborted/.test(item.reason ?? '') ? ' (a hire ran out its time limit or was stopped)' : '';
      return { change: 'failed', text: `Your work item ${item.id} ${title} failed: ${item.reason ?? 'no reason recorded'}${timedOut}. Its full record: onionsoup_status with item ${item.id}. Decide what happens next: reopen it (changed, smaller, or split) with onionsoup_open_work, or tell the person what you need from them. Say what you decided.` };
    }
    if (item.status === 'rejected') {
      return { change: 'rejected', text: `The person rejected the plan for ${item.id} ${title}: ${item.reason ?? 'no reason given'}. Take that into account; do not reopen the same work unless the person asks.` };
    }
    const where = item.rebaseOf ? `updated ${item.rebaseOf.prUrl}`
      : pr ? `is published as ${pr.url}`
      : item.repairOf ? `landed on ${item.branch}; publication will update ${item.repairOf.prUrl}`
      : `landed on ${item.branch}; it becomes a PR when the person publishes it`;
    return { change: 'landed', text: `Your work item ${item.id} ${title} passed verification and review and ${where}. Tell the person if anything about it needs them.` };
  }
  return undefined;
}

const MANAGER_TEXT: Record<string, (item: WorkItem) => string> = {
  landed: item => (item.publication ? `landed and is published as ${item.publication.url}` : `landed on ${item.branch}; it waits on the person to publish it`),
  failed: item => `failed: ${item.reason ?? 'no reason recorded'}`,
  rejected: item => `had its plan rejected by the person: ${item.reason ?? 'no reason given'}`,
  'pr-merged': item => `was merged (${item.publication?.url})`,
  'pr-closed': item => `had its PR closed without merging (${item.publication?.url})`,
};

/** The same change, told to the manager whose initiative the work carries out. */
export function describeForManager(item: WorkItem, previous: string | undefined): Described | undefined {
  const described = describeChange(item, previous);
  if (!described || !item.assignment) return undefined;
  const { initiative, assignment } = item.assignment;
  const what = MANAGER_TEXT[described.change]?.(item) ?? described.change;
  return {
    change: described.change,
    text: `${item.owner}'s work ${item.id} "${item.proposal.title}" (assignment ${assignment} of initiative ${initiative}) ${what}. See the initiative with onionsoup_initiative show ${initiative}; decide whether anything needs you or the person, and say so.`,
  };
}

/** Who hears about a change: the item's owner, and for assigned work also the manager, in the initiative's chat. */
const AUDIENCES = {
  owner: { describe: describeChange, suffix: '' },
  manager: { describe: describeForManager, suffix: '-manager' },
} satisfies Record<string, { describe: (item: WorkItem, previous: string | undefined) => Described | undefined; suffix: string }>;

interface Audience { role: keyof typeof AUDIENCES; owner: string; origin: () => Promise<ChatOrigin | undefined> }

async function audiencesOf(runtime: Runtime, item: WorkItem, chatDirectory: (ownerId: string) => Promise<string>): Promise<Audience[]> {
  const owner: Audience = { role: 'owner', owner: item.owner, origin: () => originOf(runtime, item, chatDirectory) };
  const initiative = item.assignment ? await runtime.initiatives.get(item.assignment.initiative).catch(() => undefined) : undefined;
  if (!initiative) return [owner];
  return [owner, { role: 'manager', owner: initiative.owner, origin: async () => initiative.origin }];
}

/** Queue a notice for the plugin to post; written whole, so a reader never sees half a file. */
export async function queueNotice(runtime: Runtime, notice: WorkNotice) {
  const { pending } = directories(runtime);
  await mkdir(pending, { recursive: true });
  const path = join(pending, `${notice.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(WorkNotice.parse(notice), null, 2) + '\n');
  await rename(temporary, path);
}

async function raiseNotice(runtime: Runtime, item: WorkItem, previous: string | undefined, audience: Audience) {
  const { describe, suffix } = AUDIENCES[audience.role];
  const described = describe(item, previous);
  if (!described) return undefined;
  const notice: WorkNotice = {
    id: `${item.id}-${described.change}${suffix}`, owner: audience.owner, workItem: item.id, change: described.change,
    text: described.text, origin: await audience.origin(), at: new Date().toISOString(),
  };
  const notebook = runtime.notebook(audience.owner);
  await notebook.journal({ kind: 'work-status', workItem: item.id, outcome: described.change, note: described.text.slice(0, 500) });
  await notebook.commit(`journal ${item.id} ${described.change}`).catch(() => undefined);
  if (notice.origin) await queueNotice(runtime, notice);
  return notice;
}

/** Where the work was opened from: its recorded origin, or the owner's work-opened journal entry for older items. */
async function originOf(runtime: Runtime, item: WorkItem, chatDirectory: (ownerId: string) => Promise<string>) {
  if (item.origin) return item.origin;
  const sourceId = item.rebaseOf?.itemId ?? item.repairOf?.itemId;
  const source = sourceId ? await runtime.ledger.get(sourceId).catch(() => undefined) : undefined;
  if (source?.origin) return source.origin;
  const journal = join(runtime.notebook(item.owner).directory, 'journal');
  const files = (await readdir(journal).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
  for (const file of files) {
    for (const line of (await readFile(join(journal, file), 'utf8')).split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as { kind?: string; workItem?: string; session?: string };
      if (entry.kind === 'work-opened' && entry.workItem === (source?.id ?? item.id) && entry.session) {
        return { sessionID: entry.session, directory: await chatDirectory(item.owner) };
      }
    }
  }
  return undefined;
}

/**
 * Compare every item with what was last seen. The first run only records the present, so turning notices on does
 * not replay history. Returns the notices raised.
 */
export async function noticeWorkChanges(runtime: Runtime, chatDirectory: (ownerId: string) => Promise<string>) {
  const paths = directories(runtime);
  await mkdir(paths.pending, { recursive: true });
  const seenText = await readFile(paths.seen, 'utf8').catch(() => undefined);
  const items = await runtime.ledger.list();
  const seen = seenText ? JSON.parse(seenText) as Record<string, string> : undefined;
  const next: Record<string, string> = Object.fromEntries(items.map(item => [item.id, key(item)]));
  const raised: WorkNotice[] = [];
  if (seen) {
    for (const item of items) {
      if (seen[item.id] === next[item.id]) continue;
      for (const audience of await audiencesOf(runtime, item, chatDirectory)) {
        const notice = await raiseNotice(runtime, item, seen[item.id], audience);
        if (notice) raised.push(notice);
      }
    }
  }
  await writeFile(`${paths.seen}.tmp`, JSON.stringify(next, null, 2) + '\n');
  await rename(`${paths.seen}.tmp`, paths.seen);
  return raised;
}

function parseNotice(text: string) {
  try {
    const parsed = WorkNotice.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function pendingNotices(runtime: Runtime): Promise<WorkNotice[]> {
  const { pending } = directories(runtime);
  const files = (await readdir(pending).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort();
  const notices = await Promise.all(files.map(file => readFile(join(pending, file), 'utf8').then(parseNotice, () => undefined)));
  return notices.filter((notice): notice is WorkNotice => Boolean(notice));
}

/** Take a notice for delivery. Several opencode servers may run the plugin; the rename lets exactly one win. */
export async function claimNotice(runtime: Runtime, id: string) {
  const { pending, delivered } = directories(runtime);
  await mkdir(delivered, { recursive: true });
  return rename(join(pending, `${id}.json`), join(delivered, `${id}.json`)).then(() => true, () => false);
}

/** Put a notice back when delivery failed, to try again later. */
export async function releaseNotice(runtime: Runtime, id: string) {
  const { pending, delivered } = directories(runtime);
  await rename(join(delivered, `${id}.json`), join(pending, `${id}.json`)).catch(() => undefined);
}
