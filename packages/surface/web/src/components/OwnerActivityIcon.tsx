import type { OwnerActivity, OwnerSummary } from '../types.ts';
import { cx, OwnerIcon } from './ui.tsx';

/** How each activity tints the rail icon, and what it says to a screen reader or on hover. */
const ACTIVITY_LOOK: Record<OwnerActivity, { className: string; label?: string }> = {
  working: { className: 'text-primary animate-pulse', label: 'working' },
  waiting: { className: 'text-status-warning', label: 'waiting on you' },
  idle: { className: '' },
};

/** An owner's (or the operator's) rail icon, tinted by what its chats are doing. */
export function OwnerActivityIcon({ owner }: { owner: OwnerSummary }) {
  const look = ACTIVITY_LOOK[owner.activity] ?? ACTIVITY_LOOK.idle;
  return (
    <span className={cx('inline-flex shrink-0', look.className)} data-activity={owner.activity}
      role={look.label ? 'img' : undefined} aria-label={look.label} title={look.label}>
      <OwnerIcon icon={owner.icon} />
    </span>
  );
}
