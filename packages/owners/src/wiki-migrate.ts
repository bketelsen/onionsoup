import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Wiki, WikiChange } from './wiki.ts';
import { pageText, pageTitle, parsePage } from './wiki-pages.ts';
import { gitWithLiteralPathspecs } from './workspace.ts';

/**
 * The one-shot move from MkDocs: the order of mkdocs.yml's `nav` becomes `order:` frontmatter on each page (and a nav
 * title that differs from the page's own becomes `title:`), mkdocs.yml is deleted, and the result is committed as the
 * keeper and pushed. The operator runs it once with `owners wiki migrate`.
 */
export const MIGRATION_REASON = 'Serve the wiki from onionsoup: nav order moved into frontmatter';
export const MKDOCS_FILE = 'mkdocs.yml';
/** Orders are spaced, so a page can later go between two others without renumbering. */
export const NAV_ORDER_STEP = 10;

type NavEntry = string | { [title: string]: string | NavEntry[] };
const NavEntry: z.ZodType<NavEntry> = z.lazy(() => z.union([z.string(), z.record(z.string(), z.union([z.string(), z.array(NavEntry)]))]));
const MkdocsConfig = z.object({ nav: z.array(NavEntry).default([]) }).loose();

export interface NavPlacement {
  path: string;
  order: number;
  /** The title the nav gave the page, if it named one. */
  title?: string;
}

export interface WikiMigration {
  change: WikiChange;
  ordered: string[];
  /** Pages the nav names that do not exist. */
  missing: string[];
}

function isExternal(target: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function titledPlacements(title: string, value: string | NavEntry[], next: () => number): NavPlacement[] {
  if (Array.isArray(value)) return value.flatMap(entry => navPlacements(entry, next));
  return isExternal(value) ? [] : [{ path: value, order: next(), title }];
}

/** A nav entry's pages, depth first, each numbered in the order the nav lists it. */
function navPlacements(entry: NavEntry, next: () => number): NavPlacement[] {
  if (typeof entry === 'string') return isExternal(entry) ? [] : [{ path: entry, order: next() }];
  return Object.entries(entry).flatMap(([title, value]) => titledPlacements(title, value, next));
}

/** The pages mkdocs.yml's nav lists, in order. */
export function parseNav(mkdocsYaml: string) {
  const parsed = MkdocsConfig.safeParse(parse(mkdocsYaml, { logLevel: 'error' }));
  if (!parsed.success) throw new Error(`wiki_nav_invalid: ${MKDOCS_FILE}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  let counter = 0;
  const next = () => (counter += NAV_ORDER_STEP);
  return parsed.data.nav.flatMap(entry => navPlacements(entry, next));
}

/** A page's text with its nav order (and a differing nav title) in its frontmatter. */
function orderedPageText(path: string, text: string, placement: NavPlacement) {
  const document = parsePage(text);
  const hasOwnTitle = placement.title === undefined || placement.title === pageTitle(path, document);
  const title = hasOwnTitle ? {} : { title: placement.title };
  return pageText({ frontmatter: { ...document.frontmatter, ...title, order: placement.order }, body: document.body });
}

async function orderPage(pagesRoot: string, placement: NavPlacement) {
  const file = join(pagesRoot, placement.path);
  await writeFile(file, orderedPageText(placement.path, await readFile(file, 'utf8'), placement));
}

/** Move mkdocs.yml's nav into frontmatter, delete mkdocs.yml, commit as the keeper and push. */
export async function migrateNav(wiki: Wiki): Promise<WikiMigration> {
  await wiki.sync();
  const mkdocs = join(wiki.directory, MKDOCS_FILE);
  if (!existsSync(mkdocs)) throw new Error(`wiki_migration_not_needed: ${MKDOCS_FILE} is not in the wiki`);
  const placements = parseNav(await readFile(mkdocs, 'utf8'));
  const present = placements.filter(placement => existsSync(join(wiki.pagesRoot, placement.path)));
  const missing = placements.filter(placement => !present.includes(placement)).map(placement => placement.path);
  const change = await wiki.commitChange({
    by: wiki.keeper, kind: 'wiki-write', reason: MIGRATION_REASON, path: MKDOCS_FILE,
    apply: async directory => {
      for (const placement of present) await orderPage(wiki.pagesRoot, placement);
      const pages = present.map(placement => join(wiki.declaration.pagesDirectory, placement.path));
      if (pages.length) await gitWithLiteralPathspecs(directory, ['add', '--', ...pages]);
      await gitWithLiteralPathspecs(directory, ['rm', '-q', '--', MKDOCS_FILE]);
      return `ordered ${present.length} pages from ${MKDOCS_FILE}'s nav and removed it`;
    },
  });
  return { change, ordered: present.map(placement => placement.path), missing };
}
