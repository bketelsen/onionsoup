import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { Commit, SourcePath, LOCATION_LIMITS as L, isTestPath, type Excerpt } from './location-contracts.ts';

const execute = promisify(execFile);
type Blob = { oid: string; bytes: number };
const sensitive = (p: string) => /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i.test(p);
export class LocationSource {
  readonly excerpts: Excerpt[] = [];
  readonly activities: Array<{ tool: string; input: unknown; at: string; result?: unknown; error?: string }> = [];
  searchedTests = false;
  calls = 0;
  returnedChars = 0;
  private constructor(readonly directory: string, readonly repository: string, readonly commit: string,
    private readonly blobs: Map<string, Blob>, private readonly signal?: AbortSignal) {}
  private static async git(directory: string, args: string[], signal?: AbortSignal, maxBuffer = 8 * 1024 * 1024) {
    return execute('git', ['--no-pager', '-c', 'core.quotePath=false', '-C', directory, ...args], { signal, timeout: 10000, maxBuffer,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
  }
  static async open(directory: string, repository: string, commit: string, signal?: AbortSignal) {
    Commit.parse(commit);
    directory = await realpath(directory);
    const origin = (await this.git(directory, ['config', '--get', 'remote.origin.url'], signal)).stdout.trim().replace(/\.git$/, '').replace(/\/$/, '');
    if (![ `https://github.com/${repository}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}` ].some(url => url.toLowerCase() === origin.toLowerCase()))
      throw new Error('SOURCE_REPOSITORY_MISMATCH: origin must match the issue repository');
    const resolved = (await this.git(directory, ['rev-parse', '--verify', `${commit}^{commit}`], signal)).stdout.trim();
    if (resolved !== commit) throw new Error('SOURCE_COMMIT_MISMATCH');
    const tree = (await this.git(directory, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], signal)).stdout;
    const blobs = new Map<string, Blob>();
    for (const entry of tree.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match || !SourcePath.safeParse(match[4]).success || sensitive(match[4]) || Number(match[3]) > L.fileBytes) continue;
      blobs.set(match[4], { oid: match[2], bytes: Number(match[3]) });
    }
    return new LocationSource(directory, repository, commit, blobs, signal);
  }
  private async inspect<T extends object>(tool: string, input: unknown, work: () => Promise<T>): Promise<T> {
    this.signal?.throwIfAborted();
    if (this.calls >= L.inspectionCalls || this.returnedChars >= L.contextChars) throw new Error('SOURCE_BUDGET_EXHAUSTED: submit the evidence already found, with uncertainty');
    this.calls++;
    const event: (typeof this.activities)[number] = { tool, input, at: new Date().toISOString() };
    this.activities.push(event);
    try {
      const result = { ...await work(), remainingInspectionCalls: L.inspectionCalls - this.calls };
      const length = JSON.stringify(result).length;
      if (this.returnedChars + length > L.contextChars) throw new Error('SOURCE_CONTEXT_BUDGET: request a smaller result or submit');
      this.returnedChars += length; event.result = result; return result;
    } catch (error) {
      event.error = error instanceof Error && /^(SOURCE_|UNAVAILABLE_|INVALID_)/.test(error.message) ? error.message : 'SOURCE_READ_FAILED';
      throw new Error(event.error);
    }
  }
  async search(input: { query: string; scope: 'code' | 'tests' | 'all'; pathPrefix: string }) {
    return this.inspect('search_repository', input, async () => {
      if (!input.query || input.query.length > 160 || /[\x00-\x1f]/.test(input.query)) throw new Error('INVALID_QUERY: use one literal line');
      if (input.pathPrefix) SourcePath.parse(input.pathPrefix.replace(/\/$/, ''));
      const searchedPrefixes = [input.pathPrefix];
      let result = await this.findMatches(input.query, input.scope, input.pathPrefix);
      // One bounded recovery from a guessed directory; report the wider scope explicitly.
      if (!result.matches.length && input.pathPrefix) {
        searchedPrefixes.push('');
        const wider = await this.findMatches(input.query, input.scope, '');
        result = { ...wider, truncated: result.truncated || wider.truncated };
      }
      if (input.scope === 'tests') this.searchedTests = true;
      return { ...result, searchedPrefixes, broadened: searchedPrefixes.length > 1,
        nextAction: input.scope === 'tests' && result.matches.length ?
          'Read a promising matching test now, near its behavior/assertions rather than imports. Previews cannot support a test citation.' :
          'Read the strongest implementation match. If absent, try a distinctive literal from the report across all paths.',
        note: 'At most 3 matches per file; previews are not citable. A missing scoped match triggers one repository-wide search with the same literal and scope.' };
    });
  }
  private async findMatches(query: string, scope: 'code' | 'tests' | 'all', pathPrefix: string) {
    let stdout = ''; let truncated = false;
    const prefix = pathPrefix ? `:(literal)${pathPrefix}` : '.';
    try {
      stdout = (await LocationSource.git(this.directory, ['grep', '--no-color', '-n', '-I', '-F', '-i', '--max-count=3', '-e', query,
        this.commit, '--', prefix], this.signal, 1024 * 1024)).stdout;
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string };
      if (e.code === 1) stdout = e.stdout ?? '';
      else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { stdout = e.stdout ?? ''; truncated = true; }
      else throw error;
    }
    const matches = [];
    for (const row of stdout.split('\n')) {
      if (!row.startsWith(`${this.commit}:`)) continue;
      const match = /^(.+?):([0-9]+):(.*)$/.exec(row.slice(this.commit.length + 1));
      if (!match || !this.blobs.has(match[1]) ||
        (scope === 'tests' && !isTestPath(match[1])) || (scope === 'code' && isTestPath(match[1]))) continue;
      if (matches.length === L.matches) { truncated = true; break; }
      matches.push({ path: match[1], line: Number(match[2]), preview: match[3].slice(0, 400) });
      if (match[3].length > 400) truncated = true;
    }
    return { matches, truncated };
  }
  private testCandidates(path: string) {
    const name = path.split('/').at(-1)!.replace(/\.[^.]+$/, '').toLowerCase();
    const directory = path.slice(0, path.lastIndexOf('/') + 1);
    const candidates = [...this.blobs.keys()].filter(p => {
      if (!isTestPath(p)) return false;
      const stem = p.split('/').at(-1)!.replace(/\.[^.]+$/, '').toLowerCase();
      return stem === name || stem.startsWith(`${name}.`) || stem.startsWith(`${name}_`) ||
        stem.startsWith(`${name}-`) || stem === `test_${name}`;
    }).sort((a, b) => Number(b.startsWith(directory)) - Number(a.startsWith(directory)) || a.localeCompare(b));
    return { paths: candidates.slice(0, 6), truncated: candidates.length > 6,
      note: 'Filename-based leads only, not verified relevance or coverage. Search/read the test behavior before citing.' };
  }

  async read(input: { path: string; startLine: number; endLine: number }) {
    let pending: Excerpt | undefined;
    const result = await this.inspect('read_repository', input, async () => {
      SourcePath.parse(input.path);
      const blob = this.blobs.get(input.path);
      if (!blob) throw new Error('UNAVAILABLE_PATH: not an allowed regular text file at the pinned commit');
      if (!Number.isSafeInteger(input.startLine) || !Number.isSafeInteger(input.endLine) || input.startLine < 1 || input.endLine < input.startLine)
        throw new Error('INVALID_RANGE: use positive line numbers, with endLine >= startLine');
      const text = (await LocationSource.git(this.directory, ['cat-file', 'blob', blob.oid], this.signal, L.fileBytes + 1)).stdout;
      if (text.includes('\0') || text.includes('\ufffd')) throw new Error('UNAVAILABLE_BINARY: source must be UTF-8 text');
      const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
      if (input.startLine > lines.length) throw new Error('INVALID_RANGE: starts after end of file');
      const endLine = Math.min(input.endLine, input.startLine + L.readLines - 1, lines.length);
      const selected = lines.slice(input.startLine - 1, endLine);
      if (selected.join('\n').length > L.readChars) throw new Error('INVALID_RANGE: exceeds 6000 characters; request fewer lines');
      // Reserve the ID synchronously; parallel reads must never receive the same ID.
      const id = `E${this.nextId++}`;
      pending = { id, path: input.path, startLine: input.startLine, endLine, lines: selected };
      return { excerptId: id, path: input.path, startLine: input.startLine, endLine, totalLines: lines.length,
        truncated: endLine < Math.min(input.endLine, lines.length), nextStartLine: endLine < lines.length ? endLine + 1 : null,
        ...(isTestPath(input.path) ? {} : { relatedTests: this.testCandidates(input.path) }),
        numberedLines: selected.map((line, i) => `${input.startLine + i}: ${line}`).join('\n') };
    });
    if (pending) this.excerpts.push(pending);
    return result;
  }
  private nextId = 1;
}
