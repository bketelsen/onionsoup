import { RiCpuLine } from '@remixicon/react';
import type { OwnerSummary } from '../types.ts';
import { cx } from './ui.tsx';

/**
 * The work an owner's host code is running right now, under its rail entry: a rebase or repair whose hires run on
 * sandboxed servers, so none of its sessions show among the owner's chats. Each row opens the item's page.
 */
export function RuntimeWorkRows({ owner, activeItem }: { owner: OwnerSummary; activeItem?: string }) {
  return (
    <>
      {owner.runtimeWork.map(work => (
        <a key={work.id} href={`#/item/${work.id}`} title={`${work.title}\n${work.id} · ${work.status} (runtime work)`} data-runtime-work={work.id}
          className={cx('ml-6 flex items-center gap-1.5 rounded-md px-2 py-1 typography-micro text-[0.7rem]',
            activeItem === work.id ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <RiCpuLine className="size-3 shrink-0 text-status-info" aria-label="runtime work" />
          <span className="truncate">{work.title}</span>
        </a>
      ))}
    </>
  );
}
