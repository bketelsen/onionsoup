import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, posix } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

/**
 * Wiki pages as files: where a page may live, its frontmatter and title, the tree the site's sidebar draws, search and
 * backlinks. Everything here reads the working tree of the wiki's clone; git and writes live in wiki.ts.
 */
export const WIKI_LIMITS = {
  /** Largest page a write accepts, in bytes. */
  pageBytes: 256 * 1024,
  /** Most search results returned. */
  searchResults: 20,
  /** Most history entries returned for a page. */
  historyEntries: 30,
  /** Longest search snippet, in characters. */
  snippetChars: 200,
  /** Longest reason, which becomes the commit subject. */
  reasonChars: 200,
  /** How often the surface fetches and fast-forwards the clone, so edits pushed from elsewhere show up. */
  syncMs: 5 * 60_000,
};

/** Weight of a query term found in a page's title against one found in its body. */
const TITLE_WEIGHT = 5;

export const INDEX_PAGE = 'index.md';

/** The frontmatter fields onionsoup reads. Unknown fields are kept as they are. */
export const WikiFrontmatter = z.object({
  title: z.string().min(1).optional(),
  order: z.number().optional(),
  updated: z.string().optional(),
  sources: z.array(z.string()).optional(),
}).loose();
export type WikiFrontmatter = z.infer<typeof WikiFrontmatter>;

export interface WikiDocument {
  frontmatter: WikiFrontmatter;
  body: string;
}

export interface WikiEntry {
  /** Relative to the pages directory, e.g. hosts/selfie.md. */
  path: string;
  title: string;
  order?: number;
}

export interface WikiPage extends WikiEntry, WikiDocument {
  /** Why the page's frontmatter was set aside, when it could not be read. */
  frontmatterError?: string;
}

export type WikiNode =
  | ({ kind: 'page' } & WikiEntry)
  | { kind: 'section'; name: string; title: string; order?: number; children: WikiNode[] };

/**
 * A page path as the wiki knows it: relative to the pages directory, a .md file, never climbing out. A leading
 * `<pagesDirectory>/` is dropped, since callers often name pages by their repository path.
 */
export function pagePath(path: string, pagesDirectory: string) {
  const trimmed = path.trim().replace(/^\.\//, '');
  const relative = trimmed.startsWith(`${pagesDirectory}/`) ? trimmed.slice(pagesDirectory.length + 1) : trimmed;
  const parts = relative.split(/[\\/]/);
  const isInside = relative !== '' && !isAbsolute(relative) && !parts.includes('..') && !parts.includes('') && !parts.includes('.');
  if (!isInside || !relative.endsWith('.md')) {
    throw new Error(`wiki_path_invalid: ${path}: a page is a relative .md path inside ${pagesDirectory}/, without ..`);
  }
  return parts.join('/');
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function frontmatterFields(yaml: string) {
  const fields = parse(yaml) as unknown;
  if (fields === null || fields === undefined) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('frontmatter is not a mapping');
  return fields;
}

function issuesText(error: z.ZodError) {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** A page's frontmatter and body. Frontmatter that is not valid YAML, or has a wrongly typed field, is refused. */
export function parsePage(text: string): WikiDocument {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  let fields: unknown;
  try {
    fields = frontmatterFields(match[1]!);
  } catch (error) {
    throw new Error(`wiki_frontmatter_invalid: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  const parsed = WikiFrontmatter.safeParse(fields);
  if (!parsed.success) throw new Error(`wiki_frontmatter_invalid: ${issuesText(parsed.error)}`);
  return { frontmatter: parsed.data, body: text.slice(match[0].length) };
}

/** A page's text from frontmatter and body; no frontmatter block when there are no fields. */
export function pageText({ frontmatter, body }: WikiDocument) {
  if (!Object.keys(frontmatter).length) return body;
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

function firstHeading(body: string) {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body.replace(/^(`{3,}|~{3,})[\s\S]*?^\1/gm, ''));
  return heading?.[1];
}

/** frontmatter title, else the first # heading, else the file name. */
export function pageTitle(path: string, document: WikiDocument) {
  return document.frontmatter.title ?? firstHeading(document.body) ?? basename(path, '.md');
}

/** A page read leniently, for listing and serving: broken frontmatter is set aside with its reason, not fatal. */
export function readPageText(path: string, text: string): WikiPage {
  let document: WikiDocument;
  let frontmatterError: string | undefined;
  try {
    document = parsePage(text);
  } catch (error) {
    frontmatterError = error instanceof Error ? error.message : String(error);
    document = { frontmatter: {}, body: text.replace(FRONTMATTER, '') };
  }
  const page: WikiPage = { path, title: pageTitle(path, document), order: document.frontmatter.order, ...document };
  return frontmatterError ? { ...page, frontmatterError } : page;
}

async function markdownFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).map(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return markdownFiles(root, path);
    return entry.name.endsWith('.md') ? [path] : [];
  }));
  return nested.flat();
}

