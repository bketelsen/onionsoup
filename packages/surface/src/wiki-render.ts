import { posix } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { INDEX_PAGE, linkedPage } from '@onionsoup/owners';

/**
 * Wiki markdown as HTML, rendered on the server with marked. Raw HTML in a page is shown as text, never emitted, and
 * only http(s), mailto, in-page and site links survive. Headings get ids (MkDocs' toc slugs, so old anchors keep
 * working) and a permalink; relative links to other pages are rewritten to the site's URLs.
 */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_UNESCAPES: Record<string, string> = Object.fromEntries(Object.entries(HTML_ESCAPES).map(([character, entity]) => [entity, character]));

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, character => HTML_ESCAPES[character]!);
}

function unescapeHtml(text: string) {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => HTML_UNESCAPES[entity]!);
}

/** The site URL of a page: index.md is /, hosts/index.md is /hosts/, hosts/selfie.md is /hosts/selfie. */
export function pageUrl(path: string) {
  const withoutIndex = posix.basename(path) === INDEX_PAGE ? path.slice(0, -INDEX_PAGE.length) : path.replace(/\.md$/, '');
  return `/${withoutIndex.split('/').map(encodeURIComponent).join('/')}`;
}

/** Schemes a link may use; anything else (javascript:, data:, file:) is dropped. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const SCHEME = /^([a-z][a-z0-9+.-]*:)/i;

/** Where a link from a page should point on the site, or undefined when it must not be a link. */
export function siteHref(href: string, fromPath: string) {
  // Browsers ignore whitespace and control characters inside a scheme ("java\tscript:"), so the check does too.
  const scheme = SCHEME.exec(href.replace(/[\u0000- \u007f]/g, ''))?.[1]?.toLowerCase();
  if (scheme) return SAFE_SCHEMES.has(scheme) ? href.trim() : undefined;
  const target = linkedPage(fromPath, href);
  if (!target) return href;
  const anchor = href.includes('#') ? href.slice(href.indexOf('#')) : '';
  return `${pageUrl(target)}${anchor}`;
}

/** MkDocs' toc slug: ASCII word characters, spaces and hyphens, lowercased, runs of either joined by one hyphen. */
function mkdocsSlug(text: string) {
  const ascii = text.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  return ascii.replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-') || 'section';
}

/** Unique heading ids within one page: a repeated slug gets _1, _2, as MkDocs does. */
class HeadingIds {
  private readonly used = new Set<string>();

  next(text: string) {
    const slug = mkdocsSlug(text);
    let id = slug;
    for (let count = 1; this.used.has(id); count++) id = `${slug}_${count}`;
    this.used.add(id);
    return id;
  }
}

function attribute(name: string, value: string | null | undefined) {
  return value ? ` ${name}="${escapeHtml(value)}"` : '';
}

function pageMarked(fromPath: string) {
  const ids = new HeadingIds();
  return new Marked({
    gfm: true,
    renderer: {
      html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const id = ids.next(unescapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer)));
        const permalink = `<a class="permalink" href="#${id}" aria-label="Link to this section">¶</a>`;
        return `<h${depth} id="${id}">${inner}${permalink}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = siteHref(href, fromPath);
        return target === undefined ? inner : `<a${attribute('href', target)}${attribute('title', title)}>${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const source = siteHref(href, fromPath);
        return source === undefined ? escapeHtml(text) : `<img${attribute('src', source)}${attribute('alt', text)}${attribute('title', title)}>`;
      },
    },
  });
}

/** A page's markdown body as safe HTML. */
export function renderMarkdown(markdown: string, fromPath: string) {
  return pageMarked(fromPath).parse(markdown, { async: false });
}
