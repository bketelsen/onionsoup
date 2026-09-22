export type DiffLine = { kind: 'add' | 'remove' | 'context' | 'hunk'; text: string; oldLine?: number; newLine?: number };
export type DiffFile = { path: string; additions: number; deletions: number; lines: DiffLine[] };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** Line prefixes that carry content, and what each means. */
const CONTENT: Record<string, DiffLine['kind']> = { '+': 'add', '-': 'remove', ' ': 'context' };

/** Split a unified `git diff` into files with numbered lines. Headers other than the path and hunks are dropped. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = { path: text.replace(/^diff --git a\/.* b\//, ''), additions: 0, deletions: 0, lines: [] };
      files.push(file);
      continue;
    }
    const hunk = HUNK.exec(text);
    if (file && hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: 'hunk', text });
      continue;
    }
    const kind = CONTENT[text[0]];
    if (!file || !kind || text.startsWith('+++') || text.startsWith('---')) continue;
    file.lines.push({ kind, text: text.slice(1), oldLine: kind === 'add' ? undefined : oldLine++, newLine: kind === 'remove' ? undefined : newLine++ });
    if (kind === 'add') file.additions++;
    if (kind === 'remove') file.deletions++;
  }
  return files;
}
