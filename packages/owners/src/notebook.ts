import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { NotebookEdit, NotebookRegister } from './artifacts.ts';
import type { JournalCursor, MemoryPolicy } from './memory-config.ts';
import { withRecordLock } from './record-lock.ts';

const run = promisify(execFile);

export const NOTEBOOK_LIMITS = { orientationChars: 24_000 };

/** The last commit queued per notebooks repository; see Notebook.commit. */
const COMMITS = new Map<string, Promise<void>>();
const JournalTimestamp = z.object({ at: z.string() });
const JournalKind = z.object({ kind: z.string() });
const HOUSEKEEPING = new Set(['wake', 'app-updates', 'maintain-prs']);

const REGISTER_TITLES: Record<NotebookRegister, string> = {
  MAP: 'Map: layout of the domain',
  WISDOM: 'Wisdom: conventions and lessons that hold',
  FAILURES: 'Failures: incidents and what caused them',
  decisions: 'Decisions',
  'open-questions': 'Open questions',
};

export interface JournalEntry {
  kind: string;
  workItem?: string;
  stage?: string;
  model?: string;
  outcome?: string;
  note?: string;
  /** The person's exact words, for decisions noted from a chat. */
  quote?: string;
  /** The chat session an entry came from. */
  session?: string;
}

export class Notebook {
  readonly directory: string;

  /**
   * `charter` reads the owner's charter from the person's configuration: the notebook's CHARTER.md is only a copy
   * (kept for its history), and a copy taken once goes stale the moment the person edits the charter.
   */
  constructor(readonly root: string, readonly ownerId: string, private readonly charter?: () => Promise<string>) {
    this.directory = join(root, ownerId);
  }

  /** The charter as the person wrote it now, falling back to the notebook's copy. */
  async charterText() {
    const copy = () => readFile(join(this.directory, 'CHARTER.md'), 'utf8').catch(() => '');
    return this.charter ? this.charter().catch(copy) : copy();
  }

  /**
   * The charter and the chosen registers, as briefs and chats read them. Registers still holding only their title
   * are left out: an empty section is noise to a reader.
   */
  async read(registers: readonly (NotebookRegister | 'CHARTER')[]) {
    const sections: string[] = [];
    for (const register of registers) {
      const text = register === 'CHARTER' ? await this.charterText() : await readFile(join(this.directory, `${register}.md`), 'utf8').catch(() => '');
      if (text.trim().split('\n').filter(line => line.trim()).length <= 1) continue;
      sections.push(`<<${register}.md>>\n${text}`);
    }
    return sections.join('\n\n').slice(0, NOTEBOOK_LIMITS.orientationChars);
  }

  async ensure(charter: string) {
    if (!existsSync(join(this.root, '.git'))) {
      await mkdir(this.root, { recursive: true });
      await git(this.root, ['init', '-q', '-b', 'main']);
    }
    await mkdir(join(this.directory, 'journal'), { recursive: true });
    const created = [await this.writeIfChanged('CHARTER.md', charter)];
    for (const [register, title] of Object.entries(REGISTER_TITLES)) {
      created.push(await this.writeIfMissing(`${register}.md`, `# ${title}\n`));
    }
    await this.commit(created.some(Boolean) ? 'Scaffold notebook' : 'journal');
  }

  /** Everything an owner reads about itself: the charter and every register. */
  async orientation() {
    return this.read(['CHARTER', ...(Object.keys(REGISTER_TITLES) as NotebookRegister[])]);
  }

  async apply(edits: readonly NotebookEdit[], message: string) {
    for (const edit of edits) await this.applyOne(edit);
    await this.commit(message);
  }

