/** Relative-time buckets, largest first: the unit, how many milliseconds it spans, and its suffix. */
const UNITS: [number, string][] = [
  [86400000 * 365, 'y'],
  [86400000 * 30, 'mo'],
  [86400000 * 7, 'w'],
  [86400000, 'd'],
  [3600000, 'h'],
  [60000, 'm'],
];

/** "5m ago", "3d ago", or "just now". `now` is passed in so callers re-render on the store clock. */
export function ago(iso: string, now: number) {
  const elapsed = now - Date.parse(iso);
  const unit = UNITS.find(([size]) => elapsed >= size);
  return unit ? `${Math.floor(elapsed / unit[0])}${unit[1]} ago` : 'just now';
}

export const stamp = (iso: string) => new Date(iso).toLocaleString();

/** "34s", "2m 10s", "1h 5m". */
export function duration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`;
}

/** A schema key as a label: `proposalJobId` → "Proposal job", `allowedFiles` → "Allowed files". */
export function humanize(key: string) {
  const words = key.replace(/Id$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const shortId = (id: string) => id.slice(0, 8);
export const shortCommit = (commit: string) => commit.slice(0, 10);