/** Every page under the pages directory. */
export async function readPages(pagesRoot: string) {
  const paths = await markdownFiles(pagesRoot);
  return Promise.all(paths.sort().map(async path => readPageText(path, await readFile(join(pagesRoot, path), 'utf8'))));
}

function byOrderThenTitle(left: WikiNode, right: WikiNode) {
  const isLeftIndex = left.kind === 'page' && basename(left.path) === INDEX_PAGE;
  const isRightIndex = right.kind === 'page' && basename(right.path) === INDEX_PAGE;
  if (isLeftIndex !== isRightIndex) return isLeftIndex ? -1 : 1;
  const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
  const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
  return left.title.localeCompare(right.title);
}

function sectionNode(name: string, children: WikiNode[]): WikiNode {
  const index = children.find(child => child.kind === 'page' && basename(child.path) === INDEX_PAGE);
  const orders = children.map(child => child.order).filter((order): order is number => order !== undefined);
  const order = index?.order ?? (orders.length ? Math.min(...orders) : undefined);
  return { kind: 'section', name, title: index?.title ?? name, order, children: children.sort(byOrderThenTitle) };
}

function nodesUnder(entries: readonly WikiEntry[], prefix: string): WikiNode[] {
  const here = entries.filter(entry => posix.dirname(entry.path) === (prefix || '.'));
  const below = entries.filter(entry => entry.path.startsWith(prefix ? `${prefix}/` : '') && posix.dirname(entry.path) !== (prefix || '.'));
  const directories = [...new Set(below.map(entry => entry.path.slice(prefix ? prefix.length + 1 : 0).split('/')[0]!))];
  const pages: WikiNode[] = here.map(entry => ({ kind: 'page', path: entry.path, title: entry.title, order: entry.order }));
  const sections = directories.map(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    return sectionNode(name, nodesUnder(entries, path));
  });
  return [...pages, ...sections].sort(byOrderThenTitle);
}

/** Pages as the sidebar draws them: index first, then by order, then by title; a folder is a section. */
export function pageTree(entries: readonly WikiEntry[]): WikiNode[] {
  return nodesUnder(entries, '');
}

export interface WikiSearchHit extends WikiEntry {
  score: number;
  snippet: string;
}

function occurrences(haystack: string, needle: string) {
  let count = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) count++;
  return count;
}

function snippetAround(body: string, terms: readonly string[]) {
  const flat = body.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0)));
  const start = Math.max(0, at - Math.floor(WIKI_LIMITS.snippetChars / 3));
  const text = flat.slice(start, start + WIKI_LIMITS.snippetChars).trim();
  return `${start > 0 ? '…' : ''}${text}${start + WIKI_LIMITS.snippetChars < flat.length ? '…' : ''}`;
}

function searchHit(page: WikiPage, terms: readonly string[]): WikiSearchHit | undefined {
  const title = page.title.toLowerCase();
  const body = page.body.toLowerCase();
  const matched = terms.filter(term => title.includes(term) || body.includes(term));
  if (!matched.length) return undefined;
  const hits = matched.reduce((total, term) => total + occurrences(body, term) + TITLE_WEIGHT * occurrences(title, term), 0);
  const score = matched.length * 1_000 + hits;
  return { path: page.path, title: page.title, order: page.order, score, snippet: snippetAround(page.body, matched) };
}

/** The query's terms, lowercased; pages matching more terms rank first, then more occurrences (title counting more). */
export function searchPages(pages: readonly WikiPage[], query: string, limit = WIKI_LIMITS.searchResults) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length) throw new Error('wiki_query_empty: search needs at least one word');
  const hits = pages.map(page => searchHit(page, terms)).filter((hit): hit is WikiSearchHit => hit !== undefined);
  return hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, limit);
}

const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;

/** A link's path with %-escapes decoded; a malformed escape stays as written. */
function decodedPath(path: string) {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** The page a relative link from one page names, or undefined for anything else (a URL, an anchor, a non-page). */
export function linkedPage(fromPath: string, href: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return undefined;
  const target = decodedPath(href.split('#')[0]!.split('?')[0]!);
  if (!target.endsWith('.md')) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), target));
  return resolved.startsWith('../') ? undefined : resolved;
}

/** Pages that link to this one. */
export function pageBacklinks(pages: readonly WikiPage[], path: string): WikiEntry[] {
  const linking = pages.filter(page => page.path !== path && [...page.body.matchAll(MARKDOWN_LINK)].some(match => linkedPage(page.path, match[1]!) === path));
  return linking.map(page => ({ path: page.path, title: page.title, order: page.order }));
}
