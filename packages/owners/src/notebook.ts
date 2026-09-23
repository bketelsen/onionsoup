import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NotebookEdit, NotebookRegister } from './artifacts.ts';

const run = promisify(execFile);

export const NOTEBOOK_LIMITS = { orientationChars: 24_000 };

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

  async journalSince(marker: string | undefined) {
    const { stdout } = await git(this.root, ['ls-files', '--others', '--cached', `${this.ownerId}/journal`]);
    const files = stdout.split('\n').filter(Boolean).sort();
    const lines = (await Promise.all(files.map(file => readFile(join(this.root, file), 'utf8')))).join('').split('\n').filter(Boolean);
    return marker ? lines.filter(line => (JSON.parse(line) as { at: string }).at > marker) : lines;
  }

  async commit(message: string) {
    await git(this.root, ['add', '-A', this.ownerId]);
    const { stdout } = await git(this.root, ['status', '--porcelain', this.ownerId]);
    if (!stdout.trim()) return;
    await git(this.root, ['commit', '-q', '-m', `${this.ownerId}: ${message}`]);
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
    const current = await readFile(path, 'utf8');
    await writeFile(path, editSection(current, edit));
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
