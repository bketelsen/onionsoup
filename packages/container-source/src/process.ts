import { spawn, type ChildProcess } from 'node:child_process';
import type { QueryResult } from './index.ts';
const launch = (args: string[]): ChildProcess => {
    const env = Object.fromEntries(Object.entries({ PATH: '/usr/bin:/bin', HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK })
      .filter((row): row is [string,string] => typeof row[1] === 'string'));
    return spawn('/usr/bin/ssh', args, { env, stdio: ['ignore','pipe','pipe'] });
};

// Internal testing seam; production always uses the pinned SSH executable and 20-second bound.
export async function runSshProcess(args: string[], signal: AbortSignal, start = launch, timeoutMs = 20000): Promise<QueryResult> {
  if (signal.aborted) return { code: null, stdout: '', failure: 'cancelled' };
  return new Promise<QueryResult>(resolve => {
    const child = start(args);
    let bytes = 0, output: Buffer[] = [], failure: QueryResult['failure'];
    const stop = (reason: NonNullable<QueryResult['failure']>) => { failure ??= reason; output = []; child.kill('SIGKILL'); };
    const abort = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timeout'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const receive = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) stop('output_limit');
      else if (stdout && !failure) output.push(chunk);
    };
    child.stdout!.on('data', chunk => receive(chunk, true)); child.stderr!.on('data', chunk => receive(chunk, false));
    child.once('error', () => { failure ??= 'ssh_failed'; });
    child.once('close', code => {
      clearTimeout(timeout); signal.removeEventListener('abort', abort);
      resolve({ code, stdout: failure ? '' : Buffer.concat(output).toString('utf8'), ...(failure ? { failure } : {}) });
    });
  });
}
