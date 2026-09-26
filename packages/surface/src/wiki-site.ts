import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { INDEX_PAGE, pageBacklinks, pageTree, searchPages, WIKI_LIMITS, type Wiki, type WikiPage } from '@onionsoup/owners';
import { frameHtml, historyHtml, notFoundHtml, pageHtml, searchHtml, WIKI_SECURITY_HEADERS } from './wiki-layout.ts';
import { renderMarkdown } from './wiki-render.ts';

/**
 * The wiki's own listener, beside the surface: read-only HTML for the LAN, served from the wiki's clone. It serves
 * pages, search and history and nothing else: no API, approvals or chat, and nothing of the main surface.
 */

/** One request's view of the wiki: every page, read once. */
interface WikiSnapshot {
  wiki: Wiki;
  pages: readonly WikiPage[];
  url: URL;
}

interface Rendered {
  status: number;
  title: string;
  /** The page the sidebar marks as current. */
  current: string;
  query?: string;
  content: string;
}

interface WikiRoute {
  /** What the route serves from this URL, or undefined when it is not this route's. */
  match: (url: URL) => string | undefined;
  render: (snapshot: WikiSnapshot, matched: string) => Promise<Rendered>;
}

function notFound(what: string): Rendered {
  return { status: 404, title: 'Not found', current: '', content: notFoundHtml(what) };
}

/** The pages a URL path may mean: / is index.md, /hosts/ is hosts/index.md, /hosts/selfie is hosts/selfie.md. */
function pageCandidates(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return [];
  }
  if (decoded === '' || decoded.endsWith('/')) return [`${decoded}${INDEX_PAGE}`];
  if (decoded.endsWith('.md')) return [decoded];
  return [`${decoded}.md`, `${decoded}/${INDEX_PAGE}`];
}

function findPage(pages: readonly WikiPage[], pathname: string) {
  const candidates = pageCandidates(pathname);
  return candidates.map(candidate => pages.find(page => page.path === candidate)).find(page => page !== undefined);
}

async function renderPage({ wiki, pages }: WikiSnapshot, pathname: string): Promise<Rendered> {
  const page = findPage(pages, pathname);
  if (!page) return notFound(pathname);
  const [latest] = await wiki.history(page.path);
  const html = renderMarkdown(page.body, page.path);
  const content = pageHtml({ path: page.path, html, latest, backlinks: pageBacklinks(pages, page.path) });
  return { status: 200, title: page.title, current: page.path, content };
}

async function renderHistory({ wiki, pages }: WikiSnapshot, pathname: string): Promise<Rendered> {
  const page = findPage(pages, pathname);
  if (!page) return notFound(pathname);
  const content = historyHtml(page.path, page.title, await wiki.history(page.path));
  return { status: 200, title: `History: ${page.title}`, current: page.path, content };
}

async function renderSearch({ pages, url }: WikiSnapshot): Promise<Rendered> {
  const query = url.searchParams.get('q') ?? '';
  const hits = query.trim() ? searchPages(pages, query, WIKI_LIMITS.searchResults) : [];
  return { status: 200, title: 'Search', current: '', query, content: searchHtml(query, hits) };
}

const HISTORY_PREFIX = '/history';

/** First match wins: search and history, then any other path as a page. */
const ROUTES: WikiRoute[] = [
  { match: url => (url.pathname === '/search' ? url.pathname : undefined), render: renderSearch },
  { match: url => (url.pathname.startsWith(`${HISTORY_PREFIX}/`) ? url.pathname.slice(HISTORY_PREFIX.length) : undefined), render: renderHistory },
  { match: url => url.pathname, render: renderPage },
];

const READ_METHODS = new Set(['GET', 'HEAD']);

function siteTitle(pages: readonly WikiPage[]) {
  return pages.find(page => page.path === INDEX_PAGE)?.title ?? 'Wiki';
}

function sendHtml(response: ServerResponse, status: number, html: string) {
  response.writeHead(status, { ...WIKI_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  response.end(html);
}

async function renderRequest(wiki: Wiki, url: URL) {
  const pages = await wiki.pages();
  const snapshot = { wiki, pages, url };
  const route = ROUTES.find(candidate => candidate.match(url) !== undefined)!;
  const rendered = await route.render(snapshot, route.match(url)!);
  const html = frameHtml({ ...rendered, siteTitle: siteTitle(pages), tree: pageTree(pages) });
  return { status: rendered.status, html };
}

/** The error's code, never its detail: paths and git output stay in the surface's log. */
function failureHtml(error: unknown) {
  const code = (error instanceof Error ? error.message : String(error)).split(':')[0];
  return `<!doctype html><meta charset="utf-8"><title>Wiki unavailable</title><p>The wiki could not be read (${code}).</p>`;
}

async function serve(wiki: Wiki, request: IncomingMessage, response: ServerResponse) {
  if (!READ_METHODS.has(request.method ?? '')) {
    response.writeHead(405, { ...WIKI_SECURITY_HEADERS, allow: 'GET, HEAD' });
    response.end();
    return;
  }
  try {
    const { status, html } = await renderRequest(wiki, new URL(request.url ?? '/', 'http://wiki.invalid'));
    sendHtml(response, status, html);
  } catch (error) {
    console.warn('wiki_site_failed', error instanceof Error ? error.message : String(error));
    sendHtml(response, 500, failureHtml(error));
  }
}

/** The wiki's HTTP server, not yet listening. */
export function wikiServer(wiki: Wiki): Server {
  return createServer((request, response) => {
    void serve(wiki, request, response);
  });
}

function warnSync(error: unknown) {
  console.warn('wiki_sync_failed', error instanceof Error ? error.message : String(error));
}

/**
 * Serve the wiki where wiki.yaml says. The clone is made (or brought up to date) first, then fetched and
 * fast-forwarded every WIKI_LIMITS.syncMs so pages pushed from elsewhere show up.
 */
export async function startWikiSite(wiki: Wiki) {
  await wiki.sync().catch(warnSync);
  const server = wikiServer(wiki);
  const timer = setInterval(() => void wiki.sync().catch(warnSync), WIKI_LIMITS.syncMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  const { host, port } = wiki.declaration.listen;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
