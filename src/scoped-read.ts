import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** Read a file that must stay inside a configured artifact root. */
export async function scopedRead(root: string, file: string) {
  const base = await realpath(root);
  const target = await realpath(join(base, file));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Artifact escaped its configured root');
  const bytes = await readFile(target);
  if (bytes.length > 30 * 1024 * 1024) throw new Error('Artifact too large');
  return bytes;
}
export const scopedJson = async (root: string, file: string): Promise<unknown> => JSON.parse((await scopedRead(root, file)).toString('utf8'));
