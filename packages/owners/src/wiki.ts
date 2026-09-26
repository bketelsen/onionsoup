import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withRecordLock } from './record-lock.ts';
import type { JournalEntry } from './notebook.ts';
import type { Runtime } from './runtime.ts';
import { REFUSED_SHAPES, secretShapesIn } from './secret-shapes.ts';
import { WIKI_FILE, type WikiDeclaration } from './wiki-config.ts';
import { pageBacklinks, pagePath, pageTree, parsePage, readPages, readPageText, searchPages, WIKI_LIMITS } from './wiki-pages.ts';
import { cloneIfMissing, git, gitWithLiteralPathspecs } from './workspace.ts';

export { WIKI_LIMITS } from './wiki-pages.ts';

/**
 * The wiki: markdown pages in a git repository, served on the LAN by the surface and written by one owner, its
 * keeper. Host code holds the clone at `<home>/wiki`: reads come from its working tree, and each write is checked
 * (path, size, secrets), committed as the keeper and pushed at once, so the remote is the backup. Writes are
 * serialized under a record lock and journaled to the keeper's notebook. wiki-pages.ts reads the files.
 */

/** Journal kinds wiki writes leave in the keeper's notebook; activity views and chat context show them. */
export const WIKI_JOURNAL_KINDS = ['wiki-write', 'wiki-move', 'wiki-delete'] as const;
export type WikiJournalKind = typeof WIKI_JOURNAL_KINDS[number];

/** The permission a page deletion asks the person for; nothing answers it for them. */
export const WIKI_DELETE_PERMISSION = 'onionsoup_wiki_delete';

export interface WikiHistoryEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface WikiChange {
  /** The page changed (the new path, for a move). */
  path: string;
  commit: string;
  outcome: 'pushed' | 'unchanged';
}

/** What a change stages in the clone; it returns what the journal says was done. */
type ChangeApply = (directory: string) => Promise<string>;

interface ChangeRequest {
  by: string;
  kind: WikiJournalKind;
  reason: string;
  path: string;
  apply: ChangeApply;
}

const FIELD_SEPARATOR = '\u001f';
const LOG_FORMAT = ['%H', '%an', '%aI', '%s'].join(FIELD_SEPARATOR);

function gitStderr(error: unknown) {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : String(error);
}

function isPushRejected(error: unknown) {
  return /\[rejected\]|fetch first|non-fast-forward/.test(gitStderr(error));
}

function historyEntry(line: string): WikiHistoryEntry {
  const [sha, author, date, subject] = line.split(FIELD_SEPARATOR);
  return { sha: sha!, author: author!, date: date!, subject: subject ?? '' };
}

/** The wiki as wiki.yaml declares it, or wiki_not_configured. */
export function openWiki(runtime: Runtime) {
  const declaration = runtime.declarations.wiki;
  if (!declaration) throw new Error(`wiki_not_configured: there is no ${WIKI_FILE} in the configuration`);
  return new Wiki(runtime, declaration);
}

export class Wiki {
  /** The clone the wiki is read from and written through. */
  readonly directory: string;
  /** The pages directory inside the clone. */
  readonly pagesRoot: string;
  private readonly lockPath: string;

  constructor(private readonly runtime: Runtime, readonly declaration: WikiDeclaration) {
    this.directory = join(runtime.stateDirectory, '..', 'wiki');
    this.pagesRoot = join(this.directory, declaration.pagesDirectory);
    this.lockPath = join(runtime.stateDirectory, 'locks', 'wiki.lock');
  }

  get keeper() {
    return this.declaration.keeper;
  }

  /** Clone the wiki on first use. */
  async ensureClone() {
    if (existsSync(join(this.directory, '.git'))) return;
    await withRecordLock(this.lockPath, () => this.cloneUnlocked());
  }

  /** Fetch, and fast-forward the clone, so pages pushed from elsewhere show up. A diverged clone is left as it is. */
  async sync() {
    await withRecordLock(this.lockPath, async () => {
      await this.cloneUnlocked();
      await git(this.directory, ['fetch', '-q', 'origin']);
      await git(this.directory, ['merge', '-q', '--ff-only', `origin/${this.declaration.branch}`]).catch(error => {
        throw new Error(`wiki_sync_diverged: ${this.directory} has commits the remote does not: ${gitStderr(error)}`);
      });
    });
  }

  /** A page path checked against the pages directory. */
  pagePath(path: string) {
    return pagePath(path, this.declaration.pagesDirectory);
  }

