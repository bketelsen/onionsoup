import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const WIKI_FILE = 'wiki.yaml';

/** host:port, with an IPv6 host in brackets: 0.0.0.0:4748, [::]:4748. */
const LISTEN = /^(?:\[(?<ipv6>[^\]]+)\]|(?<host>[^:\s[\]]+)):(?<port>\d{1,5})$/;

export const WikiListen = z.string().transform((value, context) => {
  const groups = LISTEN.exec(value)?.groups;
  const port = Number(groups?.port);
  if (!groups || port < 1 || port > 65_535) {
    context.addIssue({ code: 'custom', message: 'listen must be host:port, e.g. 0.0.0.0:4748' });
    return z.NEVER;
  }
  return { host: groups.ipv6 ?? groups.host!, port };
});
export type WikiListen = z.infer<typeof WikiListen>;

/** A directory inside the repository: relative, and never climbing out of it. */
const RepositoryDirectory = z.string().min(1).refine(
  path => !isAbsolute(path) && !path.split(/[\\/]/).includes('..'),
  'pagesDirectory must be a relative path inside the repository',
).transform(path => path.replace(/\/+$/, ''));

/**
 * The person's wiki (wiki.yaml): a git repository of markdown pages that onionsoup serves on the LAN and one owner,
 * the keeper, writes. Absent file (or one holding only comments), no wiki.
 */
export const WikiDeclaration = z.object({
  /** The git remote the wiki is pushed to as its backup. */
  repository: z.string().min(1),
  branch: z.string().min(1).default('main'),
  /** Where the pages live in the repository. */
  pagesDirectory: RepositoryDirectory.default('docs'),
  /** Where the surface serves the wiki. */
  listen: WikiListen,
  /** The one owner who writes pages; everyone else reads. */
  keeper: z.string().regex(/^[a-z0-9-]+$/),
});
export type WikiDeclaration = z.infer<typeof WikiDeclaration>;

function issuesText(error: z.ZodError) {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** wiki.yaml, if the person wrote one. */
export async function loadWiki(root: string): Promise<WikiDeclaration | undefined> {
  const text = await readFile(join(root, WIKI_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const document = text === undefined ? undefined : parse(text) as unknown;
  if (document === undefined || document === null) return undefined;
  const parsed = WikiDeclaration.safeParse(document);
  if (!parsed.success) throw new Error(`wiki_invalid: ${WIKI_FILE}: ${issuesText(parsed.error)}`);
  return parsed.data;
}

/** The keeper must be a declared owner. */
export function checkWikiKeeper(ownerIds: ReadonlySet<string>, wiki: WikiDeclaration | undefined) {
  if (wiki && !ownerIds.has(wiki.keeper)) throw new Error(`wiki_keeper_unknown: ${WIKI_FILE} names ${wiki.keeper} as keeper, who is not a declared owner`);
}
