import { readFile } from 'node:fs/promises';

/**
 * Read a sibling definition file for hashing. Source runs see `.ts`; the compiled release ships `.js`,
 * so a `.ts` name falls back to its compiled neighbour. Hashes therefore differ between source and
 * compiled runs, but stay stable within one process, which is what acceptance and execution compare.
 */
export async function definitionText(base: string | URL, name: string): Promise<string> {
  try {
    return await readFile(new URL(name, base), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !name.endsWith('.ts')) throw error;
    return readFile(new URL(name.replace(/\.ts$/, '.js'), base), 'utf8');
  }
}
