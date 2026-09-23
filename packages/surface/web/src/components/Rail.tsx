import { RiInbox2Line } from '@remixicon/react';
import { navigate, useConnected } from '../api.ts';
import type { SurfaceState } from '../types.ts';
import { BusyDots, cx, OwnerIcon } from './ui.tsx';

/** The owners down the left, each with what waits on the person and whether it is working. */
export function Rail({ state, route }: { state?: SurfaceState; route: string[] }) {
  const connected = useConnected();
  const active = route[0] === 'owner' ? route[1] : undefined;
  const inboxActive = route.length === 0 || route[0] === 'inbox';
  return (
    <nav className="w-60 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
      <div className="px-4 h-12 flex items-center gap-2 border-b border-border">
        <span className="typography-ui-header font-semibold">onionsoup</span>
        <span title={connected ? 'live' : 'reconnecting'} className={cx('ml-auto size-2 rounded-full', connected ? 'bg-status-success' : 'bg-status-warning animate-pulse')} />
      </div>
      <div className="p-2 flex flex-col gap-0.5 overflow-y-auto">
        <button onClick={() => navigate('inbox')}
          className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 typography-ui-label', inboxActive ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <RiInbox2Line className="size-4" />Inbox
          {!!state?.inbox.length && <span className="ml-auto rounded-full bg-primary text-primary-foreground px-1.5 typography-micro font-semibold">{state.inbox.length}</span>}
        </button>
        <div className="mt-3 mb-1 px-2 typography-micro uppercase tracking-wide text-muted-foreground text-[0.68rem]">Owners</div>
        {state?.owners.map(owner => (
          <button key={owner.id} onClick={() => navigate('owner', owner.id)} title={`${owner.title}\n${owner.domain}`}
            className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-left', active === owner.id ? 'bg-interactive-active text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
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
    </nav>
  );
}
