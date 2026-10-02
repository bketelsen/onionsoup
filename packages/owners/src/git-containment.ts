import { git } from './workspace.ts';

/** Squash containment: merging the source into the base must leave the base tree unchanged. */
export async function isCommitContainedInBase(directory: string, base: string, source = 'HEAD') {
  const baseTree = (await git(directory, ['rev-parse', `${base}^{tree}`])).trim();
  const merged = await git(directory, ['merge-tree', '--write-tree', base, source]).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  });
  return merged?.split('\n')[0]?.trim() === baseTree;
}
