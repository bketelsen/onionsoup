// Parsing unified diffs for the diff view (DiffView.tsx). Pure, so it is tested without a browser.

export interface Row { kind: 'context' | 'add' | 'remove' | 'hunk'; old?: number; new?: number; text: string }
export interface FileDiff { path: string; rows: Row[]; additions: number; deletions: number }

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  py: 'python', go: 'go', rs: 'rust', sh: 'bash', bash: 'bash', css: 'css', html: 'html', toml: 'toml', sql: 'sql', conf: 'ini', service: 'ini',
};

export function languageOf(path: string) {
  const name = path.split('/').pop() ?? '';
  if (name === 'Dockerfile') return 'docker';
  if (name.endsWith('.chroot') || name.endsWith('.postinst')) return 'bash';
  return EXTENSIONS[name.split('.').pop() ?? ''] ?? '';
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('Index: ') || line.startsWith('===') || line.startsWith('diff --git')) continue;
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) {
      file = { path: line.slice(4).replace(/^b\//, '').trim(), rows: [], additions: 0, deletions: 0 };
      files.push(file);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      if (!file) { file = { path: '', rows: [], additions: 0, deletions: 0 }; files.push(file); }
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!file || line.startsWith('\\')) continue;
    if (line.startsWith('+')) { file.rows.push({ kind: 'add', new: newLine++, text: line.slice(1) }); file.additions++; }
    else if (line.startsWith('-')) { file.rows.push({ kind: 'remove', old: oldLine++, text: line.slice(1) }); file.deletions++; }
    else if (line.startsWith(' ') || line === '') { file.rows.push({ kind: 'context', old: oldLine++, new: newLine++, text: line.slice(1) }); }
  }
  return files.filter(entry => entry.rows.length);
}

/** A whole new file as a diff of added lines (the write tool). */
export function addedFile(path: string, content: string): FileDiff {
  const lines = content.replace(/\n$/, '').split('\n');
  return { path, additions: lines.length, deletions: 0, rows: lines.map((text, index) => ({ kind: 'add' as const, new: index + 1, text })) };
}
