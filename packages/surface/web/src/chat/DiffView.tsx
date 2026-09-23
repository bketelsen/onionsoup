import { useEffect, useMemo, useState } from 'react';
import { cx } from '../components/ui.tsx';

// A unified diff view in the manner of OpenChamber's (which uses @pierre/diffs): one file per block, old and new line
// numbers in a gutter, added and removed lines on tinted rows, code highlighted by the file's language.

interface Row { kind: 'context' | 'add' | 'remove' | 'hunk'; old?: number; new?: number; text: string }
interface FileDiff { path: string; rows: Row[]; additions: number; deletions: number }

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

const ROW_STYLE: Record<Row['kind'], React.CSSProperties | undefined> = {
  add: { backgroundColor: 'var(--status-success-background)' },
  remove: { backgroundColor: 'var(--status-error-background)' },
  hunk: { color: 'var(--status-info)', backgroundColor: 'color-mix(in srgb, var(--status-info-background) 60%, transparent)' },
  context: undefined,
};

function FileBlock({ file, directory }: { file: FileDiff; directory: string }) {
  const [highlighted, setHighlighted] = useState<string[]>();
  const language = languageOf(file.path);
  const code = useMemo(() => file.rows.filter(row => row.kind !== 'hunk').map(row => row.text).join('\n'), [file]);
  useEffect(() => {
    if (!language) return;
    let live = true;
    void import('./highlight.ts').then(module => module.highlightLines(code, language)).then(lines => { if (live && lines) setHighlighted(lines); });
    return () => { live = false; };
  }, [code, language]);
  const shown = directory && file.path.startsWith(`${directory}/`) ? file.path.slice(directory.length + 1) : file.path;
  const slash = shown.lastIndexOf('/');
  let index = 0;
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex min-w-0 items-center gap-2 px-2 py-1">
        <div className="min-w-0 flex-1 truncate typography-meta font-medium text-muted-foreground">{slash >= 0 && shown.slice(0, slash + 1)}<span className="text-foreground">{shown.slice(slash + 1)}</span></div>
        <span className="typography-meta tabular-nums shrink-0"><span style={{ color: 'var(--status-success)' }}>+{file.additions}</span><span className="text-muted-foreground">/</span><span style={{ color: 'var(--status-error)' }}>-{file.deletions}</span></span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full border-collapse typography-code" style={{ lineHeight: 'var(--code-block-line-height, 1.4rem)' }}>
          <tbody>
            {file.rows.map((row, position) => {
              const html = row.kind === 'hunk' ? undefined : highlighted?.[index++];
              return (
                <tr key={position} style={ROW_STYLE[row.kind]}>
                  {row.kind === 'hunk'
                    ? <td colSpan={4} className="px-2 py-0.5 text-[0.7rem] font-mono whitespace-pre">{row.text}</td>
                    : <>
                      <td className="w-10 select-none px-1.5 text-right tabular-nums text-muted-foreground/50 align-top">{row.old ?? ''}</td>
                      <td className="w-10 select-none px-1.5 text-right tabular-nums text-muted-foreground/50 align-top border-r border-border/40">{row.new ?? ''}</td>
                      <td className={cx('w-4 select-none text-center align-top', row.kind === 'add' && 'text-[var(--status-success)]', row.kind === 'remove' && 'text-[var(--status-error)]')}>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ''}</td>
                      {html !== undefined
                        ? <td className="pr-3 whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                        : <td className="pr-3 whitespace-pre-wrap break-all">{row.text || ' '}</td>}
                    </>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DiffView({ files, directory }: { files: FileDiff[]; directory: string }) {
  if (!files.length) return <div className="typography-meta text-muted-foreground/70">No changes</div>;
  return <div className="max-h-[50vh] overflow-y-auto p-1">{files.map((file, index) => <FileBlock key={`${file.path}:${index}`} file={file} directory={directory} />)}</div>;
}