  async pages() {
    await this.ensureClone();
    return readPages(this.pagesRoot);
  }

  /** The pages as a tree: index first, then by order, then by title. */
  async list() {
    return pageTree(await this.pages());
  }

  async read(path: string) {
    const page = this.pagePath(path);
    await this.ensureClone();
    const text = await readFile(join(this.pagesRoot, page), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error(`wiki_page_not_found: ${page}`);
      throw error;
    });
    return readPageText(page, text);
  }

  async search(query: string) {
    return searchPages(await this.pages(), query);
  }

  /** A page's commits, newest first, following renames. */
  async history(path: string): Promise<WikiHistoryEntry[]> {
    const page = this.pagePath(path);
    await this.ensureClone();
    const args = ['log', '--follow', `-n${WIKI_LIMITS.historyEntries}`, `--format=${LOG_FORMAT}`, '--', join(this.declaration.pagesDirectory, page)];
    const output = await gitWithLiteralPathspecs(this.directory, args);
    return output.split('\n').filter(Boolean).map(historyEntry);
  }

  async backlinks(path: string) {
    return pageBacklinks(await this.pages(), this.pagePath(path));
  }

  /** Write a page (create or replace) as the keeper, and push it. */
  async write(by: string, path: string, content: string, reason: string) {
    const page = this.checkWrite(by, path, reason);
    checkSize(page, content);
    checkSecrets(`${content}\n${reason}`);
    parsePage(content);
    return this.commitChange({
      by, kind: 'wiki-write', reason, path: page,
      apply: async directory => {
        const file = join(directory, this.declaration.pagesDirectory, page);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
        await gitWithLiteralPathspecs(directory, ['add', '--', join(this.declaration.pagesDirectory, page)]);
        return page;
      },
    });
  }

  /** Move a page as the keeper, and push it. Links to it are not rewritten. */
  async move(by: string, from: string, to: string, reason: string) {
    const source = this.checkWrite(by, from, reason);
    const target = this.pagePath(to);
    checkSecrets(reason);
    await this.ensureClone();
    this.requirePage(source);
    if (existsSync(join(this.pagesRoot, target))) throw new Error(`wiki_page_exists: ${target}`);
    return this.commitChange({
      by, kind: 'wiki-move', reason, path: target,
      apply: async directory => {
        await mkdir(dirname(join(directory, this.declaration.pagesDirectory, target)), { recursive: true });
        await gitWithLiteralPathspecs(directory, ['mv', '--', ...[source, target].map(page => join(this.declaration.pagesDirectory, page))]);
        return `${source} → ${target}`;
      },
    });
  }

  /** What a delete checks before the person is asked: the keeper, the path, and that the page exists. */
  async checkDelete(by: string, path: string, reason: string) {
    const page = this.checkWrite(by, path, reason);
    checkSecrets(reason);
    await this.ensureClone();
    this.requirePage(page);
    return page;
  }

  /** Delete a page as the keeper, and push it. The caller has asked the person. */
  async delete(by: string, path: string, reason: string) {
    const page = await this.checkDelete(by, path, reason);
    return this.commitChange({
      by, kind: 'wiki-delete', reason, path: page,
      apply: async directory => {
        await gitWithLiteralPathspecs(directory, ['rm', '-q', '--', join(this.declaration.pagesDirectory, page)]);
        return page;
      },
    });
  }

  /**
   * One change under the wiki's lock: stage it, commit it as the keeper with the reason as its subject, push it, and
   * journal it. Host-run changes that touch several files (a migration) use it directly; the keeper is still checked.
   */
  async commitChange(change: ChangeRequest): Promise<WikiChange> {
    this.checkKeeper(change.by);
    return withRecordLock(this.lockPath, async () => {
      await this.cloneUnlocked();
      await git(this.directory, ['reset', '-q']);
      const done = await change.apply(this.directory);
      if (!(await this.hasStagedChanges())) return { path: change.path, commit: await this.head(), outcome: 'unchanged' };
      const commit = await this.commit(change.reason);
      await this.publish(change, done, commit);
      return { path: change.path, commit: await this.head(), outcome: 'pushed' };
    });
  }

  private checkKeeper(by: string) {
    if (by !== this.keeper) throw new Error(`wiki_not_keeper: only ${this.keeper} writes the wiki; send corrections to ${this.keeper}`);
  }

  private checkWrite(by: string, path: string, reason: string) {
    this.checkKeeper(by);
    checkReason(reason);
    return this.pagePath(path);
  }

  private requirePage(page: string) {
    if (!existsSync(join(this.pagesRoot, page))) throw new Error(`wiki_page_not_found: ${page}`);
  }

  private async cloneUnlocked() {
    await mkdir(dirname(this.directory), { recursive: true });
    await cloneIfMissing(this.declaration.repository, this.directory, this.declaration.branch).catch(error => {
      throw new Error(`wiki_clone_failed: ${this.declaration.repository}: ${gitStderr(error)}`);
    });
  }

  private async hasStagedChanges() {
    return (await git(this.directory, ['diff', '--cached', '--name-only'])).trim() !== '';
  }

  private async head() {
    return (await git(this.directory, ['rev-parse', 'HEAD'])).trim();
  }

  /** git configured as the keeper: the persona's name, and an onionsoup address. */
  private asKeeper(args: string[]) {
    const name = this.runtime.declarations.owners.get(this.keeper)?.persona?.name ?? this.keeper;
    return ['-c', `user.name=${name}`, '-c', `user.email=${this.keeper}@onionsoup`, '-c', 'commit.gpgsign=false', ...args];
  }

  private async commit(reason: string) {
    await git(this.directory, this.asKeeper(['commit', '-q', '-m', reason.trim()]));
    return this.head();
  }

  /** Push; a push the remote refused because it moved is rebased and pushed once more. */
  private async push() {
    const push = ['push', '-q', 'origin', `HEAD:refs/heads/${this.declaration.branch}`];
    const firstPush = await git(this.directory, push).then(() => undefined, (error: unknown) => error);
    if (firstPush === undefined) return;
    if (!isPushRejected(firstPush)) throw new Error(`wiki_push_failed: ${gitStderr(firstPush)}`);
    await git(this.directory, ['fetch', '-q', 'origin']);
    await this.rebaseOntoRemote();
    await git(this.directory, push).catch(error => {
      throw new Error(`wiki_push_failed: ${gitStderr(error)}`);
    });
  }

  private async rebaseOntoRemote() {
    const rebase = this.asKeeper(['rebase', '-q', `origin/${this.declaration.branch}`]);
    const failure = await git(this.directory, rebase).then(() => undefined, (error: unknown) => error);
    if (failure === undefined) return;
    await git(this.directory, ['rebase', '--abort']).catch(() => undefined);
    throw new Error(`wiki_push_conflict: the remote changed the same lines; the commit is kept in ${this.directory}: ${gitStderr(failure)}`);
  }

  /** Push the commit and journal it; a failed push is journaled too, and raises the person's attention. */
  private async publish(change: ChangeRequest, done: string, commit: string) {
    const failure = await this.push().then(() => undefined, (error: unknown) => error);
    const isPushed = failure === undefined;
    const outcome = `${done} at ${commit.slice(0, 12)}${isPushed ? '' : ', kept locally, not pushed'}`;
    await this.journal({ kind: change.kind, note: change.reason, outcome });
    if (isPushed) return;
    const reason = failure instanceof Error ? failure.message : String(failure);
    await this.journal({ kind: 'attention', note: `wiki ${done}: ${reason}` });
    throw failure;
  }

  private async journal(entry: JournalEntry) {
    const notebook = this.runtime.notebook(this.keeper);
    await notebook.ensureJournal();
    await notebook.journal(entry);
    await notebook.commit(entry.kind).catch(error => console.warn('wiki_journal_commit_failed', error instanceof Error ? error.message : String(error)));
  }
}

function checkReason(reason: string) {
  const subject = reason.trim();
  if (!subject || subject.includes('\n')) throw new Error('wiki_reason_invalid: give the reason as one line; it becomes the commit subject');
  if (subject.length > WIKI_LIMITS.reasonChars) throw new Error(`wiki_reason_invalid: ${subject.length} characters; at most ${WIKI_LIMITS.reasonChars}`);
}

function checkSize(page: string, content: string) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WIKI_LIMITS.pageBytes) throw new Error(`wiki_page_too_large: ${page} is ${bytes} bytes; at most ${WIKI_LIMITS.pageBytes}`);
}

function checkSecrets(text: string) {
  const found = secretShapesIn(text, REFUSED_SHAPES);
  if (found.length) throw new Error(`wiki_secret_detected: the text holds what looks like a credential (${found.join(', ')}); never put secrets in the wiki`);
}
