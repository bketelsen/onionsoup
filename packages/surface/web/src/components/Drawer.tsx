import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { RiMenuLine } from '@remixicon/react';
import { cx } from './ui.tsx';

// Below the lg breakpoint (phones, portrait and landscape, and small tablets) the rail and the side panels leave the
// page and become drawers over it: the page keeps the whole width. From lg up they sit beside the page as before.

export type DrawerSide = 'left' | 'right';

/** Where a drawer slides in from, what hides it, and which safe areas its edge has to clear. The panel draws its own border. */
const SIDES: Record<DrawerSide, { edge: string; hidden: string }> = {
  left: {
    edge: 'left-0 max-lg:pl-[env(safe-area-inset-left)]',
    hidden: '-translate-x-full',
  },
  right: {
    edge: 'right-0 max-lg:pr-[env(safe-area-inset-right)]',
    hidden: 'translate-x-full',
  },
};

const NARROW = 'fixed inset-y-0 z-40 max-w-[90vw] bg-background shadow-xl max-lg:pt-[env(safe-area-inset-top)] max-lg:pb-[env(safe-area-inset-bottom)] '
  + 'transition-[transform,visibility] duration-200 ease-out';
const WIDE = 'lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:visible lg:shadow-none lg:transition-none';

export interface DrawerProps {
  side: DrawerSide;
  isOpen: boolean;
  onClose: () => void;
  label: string;
  /** The panel's width and inner layout, at every size; the drawer's shell only positions it. */
  className?: string;
  children: ReactNode;
}

/** A panel beside the page on wide screens, a drawer over it on narrow ones, closed by its backdrop or Escape. */
export function Drawer({ side, isOpen, onClose, label, className, children }: DrawerProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);
  const { edge, hidden } = SIDES[side];
  return (
    <>
      {isOpen && <div data-drawer-backdrop aria-hidden className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} />}
      <div data-drawer={side} data-open={isOpen} role="region" aria-label={label}
        className={cx('flex flex-col shrink-0 min-h-0', NARROW, edge, WIDE, !isOpen && cx(hidden, 'invisible'))}>
        <div className={cx('flex-1 min-h-0', className)}>{children}</div>
      </div>
    </>
  );
}

// Whether the rail's drawer is open: one for the whole app, so any page's bar can open it.
let railOpen = false;
const railListeners = new Set<() => void>();

export function setRailOpen(isOpen: boolean) {
  if (railOpen === isOpen) return;
  railOpen = isOpen;
  for (const listener of railListeners) listener();
}

export function useRailOpen() {
  return useSyncExternalStore(listener => {
    railListeners.add(listener);
    return () => { railListeners.delete(listener); };
  }, () => railOpen, () => false);
}

/** Opens the rail on narrow screens; hidden where the rail is always shown. */
export function MenuButton() {
  return (
    <button type="button" aria-label="Open navigation" onClick={() => setRailOpen(true)}
      className="lg:hidden -ml-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
      <RiMenuLine className="size-5" />
    </button>
  );
}

export interface MobileBarProps {
  title: string;
  /** Buttons at the right end, such as one opening the page's side panel. */
  actions?: ReactNode;
}

/** The top bar of a page on narrow screens: the rail's menu button, the page's name and its actions. */
export function MobileBar({ title, actions }: MobileBarProps) {
  return (
    <header className="lg:hidden h-12 shrink-0 border-b border-border px-3 flex items-center gap-2 min-w-0">
      <MenuButton />
      <span className="typography-ui-header font-semibold truncate">{title}</span>
      {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
    </header>
  );
}