  async journal(entry: JournalEntry) {
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ at: new Date().toISOString(), owner: this.ownerId, ...entry });
    await appendFile(join(this.directory, 'journal', `${day}.jsonl`), line + '\n');
  }

  /** A bounded snapshot with a line cursor: entries appended during a hire remain unread. */
  async journalSnapshot(policy: MemoryPolicy, cursor?: JournalCursor, legacyMarker?: string) {
    const directory = join(this.directory, 'journal');
    const files = (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).filter(file => file.endsWith('.jsonl')).sort();
    const snapshot = { lines: [] as string[], cursor, chars: 0, hasMore: false };
    for (const file of files) {
      if (cursor && file < cursor.file) continue;
      const lines = (await readFile(join(directory, file), 'utf8')).split('\n').slice(0, -1);
      const start = cursor?.file === file ? cursor.line : 0;
      for (let index = start; index < lines.length; index++) {
        const line = lines[index]!;
        const parsed: unknown = JSON.parse(line);
        const wasConsumed = legacyMarker && JournalTimestamp.parse(parsed).at <= legacyMarker;
        if (wasConsumed || HOUSEKEEPING.has(JournalKind.parse(parsed).kind)) {
          snapshot.cursor = { file, line: index + 1 };
          continue;
        }
        if (snapshot.lines.length >= policy.maxEntries) return { ...snapshot, hasMore: true };
        if (snapshot.chars + line.length > policy.maxChars) {
          if (snapshot.lines.length) return { ...snapshot, hasMore: true };
          throw new Error(`memory_entry_too_large: ${file}:${index + 1}; increase memory.maxChars`);
        }
        snapshot.lines.push(line);
        snapshot.chars += line.length;
        snapshot.cursor = { file, line: index + 1 };
      }
    }
    return snapshot;
  }

  /**
   * Every owner's notebook lives in one git repository, and duties and work items now run side by side: commits
   * queue within this process, and wait out another process's lock (the plugin commits too).
   */
  async commit(message: string) {
    const previous = COMMITS.get(this.root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.commitNow(message));
    COMMITS.set(this.root, next);
    return next;
  }

  private async commitNow(message: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        await git(this.root, ['add', '-A', this.ownerId]);
        const { stdout } = await git(this.root, ['status', '--porcelain', this.ownerId]);
        if (!stdout.trim()) return;
        await git(this.root, ['commit', '-q', '-m', `${this.ownerId}: ${message}`]);
        return;
      } catch (error) {
        if (attempt >= 8 || !/index\.lock/.test(String((error as { stderr?: string }).stderr ?? error))) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  /** Keep the notebook's charter copy in step with the person's charter, so its history shows their edits. */
  private async writeIfChanged(file: string, text: string) {
    const path = join(this.directory, file);
    if ((await readFile(path, 'utf8').catch(() => undefined)) === text) return false;
    await writeFile(path, text);
    return true;
  }

  private async writeIfMissing(file: string, content: string) {
    const path = join(this.directory, file);
    if (existsSync(path)) return false;
    await writeFile(path, content);
    return true;
  }

  private async applyOne(edit: NotebookEdit) {
    const path = join(this.directory, `${edit.register}.md`);
    await withRecordLock(join(this.root, '.git', `register-${this.ownerId}-${edit.register}.lock`), async () => {
      const current = await readFile(path, 'utf8');
      await writeFile(path, editSection(current, edit));
    });
  }
}

/** Models often start a section's text with the section's own heading; the register already has it. */
function withoutRepeatedHeading(text: string, section: string) {
  const lines = text.trim().split('\n');
  const first = lines[0]?.replace(/^#+\s*/, '').trim();
  return /^#+\s/.test(lines[0] ?? '') && first === section.trim() ? lines.slice(1).join('\n').trim() : text.trim();
}

export function editSection(markdown: string, edit: NotebookEdit) {
  const heading = `## ${edit.section.trim()}`;
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.trim() === heading);
  const body = withoutRepeatedHeading(edit.text, edit.section);
  if (start < 0) return `${markdown.trimEnd()}\n\n${heading}\n\n${body}\n`;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const end = next < 0 ? lines.length : next;
  const existing = lines.slice(start + 1, end).join('\n').trim();
  const merged = edit.mode === 'append' && existing ? `${existing}\n\n${body}` : body;
  const rebuilt = [...lines.slice(0, start), heading, '', merged, '', ...lines.slice(end)];
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function git(directory: string, args: string[]) {
  return run('git', ['-C', directory, ...args], { maxBuffer: 16 * 1024 * 1024 });
}
