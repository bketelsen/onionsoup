import type { ToolContext } from '@opencode-ai/plugin';
import { pageText, type WikiEntry, type WikiNode, type WikiPage, type WikiSearchHit } from './wiki-pages.ts';
import { WIKI_DELETE_PERMISSION, type Wiki, type WikiChange, type WikiHistoryEntry } from './wiki.ts';

/**
 * The onionsoup_wiki tool: every owner and the operator read the wiki; the keeper writes it. Each action is one
 * handler; the keeper check and every write rule are host code in wiki.ts, and a delete asks the person first.
 */
export const WIKI_TOOL = 'onionsoup_wiki';
export const WIKI_ACTIONS = ['list', 'read', 'search', 'history', 'backlinks', 'write', 'move', 'delete'] as const;
export type WikiActionName = typeof WIKI_ACTIONS[number];

export interface WikiToolArgs {
  action: WikiActionName;
  path?: string;
  to?: string;
  query?: string;
  content?: string;
  reason?: string;
}

export interface WikiCall {
  wiki: Wiki;
  /** The owner id calling, or the operator's. */
  caller: string;
  args: WikiToolArgs;
  context: Pick<ToolContext, 'ask' | 'metadata'>;
}

type WikiActionHandler = (call: WikiCall) => Promise<string>;

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`wiki_argument_missing: ${name}`);
  return value;
}

type NodeOf<Kind extends WikiNode['kind']> = Extract<WikiNode, { kind: Kind }>;

const NODE_LINES: { [Kind in WikiNode['kind']]: (node: NodeOf<Kind>, depth: number) => string[] } = {
  page: (node, depth) => [`${'  '.repeat(depth)}- ${node.title} (${node.path})`],
  section: (node, depth) => [`${'  '.repeat(depth)}- ${node.title}/`, ...nodeLines(node.children, depth + 1)],
};

function nodeLines(nodes: readonly WikiNode[], depth = 0): string[] {
  return nodes.flatMap(node => NODE_LINES[node.kind](node as never, depth));
}

function pageReadText(page: WikiPage) {
  const warning = page.frontmatterError ? `\n(frontmatter set aside: ${page.frontmatterError})` : '';
  return `${page.path}: ${page.title}${warning}\n\n${pageText(page)}`;
}

function hitLine(hit: WikiSearchHit) {
  return `- ${hit.title} (${hit.path}): ${hit.snippet}`;
}

function historyLine(entry: WikiHistoryEntry) {
  return `- ${entry.sha.slice(0, 12)} ${entry.date} ${entry.author}: ${entry.subject}`;
}

function entryLine(entry: WikiEntry) {
  return `- ${entry.title} (${entry.path})`;
}

const CHANGE_TEXTS: Record<WikiChange['outcome'], (wiki: Wiki, change: WikiChange) => string> = {
  unchanged: (_wiki, change) => `Unchanged: ${change.path} already reads that way; nothing was committed.`,
  pushed: (wiki, change) => `Committed ${change.commit.slice(0, 12)} and pushed it to ${wiki.declaration.branch}: ${change.path}.`,
};

function changeText(wiki: Wiki, change: WikiChange) {
  return CHANGE_TEXTS[change.outcome](wiki, change);
}

/** opencode rejects with the person's note in its message when they refuse with one. */
function refusalNote(rejection: unknown) {
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  return /feedback:\s*([\s\S]*)$/.exec(message)?.[1]?.trim() ?? 'no note';
}

async function askToDelete({ wiki, caller, args, context }: WikiCall) {
  const reason = required(args.reason, 'reason');
  const page = await wiki.checkDelete(caller, required(args.path, 'path'), reason);
  context.metadata({ title: `delete wiki page ${page}` });
  const request = { permission: WIKI_DELETE_PERMISSION, patterns: [page], always: [], metadata: { path: page, reason } };
  await context.ask(request).catch((rejection: unknown) => {
    throw new Error(`wiki_delete_denied: the person kept ${page}: ${refusalNote(rejection)}`);
  });
  return changeText(wiki, await wiki.delete(caller, page, reason));
}

export const WIKI_TOOL_ACTIONS: Record<WikiActionName, WikiActionHandler> = {
  list: async ({ wiki }) => nodeLines(await wiki.list()).join('\n') || 'The wiki has no pages yet.',
  read: async ({ wiki, args }) => pageReadText(await wiki.read(required(args.path, 'path'))),
  search: async ({ wiki, args }) => (await wiki.search(required(args.query, 'query'))).map(hitLine).join('\n') || `No pages match "${args.query}".`,
  history: async ({ wiki, args }) => (await wiki.history(required(args.path, 'path'))).map(historyLine).join('\n') || `No history for ${args.path}.`,
  backlinks: async ({ wiki, args }) => (await wiki.backlinks(required(args.path, 'path'))).map(entryLine).join('\n') || `No pages link to ${args.path}.`,
  write: async ({ wiki, caller, args }) => {
    const change = await wiki.write(caller, required(args.path, 'path'), required(args.content, 'content'), required(args.reason, 'reason'));
    return changeText(wiki, change);
  },
  move: async ({ wiki, caller, args }) => {
    const change = await wiki.move(caller, required(args.path, 'path'), required(args.to, 'to'), required(args.reason, 'reason'));
    return changeText(wiki, change);
  },
  delete: askToDelete,
};

export const WIKI_TOOL_DESCRIPTION = 'The homelab wiki: search and read it before asking the person about homelab facts. '
  + '"list" shows the pages; "read" a page (path relative to the pages directory, e.g. hosts/selfie.md); "search" takes '
  + 'a query; "history" and "backlinks" take a path. Only the keeper writes: "write" (path, the whole page as content, '
  + 'and a one-line reason that becomes the commit subject), "move" (path, to, reason) and "delete" (path, reason; the '
  + 'person approves it). Each write is committed and pushed at once. Pages may start with YAML frontmatter: title, '
  + 'order (a number: the sidebar sorts by it), updated, sources (a list). Never put secrets in a page.';
