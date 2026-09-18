import { escapeHtml as esc } from './batch-report.ts';
import { locationFilename } from './location-workflow.ts';
import type { LocationRun } from './location-agent.ts';

export function locationHtml(run?: LocationRun) {
  if (!run) return '';
  const base = `https://github.com/${run.input.repository.name}/blob/${run.input.repository.commit}`;
  const brief = run.brief;
  const pointers = (items: NonNullable<typeof brief>['codePointers']) => items.map(c => {
    const url = `${base}/${c.path.split('/').map(encodeURIComponent).join('/')}#L${c.startLine}-L${c.endLine}`;
    return `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(c.path)}:${c.startLine}–${c.endLine}</a>${c.symbol ? ` · <code>${esc(c.symbol)}</code>` : ''}
      <p>${esc(c.reason)}</p><details><summary>Quoted source</summary><pre>${esc(c.quote)}</pre></details></li>`;
  }).join('');
  return `<section class="location-brief"><h3>Investigation starting points</h3>
    <p class="meta">${esc(run.model)} · pinned commit <code>${esc(run.input.repository.commit.slice(0, 12))}</code> · ${run.source.calls} source inspections</p>
    ${brief ? `<p>${esc(brief.summary)}</p>
      ${brief.codePointers.length ? `<h4>Code to read</h4><ul>${pointers(brief.codePointers)}</ul>` : '<p>No code location established within the search bounds.</p>'}
      ${brief.testPointers.length ? `<h4>Related tests</h4><ul>${pointers(brief.testPointers)}</ul>` : '<p>No relevant test located within the bounded search.</p>'}
      <h4>Uncertainties</h4><ul>${brief.uncertainties.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` :
      `<p>${run.status === 'running' ? 'Location run is unfinished; its outcome is unknown.' : `No accepted brief: ${esc(run.failure)}.`}</p>`}
    <p class="meta">Reading suggestions, not a diagnosis. Citations refer to the pinned commit, which may differ from the affected release. No repository code or tests were executed.</p>
    <details><summary>Handoff and run details</summary><pre>${esc(JSON.stringify({ runId: run.runId, parentRunId: run.input.parent.runId,
      issueHash: run.input.parent.inputHash, repositoryCommit: run.input.repository.commit, promptVersion: run.promptVersion,
      runtimeHash: run.runtimeHash, status: run.status, steps: run.events.filter(e => e.type === 'stepStart').length,
      usage: run.tokenUsage?.totals ?? null }, null, 2))}</pre>
      <a href="locations/${esc(locationFilename(run))}">Original code-location record</a></details></section>`;
}
