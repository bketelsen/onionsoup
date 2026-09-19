import { isDeepStrictEqual } from 'node:util';
import { Snapshot, CollectionKey, hash, contextText, type Evidence, type Item, type BriefRequest } from './contracts.ts';
import { collectionQuery, matchesCollection } from './collect.ts';
export function validateSnapshot(raw: unknown): Snapshot {
  const s = Snapshot.parse(raw);
  if (new Set(s.collections.map(c => c.key)).size !== 7) throw new Error('Invalid collections');
  for (const c of s.collections) {
    if (c.query !== collectionQuery(s.request,c.key) || new Set(c.items.map(i => i.id)).size !== c.items.length ||
        c.items.some(i => i.id !== `${i.kind}:${i.number}` || !matchesCollection(i,c.key,s.request)) ||
        c.status === 'unavailable' && (c.total !== null || c.items.length || !c.incomplete || !c.failure) ||
        c.status === 'available' && (c.total === null || c.total < c.items.length || c.failure)) throw new Error('Invalid collection evidence');
  }
  if (s.ci.status === 'unavailable' && (s.ci.total !== null || s.ci.runs.length) ||
      s.ci.status === 'available' && (s.ci.total === null || s.ci.total < s.ci.runs.length || !s.defaultBranch) ||
      new Set(s.ci.runs.map(r => r.id)).size !== s.ci.runs.length || s.ci.runs.some(r => r.branch !== s.defaultBranch ||
        Date.parse(r.createdAt) < Date.parse(s.request.since) || Date.parse(r.createdAt) >= Date.parse(s.request.until))) throw new Error('Invalid CI evidence');
  const candidates = [...new Set(s.collections.find(c => c.key === 'createdPRs')!.items.filter(i => !i.bot && i.author).map(i => i.author!))].sort();
  if (!isDeepStrictEqual(candidates, s.contributors.candidates) || !isDeepStrictEqual(s.contributors.checks.map(c => c.author), candidates.slice(0,10)))
    throw new Error('Invalid contributor evidence');
  for (const c of s.contributors.checks) {
    if (c.outcome === 'unknown' ? c.firstPR !== undefined || c.firstCreatedAt !== undefined :
        !c.firstPR || !c.firstCreatedAt || Date.parse(c.firstCreatedAt) >= Date.parse(s.request.until) ||
        (c.outcome === 'new') !== (Date.parse(c.firstCreatedAt!) >= Date.parse(s.request.since))) throw new Error('Invalid contributor history');
  }
  return s;
}
export const collectionLabels: Record<CollectionKey,string> = {
  openIssues: 'Open issues at collection', openPRs: 'Open PRs at collection', createdIssues: 'Issues created in window',
  closedIssues: 'Currently closed issues with closure in window', createdPRs: 'PRs created in window',
  mergedPRs: 'PRs merged in window', closedUnmergedPRs: 'Currently closed, unmerged PRs with closure in window',
};
export function repositoryMetrics(raw: unknown) {
  const s = validateSnapshot(raw);
  const counts = s.collections.map(c => ({ key: c.key, label: collectionLabels[c.key], total: c.total,
    totalReliable: c.status === 'available' && !c.incomplete && c.rejected === 0, sampled: c.items.length,
    complete: c.status === 'available' && !c.incomplete && c.rejected === 0 && c.items.length === c.total, rejected: c.rejected }));
  const concluded = s.ci.runs.filter(r => r.status === 'completed');
  const passed = concluded.filter(r => r.conclusion === 'success').length;
  const failed = concluded.filter(r => ['failure','timed_out','action_required','startup_failure'].includes(r.conclusion ?? '')).length;
  const contributors = { verifiedNew: s.contributors.checks.filter(c => c.outcome === 'new').map(c => c.author),
    candidates: s.contributors.candidates.length, checked: s.contributors.checks.length,
    unknown: s.contributors.candidates.length - s.contributors.checks.filter(c => c.outcome !== 'unknown').length,
    complete: counts.find(c => c.key === 'createdPRs')!.complete && s.contributors.checks.length === s.contributors.candidates.length && s.contributors.checks.every(c => c.outcome !== 'unknown') };
  const ci = { available: s.ci.status === 'available', sampled: s.ci.runs.length, reportedTotal: s.ci.total,
    complete: s.ci.status === 'available' && s.ci.rejected === 0 && s.ci.runs.length === s.ci.total,
    passed, failed, denominator: passed + failed, successRate: passed + failed ? passed / (passed + failed) : null,
    excluded: s.ci.runs.length - passed - failed };
  const evidence: Evidence[] = counts.map(c => ({ id: `metric:${c.key}`, statement:
    `${c.label}: ${c.totalReliable ? c.total : 'unknown (API unavailable or incomplete)'}. Inspected ${c.sampled} items; ${c.complete ? 'complete membership' : 'partial/unavailable membership'}; rejected ${c.rejected}.` }));
  evidence.push({ id: 'metric:ci', statement: `Default-branch GitHub Actions runs created in window; latest observed attempts. ${ci.available ? `Sample ${ci.sampled}/${ci.reportedTotal}; ${ci.passed} successful, ${ci.failed} failed; ${ci.excluded} excluded from denominator; success rate ${ci.successRate === null ? 'unknown' : (100 * ci.successRate).toFixed(1) + '%'}. ${ci.complete ? 'Complete' : 'Partial'} sample.` : 'Unavailable; no rate established.'}` },
    { id: 'metric:contributors', statement: `First-time PR authors (not all contributors): ${contributors.verifiedNew.length} verified new among ${contributors.checked}/${contributors.candidates} inspected non-bot author candidates. ${contributors.unknown} unknown/unchecked. ${contributors.complete ? 'Complete within searched PR population' : 'Partial population/history'}.` },
    { id: 'scope:window', statement: `Activity window [${s.request.since}, ${s.request.until}); backlog is current at collection ${s.startedAt} to ${s.finishedAt}, not historical as-of window end.` },
    { id: 'scope:limitations', statement: 'GitHub search counts reflect its index, not an atomic snapshot. No previous-period baseline; do not claim improvement or deterioration. CI includes GitHub Actions only; no job logs or external CI. Title/label themes are hypotheses, not diff review or bug diagnosis.' });
  return { counts, ci, contributors, evidence };
}
export function themeInput(s: Snapshot, collection: 'issues' | 'prs') {
  const items = s.collections.find(c => c.key === (collection === 'issues' ? 'openIssues' : 'openPRs'))!.items.slice(0,30);
  return { schemaVersion: 1 as const, snapshotHash: hash(s), repository: s.request.repository, collection,
    items: items.map(({ id, title, labels }) => ({ id, title: contextText(title), labels: labels.map(contextText) })) };
}
export function itemEvidence(s: Snapshot): Evidence[] {
  return ['issues','prs'].flatMap(kind => themeInput(s,kind as 'issues'|'prs').items.map(i => ({ id: i.id,
    statement: `${i.id} open at capture; title: ${i.title}; labels: ${i.labels.join(', ') || '(none)'}. Title/labels only; no readiness, diff, review or merge-safety judgment established.` })));
}
