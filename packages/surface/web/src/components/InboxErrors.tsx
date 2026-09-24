import type { InboxReadError } from '../../../src/inbox-errors.ts';

const DESCRIPTIONS: Record<InboxReadError['code'], string> = {
  chat_directory_failed: 'The chat directory could not be opened.',
  permission_list_failed: 'Pending permissions could not be loaded.',
  question_list_failed: 'Pending questions could not be loaded.',
};

const ALERT_STYLE = 'shrink-0 px-4 py-2 typography-meta border-b border-[var(--status-error-border)] '
  + 'bg-[var(--status-error-background)] text-[var(--status-error)]';

export function InboxErrors({ errors, refreshError }: { errors: InboxReadError[]; refreshError?: string }) {
  if (!errors.length && !refreshError) return null;
  return <div role="alert" className={ALERT_STYLE}>
    {refreshError && <div>
      Inbox refresh failed: {refreshError}. Pending approvals may be missing; displayed items may be stale.
    </div>}
    {errors.map(error => <div key={`${error.owner}:${error.code}`}>
      {error.owner}: {DESCRIPTIONS[error.code]} Approvals may be missing. ({error.code})
    </div>)}
  </div>;
}
