import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRepositoryOwner } from './declarations.ts';
import type { Runtime } from './runtime.ts';
import { ensureDesk } from './workspace.ts';

/**
 * Where an owner's chats run: a repository owner's desk worktree (a group owner's folder of them), otherwise the
 * folder its read-only snapshot lives in. Creates it if needed, so a new owner's desk appears when its chat is
 * first opened.
 */
export async function chatDirectory(runtime: Runtime, ownerId: string) {
  const owner = runtime.owner(ownerId);
  for (const view of runtime.repositoryViews(owner.id)) if (owner.domain.kind === 'repository-group') await ensureDesk(view, runtime.desksRoot);
  const path = isRepositoryOwner(owner) ? (await ensureDesk(owner, runtime.desksRoot)).path
    : owner.domain.kind === 'repository-group' ? join(runtime.desksRoot, owner.id) : runtime.evidenceDirectory(owner.id);
  await mkdir(path, { recursive: true });
  return path;
}
