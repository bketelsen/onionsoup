import type { ProviderHealthView } from '../types.ts';
import { timeAgo } from './ui.tsx';

/** On a phone a banner keeps to a few lines and scrolls, so the page under it stays usable. */
const NARROW_CAP = 'max-lg:max-h-32 max-lg:overflow-y-auto ';
const ERROR_STYLE = NARROW_CAP + 'shrink-0 px-4 py-2 typography-meta border-b border-[var(--status-error-border)] '
  + 'bg-[var(--status-error-background)] text-[var(--status-error)]';
const RECOVERED_STYLE = NARROW_CAP + 'shrink-0 px-4 py-2 typography-meta border-b border-[var(--status-success-border)] '
  + 'bg-[var(--status-success-background)] text-[var(--status-success)]';

function affectedKinds(view: ProviderHealthView) {
  return [...new Set(view.affected.map(use => use.kind))].join(', ') || 'none recorded';
}

function FailingProvider({ view }: { view: ProviderHealthView }) {
  const plural = view.failures === 1 ? '' : 's';
  return <div data-provider={view.provider}>
    <strong>{view.name} authentication failing</strong>: first failure {timeAgo(view.since)}, {view.failures} failure{plural}
    {' '}(affected: {affectedKinds(view)}). {view.fix}
  </div>;
}

function RecoveredProvider({ view }: { view: ProviderHealthView }) {
  return <div data-provider={view.provider}>
    <strong>{view.name} authentication recovered</strong>{view.recoveredAt && <> {timeAgo(view.recoveredAt)}</>}.
  </div>;
}

/**
 * Across every page while a model provider refuses onionsoup's credentials: nothing on it works until the person
 * fixes them. A provider that recovered stays a little while, in green, to confirm the fix took.
 */
export function ProviderHealthBanner({ providerHealth }: { providerHealth: ProviderHealthView[] }) {
  const failing = providerHealth.filter(view => view.status === 'failing');
  const recovered = providerHealth.filter(view => view.status === 'ok');
  return <>
    {failing.length > 0 && <div role="alert" className={ERROR_STYLE}>
      {failing.map(view => <FailingProvider key={view.provider} view={view} />)}
    </div>}
    {recovered.length > 0 && <div role="status" className={RECOVERED_STYLE}>
      {recovered.map(view => <RecoveredProvider key={view.provider} view={view} />)}
    </div>}
  </>;
}
