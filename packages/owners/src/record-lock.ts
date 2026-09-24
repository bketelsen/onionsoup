import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A kernel lock shared by CLI, daemon and surface; a stopped process releases it automatically. */
export async function withRecordLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const holder = spawn('flock', ['--exclusive', path, 'sh', '-c', 'printf ready; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>(resolve => holder.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.once('data', () => resolve());
    holder.once('exit', code => reject(new Error(`record_lock_failed: ${code}`)));
  });
  try {
    return await operation();
  } finally {
    holder.stdin.end();
    await exited;
  }
}
