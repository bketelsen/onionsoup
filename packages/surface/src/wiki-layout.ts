import { createHash } from 'node:crypto';
import type { WikiEntry, WikiHistoryEntry, WikiNode, WikiSearchHit } from '@onionsoup/owners';
import { escapeHtml, pageUrl } from './wiki-render.ts';

/**
 * The wiki site's pages: server-rendered HTML with one inline stylesheet and no script. Colours and fonts are the
 * surface's (OpenChamber's light and dark themes, from web/src/styles), switched by prefers-color-scheme.
 */
export const WIKI_STYLE = `
:root {
  color-scheme: light dark;
  --background: #fdfcfa; --foreground: #393a34; --muted: #f7f6f4; --muted-foreground: #5c5c54;
  --border: #e5e1de; --primary: #b35017; --sidebar: #f7f6f4; --code: #f1efec;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #120f0e; --foreground: #c9c5ba; --muted: #171615; --muted-foreground: #8f8b81;
    --border: #242323; --primary: #da7c47; --sidebar: #171615; --code: #1d1b1a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 15px/1.6 var(--font-sans); }
a { color: var(--primary); }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
header .site { font-weight: 600; color: var(--foreground); text-decoration: none; margin-right: auto; }
header form { display: flex; gap: 6px; }
input[type=search] { font: inherit; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--muted); color: var(--foreground); min-width: 0; width: 14rem; max-width: 60vw; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--muted); color: var(--foreground); }
.layout { display: grid; grid-template-columns: 1fr; }
main { padding: 16px; min-width: 0; max-width: 52rem; }
nav.pages { padding: 16px; background: var(--sidebar); border-top: 1px solid var(--border); }
nav.pages ul { list-style: none; margin: 0; padding-left: 0; }
nav.pages ul ul { padding-left: 14px; }
nav.pages li { margin: 2px 0; }
nav.pages a { color: var(--foreground); text-decoration: none; }
nav.pages a[aria-current=page] { color: var(--primary); font-weight: 600; }
nav.pages .section { color: var(--muted-foreground); font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin-top: 8px; display: block; }
.jump { font-size: 13px; }
@media (min-width: 800px) {
  .layout { grid-template-columns: 16rem 1fr; }
  nav.pages { grid-column: 1; grid-row: 1; border-top: 0; border-right: 1px solid var(--border); min-height: calc(100vh - 50px); }
  main { grid-column: 2; padding: 24px 32px; }
  .jump { display: none; }
}
h1, h2, h3, h4 { line-height: 1.25; }
.permalink { margin-left: 6px; color: var(--muted-foreground); text-decoration: none; opacity: 0; font-weight: 400; }
h1:hover .permalink, h2:hover .permalink, h3:hover .permalink, h4:hover .permalink, h5:hover .permalink, h6:hover .permalink, .permalink:focus { opacity: 1; }
code, pre { font-family: var(--font-mono); font-size: 13px; background: var(--code); border-radius: 4px; }
code { padding: 1px 4px; }
pre { padding: 10px 12px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: var(--muted); }
blockquote { margin: 0; padding: 0 12px; border-left: 3px solid var(--border); color: var(--muted-foreground); }
img { max-width: 100%; }
.meta, .backlinks, .muted { color: var(--muted-foreground); font-size: 13px; }
.meta { margin-top: 32px; padding-top: 8px; border-top: 1px solid var(--border); }
.backlinks ul, .results { padding-left: 18px; }
.results li { margin-bottom: 10px; }
.history td:first-child { font-family: var(--font-mono); }
`;

/** The CSP hash of the one stylesheet, so no inline style but ours is applied and no script runs at all. */
const STYLE_HASH = createHash('sha256').update(WIKI_STYLE).digest('base64');

export const WIKI_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'none'", `style-src 'sha256-${STYLE_HASH}'`, "img-src 'self' https: data:",
    "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Units for "3 days ago", largest first. */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000], ['month', 30 * 86_400_000], ['week', 7 * 86_400_000], ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
];
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeDate(iso: string, now = Date.now()) {
  const elapsed = Date.parse(iso) - now;
  const [unit, size] = RELATIVE_UNITS.find(([, unitMs]) => Math.abs(elapsed) >= unitMs) ?? ['minute', 60_000];
  return RELATIVE.format(Math.round(elapsed / size), unit);
}

