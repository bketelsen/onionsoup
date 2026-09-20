import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
export type QueryResult = { code: number | null; stdout: string; failure?: 'ssh_failed'|'timeout'|'cancelled'|'output_limit' };
export const SshTarget = z.object({ host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/), user: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/), port: z.number().int().min(1).max(65535).default(22) });
const launch = (args: string[]): ChildProcess => {
    const env = Object.fromEntries(Object.entries({ PATH: '/usr/bin:/bin', HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK })
      .filter((row): row is [string,string] => typeof row[1] === 'string'));
    return spawn('/usr/bin/ssh', args, { env, stdio: ['ignore','pipe','pipe'] });
};

// Test seam; source adapters use the pinned SSH executable and 20-second default bound.
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

// Host-only primitive. Callers must supply a reviewed fixed command, never model/browser text.
export function boundedSshArguments(raw: unknown, command: string) {
  const target = SshTarget.parse(raw);
  return ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'LogLevel=ERROR',
    '-p', String(target.port), '-l', target.user, '--', target.host, command];
}
