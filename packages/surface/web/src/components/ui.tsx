import type { ReactNode } from 'react';
import {
  RiArchiveLine, RiBookLine, RiBriefcaseLine, RiCameraLine, RiCodeLine, RiDatabase2Line, RiFlaskLine, RiGamepadLine, RiGlobalLine,
  RiHeartLine, RiHome4Line, RiLeafLine, RiLightbulbLine, RiMusic2Line, RiPaletteLine, RiPhoneLine, RiRocketLine, RiServerLine,
  RiShieldLine, RiTerminalBoxLine,
} from '@remixicon/react';

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground border border-border hover:bg-interactive-hover',
  ghost: 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover',
  destructive: 'text-status-error border border-status-error/40 hover:bg-status-error/10',
};

export function Button({ children, variant = 'secondary', onClick, disabled, title, type = 'button', className }: {
  children: ReactNode; variant?: keyof typeof VARIANTS; onClick?: () => void; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string;
}) {
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={cx('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 typography-ui-label font-medium transition-colors', VARIANTS[variant], className)}>
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'primary' | 'success' | 'error' | 'warning' | 'info' }) {
  const tones = {
    muted: 'bg-muted text-muted-foreground',
    primary: 'bg-primary/15 text-primary',
    success: 'bg-status-success/15 text-status-success',
    error: 'bg-status-error/15 text-status-error',
    warning: 'bg-status-warning/15 text-status-warning',
    info: 'bg-status-info/15 text-status-info',
  };
  return <span className={cx('inline-flex items-center rounded-full px-1.5 py-px typography-micro font-medium', tones[tone])}>{children}</span>;
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="typography-ui-label font-semibold text-muted-foreground uppercase tracking-wide text-[0.7rem]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="typography-meta text-muted-foreground italic">{children}</div>;
}

/** Three pulsing dots, for anything running. */
export function BusyDots({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-0.5', className)} aria-label="working">
      {[0, 1, 2].map(index => <span key={index} className="size-1 rounded-full bg-current animate-pulse" style={{ animationDelay: `${index * 180}ms` }} />)}
    </span>
  );
}

const ICONS: Record<string, typeof RiCodeLine> = {
  code: RiCodeLine, terminal: RiTerminalBoxLine, rocket: RiRocketLine, flask: RiFlaskLine, gamepad: RiGamepadLine, briefcase: RiBriefcaseLine,
  home: RiHome4Line, globe: RiGlobalLine, leaf: RiLeafLine, shield: RiShieldLine, palette: RiPaletteLine, server: RiServerLine,
  phone: RiPhoneLine, database: RiDatabase2Line, lightbulb: RiLightbulbLine, music: RiMusic2Line, camera: RiCameraLine, book: RiBookLine,
  heart: RiHeartLine, archive: RiArchiveLine,
};

export function OwnerIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? RiBriefcaseLine;
  return <Icon className={cx('size-4 shrink-0', className)} />;
}

export function timeAgo(value: string | number | undefined) {
  if (value === undefined) return '';
  const then = typeof value === 'number' ? value : Date.parse(value);
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function statusTone(status: string): 'muted' | 'primary' | 'success' | 'error' | 'warning' | 'info' {
  if (status === 'landed') return 'success';
  if (status === 'failed' || status === 'rejected') return 'error';
  if (status.startsWith('awaiting')) return 'warning';
  if (['planning', 'working', 'implementing', 'reviewing', 'landing'].includes(status)) return 'info';
  return 'muted';
}