function timeTag(iso: string) {
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(relativeDate(iso))}</time>`;
}

type NodeOf<Kind extends WikiNode['kind']> = Extract<WikiNode, { kind: Kind }>;

const NODE_HTML: { [Kind in WikiNode['kind']]: (node: NodeOf<Kind>, current: string) => string } = {
  page: (node, current) => {
    const isCurrent = node.path === current ? ' aria-current="page"' : '';
    return `<li><a href="${escapeHtml(pageUrl(node.path))}"${isCurrent}>${escapeHtml(node.title)}</a></li>`;
  },
  section: (node, current) => `<li><span class="section">${escapeHtml(node.title)}</span>${treeHtml(node.children, current)}</li>`,
};

function treeHtml(nodes: readonly WikiNode[], current: string): string {
  return `<ul>${nodes.map(node => NODE_HTML[node.kind](node as never, current)).join('')}</ul>`;
}

export interface WikiFrame {
  title: string;
  siteTitle: string;
  tree: readonly WikiNode[];
  /** The page the sidebar marks as current. */
  current: string;
  query?: string;
  content: string;
}

/** The whole document around a page's content: header with search, the content, and the sidebar. */
export function frameHtml({ title, siteTitle, tree, current, query, content }: WikiFrame) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title === siteTitle ? title : `${title} · ${siteTitle}`)}</title>
<style>${WIKI_STYLE}</style>
</head>
<body>
<header>
<a class="site" href="/">${escapeHtml(siteTitle)}</a>
<form action="/search" method="get" role="search"><input type="search" name="q" value="${escapeHtml(query ?? '')}" placeholder="Search the wiki" aria-label="Search the wiki"><button type="submit">Search</button></form>
<a class="jump" href="#pages">Pages</a>
</header>
<div class="layout">
<main>
${content}
</main>
<nav class="pages" id="pages" aria-label="Pages">${treeHtml(tree, current)}</nav>
</div>
</body>
</html>`;
}

function entriesHtml(entries: readonly WikiEntry[]) {
  return entries.map(entry => `<li><a href="${escapeHtml(pageUrl(entry.path))}">${escapeHtml(entry.title)}</a></li>`).join('');
}

export interface WikiPageView {
  path: string;
  html: string;
  latest?: WikiHistoryEntry;
  backlinks: readonly WikiEntry[];
}

/** A page's article: its rendered body, who changed it last, its history link and the pages that link to it. */
export function pageHtml({ path, html, latest, backlinks }: WikiPageView) {
  const updated = latest ? `Updated by ${escapeHtml(latest.author)}, ${timeTag(latest.date)}. ` : '';
  const historyLink = `<a href="/history${escapeHtml(pageUrl(path))}">History</a>`;
  const linking = backlinks.length ? `<section class="backlinks"><h2>Linked from</h2><ul>${entriesHtml(backlinks)}</ul></section>` : '';
  return `<article>${html}</article>\n<p class="meta">${updated}${historyLink}</p>\n${linking}`;
}

function hitHtml(hit: WikiSearchHit) {
  return `<li><a href="${escapeHtml(pageUrl(hit.path))}">${escapeHtml(hit.title)}</a><br><span class="muted">${escapeHtml(hit.snippet)}</span></li>`;
}

export function searchHtml(query: string, hits: readonly WikiSearchHit[]) {
  if (!query.trim()) return '<h1>Search</h1><p class="muted">Type a word or two above.</p>';
  const found = hits.length ? `<ol class="results">${hits.map(hitHtml).join('')}</ol>` : '<p class="muted">No pages match.</p>';
  return `<h1>Search: ${escapeHtml(query)}</h1>${found}`;
}

function historyRow(entry: WikiHistoryEntry) {
  return `<tr><td>${escapeHtml(entry.sha.slice(0, 12))}</td><td>${timeTag(entry.date)}</td><td>${escapeHtml(entry.author)}</td><td>${escapeHtml(entry.subject)}</td></tr>`;
}

export function historyHtml(path: string, title: string, entries: readonly WikiHistoryEntry[]) {
  const rows = entries.map(historyRow).join('');
  const table = `<table class="history"><thead><tr><th>Commit</th><th>When</th><th>Who</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<h1>History: <a href="${escapeHtml(pageUrl(path))}">${escapeHtml(title)}</a></h1>${entries.length ? table : '<p class="muted">No commits yet.</p>'}`;
}

export function notFoundHtml(what: string) {
  return `<h1>Not found</h1><p class="muted">${escapeHtml(what)} is not in the wiki. Try the search above, or the pages list.</p>`;
}
