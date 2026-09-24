import { useEffect, useRef, useState } from 'react';
import { RiDraggable, RiInbox2Line, RiNotification3Line, RiErrorWarningLine } from '@remixicon/react';
import { navigate, useConnected } from '../api.ts';
import type { SurfaceState } from '../types.ts';
import { BusyDots, cx, OwnerIcon } from './ui.tsx';

/** The owners down the left, each with what waits on the person and whether it is working. */
export function Rail({ state, route, onReorder }: { state?: SurfaceState; route: string[]; onReorder: (order: string[]) => void }) {
  const connected = useConnected();
  // Re-ordering with pointer events rather than HTML5 drag and drop: it behaves the same everywhere and needs no
  // drag image. A press becomes a drag after a few pixels; the click that ends a drag is swallowed.
  const [notifications, setNotifications] = useState(() => (typeof Notification === 'undefined' ? 'denied' : Notification.permission));
  const [dragging, setDragging] = useState<string>();
  const [over, setOver] = useState<{ id: string; after: boolean }>();
  const press = useRef<{ id: string; y: number; moved: boolean }>(undefined);
  const suppressClick = useRef(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const targetAt = (y: number) => {
    for (const [id, element] of rows.current) {
      const box = element.getBoundingClientRect();
      if (y >= box.top && y <= box.bottom) return { id, after: y > box.top + box.height / 2 };
    }
    return undefined;
  };
  const onPointerDown = (id: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    press.current = { id, y: event.clientY, moved: false };
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = press.current;
      if (!current) return;
      if (!current.moved && Math.abs(event.clientY - current.y) < 5) return;
      current.moved = true;
      setDragging(current.id);
      setOver(targetAt(event.clientY));
    };
    const up = (event: PointerEvent) => {
      const current = press.current;
      press.current = undefined;
      if (!current?.moved) return;
      suppressClick.current = true;
      const target = targetAt(event.clientY);
      setDragging(undefined);
      setOver(undefined);
      if (!state || !target || target.id === current.id) return;
      const ids = state.owners.map(owner => owner.id).filter(id => id !== current.id);
      const index = ids.indexOf(target.id);
      ids.splice(target.after ? index + 1 : index, 0, current.id);
      onReorder(ids);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  }, [state, onReorder]);

  const active = route[0] === 'owner' ? route[1] : undefined;
  const inboxActive = route.length === 0 || route[0] === 'inbox';
  return (
    <nav className="w-60 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
      <div className="px-4 h-12 flex items-center gap-2 border-b border-border">
        <span className="typography-ui-header font-semibold">onionsoup</span>
        <span title={connected ? 'live' : 'reconnecting'} className={cx('ml-auto size-2 rounded-full', connected ? 'bg-status-success' : 'bg-status-warning animate-pulse')} />
      </div>
      <div className="p-2 flex flex-col gap-0.5 overflow-y-auto flex-1 min-h-0">
        <button onClick={() => navigate('inbox')}
          className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 typography-ui-label', inboxActive ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <RiInbox2Line className="size-4" />Inbox
          {!!state?.inbox.length && <span className="ml-auto rounded-full bg-primary text-primary-foreground px-1.5 typography-micro font-semibold">{state.inbox.length}</span>}
        </button>
        <button onClick={() => navigate('friction')}
          className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 typography-ui-label', route[0] === 'friction' ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <RiErrorWarningLine className="size-4" />Friction
          {!!state?.frictionCount && <span className="ml-auto rounded-full bg-primary text-primary-foreground px-1.5 typography-micro font-semibold">{state.frictionCount}</span>}
        </button>
        <div className="mt-3 mb-1 px-2 typography-micro uppercase tracking-wide text-muted-foreground text-[0.68rem]">Owners</div>
        {state?.owners.map(owner => (
          <button key={owner.id} onClick={() => navigate('owner', owner.id)} title={`${owner.title}\n${owner.domain}\n(drag to re-order)`}
            ref={element => { if (element) rows.current.set(owner.id, element); else rows.current.delete(owner.id); }}
            onPointerDown={onPointerDown(owner.id)}
            onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.stopPropagation(); event.preventDefault(); } }}
            className={cx('group/owner relative flex items-center gap-2 rounded-md px-2 py-1.5 text-left select-none touch-none', active === owner.id ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
              dragging === owner.id && 'opacity-40',
              over?.id === owner.id && dragging !== owner.id && (over.after ? 'shadow-[inset_0_-2px_0_var(--primary)]' : 'shadow-[inset_0_2px_0_var(--primary)]'))}>
            <RiDraggable className="absolute -left-1 size-3.5 opacity-0 group-hover/owner:opacity-40" />
            <OwnerIcon icon={owner.icon} />
            <span className="flex flex-col min-w-0 flex-1">
              <span className="typography-ui-label truncate">{owner.name}</span>
              <span className="typography-micro text-muted-foreground truncate text-[0.7rem]">{owner.title || owner.domain}</span>
            </span>
            {owner.running > 0 && <BusyDots className="text-status-info" />}
            {owner.waiting > 0 && <span className="rounded-full bg-primary text-primary-foreground px-1.5 typography-micro font-semibold">{owner.waiting}</span>}
          </button>
        ))}
      </div>
      <div className="mt-auto border-t border-border p-2 flex flex-col gap-1">
        {typeof Notification !== 'undefined' && notifications !== 'granted' && (
          <button className="flex items-center gap-2 rounded-md px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={() => void Notification.requestPermission().then(setNotifications)}>
            <RiNotification3Line className="size-3.5" />{notifications === 'denied' ? 'Notifications blocked by the browser' : 'Notify me when something waits'}
          </button>
        )}
        <div className="px-2 typography-micro text-muted-foreground/60 text-[0.68rem]">Alt+↑↓ owners · Alt+I inbox · / message</div>
      </div>
    </nav>
  );
}
