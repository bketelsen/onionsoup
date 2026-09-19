import { validateRepositoryBrief, actionEvidence } from './record.ts';
import { repositoryMetrics, themeInput } from '@onionsoup/repository-analysis/metrics';
import { ThemeResult, HealthResult, ActionsResult } from '@onionsoup/repository-analysis/contracts';
import { text } from '@onionsoup/runtime/text';
export function repositoryBriefMarkdown(raw: unknown) {
  const b = validateRepositoryBrief(raw), s = b.snapshot;
  const lines = [`# Repository brief: ${text(b.request.repository)}`, '',
    `Status: **${b.status === 'running' ? 'unfinished — outcome unknown' : b.status}** · Agent attempts: ${b.budget.consumed}/4`, '',
    `Activity window: **[${b.request.since}, ${b.request.until})**`, '',
    `Workflow: ${b.workflowId} · ${b.execution.provider} / ${text(b.execution.model)}`, '',
    '[Saved evidence and agent records](repository-brief.json) · [Common trace](events.json)', '',
    'Open counts are current at collection; activity counts refer to the window. GitHub search is indexed and non-atomic. Theme summaries use sampled titles and labels only; comments, issue bodies, PR diffs, review state and merge safety were not inspected.', ''];
  if (b.failure) lines.push(`Workflow failure: **${b.failure}**.`, '');
  if (!s) return lines.concat('Collection has no saved outcome.','').join('\n');
  const m = repositoryMetrics(s);
  lines.push(`Collected: ${s.startedAt} to ${s.finishedAt} · Read-only API requests: ${s.requestsUsed}/20`, '',
    '## Counts and coverage', '', '| Metric | GitHub-reported total | Inspected membership |', '| --- | --- | --- |');
  for (const c of m.counts) lines.push(`| ${c.label} | ${c.totalReliable ? c.total : 'unknown'} | ${c.sampled}; ${c.complete ? 'complete' : 'partial/unavailable'}${c.rejected ? `; ${c.rejected} rejected` : ''} |`);
  lines.push('', 'Closures count currently closed items whose latest closure is in the window; reopen/close event throughput is not measured. Merged and closed-unmerged PRs are separate.', '',
    '## CI and contributors', '',
    `GitHub Actions branch: **${text(s.defaultBranch ?? 'unknown')}**. Latest observed attempts of runs created in the window.`, '',
    m.ci.available ? `Sample: ${m.ci.sampled}/${m.ci.reportedTotal} runs (${m.ci.complete ? 'complete' : 'partial'}). Successful: ${m.ci.passed}; failed: ${m.ci.failed}; excluded from rate: ${m.ci.excluded}. Success rate: **${m.ci.successRate === null ? 'unknown (no eligible completed runs)' : (100*m.ci.successRate).toFixed(1)+'%'}** (${m.ci.passed}/${m.ci.denominator}).`
      : 'CI data unavailable; no success rate established.', '',
    'The denominator includes success, failure, timed_out, action_required and startup_failure conclusions on completed runs. Pending, cancelled, skipped, neutral and unknown conclusions are excluded. External CI and job logs are not covered.', '',
    `Verified first-time PR authors: **${m.contributors.verifiedNew.length}** among ${m.contributors.checked}/${m.contributors.candidates} sampled non-bot candidates; ${m.contributors.unknown} unknown/unchecked. Population/history: **${m.contributors.complete ? 'complete' : 'partial'}**. This does not count every form of contribution.`, '');
  lines.push('### Failed CI runs in the sample', '', 'Links below come from saved run metadata. The health and action agents received aggregate CI counts, without these run details or logs.', '');
  for (const r of s.ci.runs.filter(r => r.status === 'completed' && ['failure','timed_out','action_required','startup_failure'].includes(r.conclusion ?? '')))
    lines.push(`- [${text(r.name)} — run ${r.id}, attempt ${r.attempt}](https://github.com/${b.request.repository}/actions/runs/${r.id}) · ${text(r.conclusion!)}`);
  lines.push('');
  for (const c of s.contributors.checks.filter(c => c.outcome === 'new')) lines.push(`- ${text(c.author)} — [first PR #${c.firstPR}](https://github.com/${b.request.repository}/pull/${c.firstPR}), created ${c.firstCreatedAt}`);
  for (const stage of b.stages) {
    lines.push('', `## ${stage.key === 'issue_themes' ? 'Issue themes' : stage.key === 'pr_themes' ? 'Pull request themes' : stage.key === 'health' ? 'Health observations' : `Suggested actions (up to ${b.request.maxSuggestions})`}`, '',
      `Stage: **${stage.status}**${stage.reason ? ` (${stage.reason})` : ''}`, '');
    if (stage.key.endsWith('themes')) {
      const input = themeInput(s,stage.key === 'issue_themes' ? 'issues':'prs');
      lines.push(`Theme coverage: ${input.items.length} most recently updated captured open ${stage.key === 'issue_themes' ? 'issues' : 'PRs'}. Each appears in exactly one group; counts are calculated from membership.`, '');
      if (stage.run?.status === 'completed') for (const g of ThemeResult.parse(stage.run.result).groups) {
        lines.push(`### ${text(g.label)} — ${g.itemIds.length}`, '', text(g.summary), '',
          g.itemIds.map(id => `[${id.replace('issue:','#').replace('pr:','#')}](https://github.com/${b.request.repository}/${id.startsWith('pr:') ? 'pull':'issues'}/${id.split(':')[1]})`).join(', '), '');
      }
    } else if (stage.run?.status === 'completed') {
      if (stage.key === 'health') {
        const result = HealthResult.parse(stage.run.result);
        for (const o of result.observations) lines.push(`- ${text(o.summary)} Evidence: ${o.evidenceIds.map(text).join(', ')}`);
        lines.push('', ...result.limitations.map(l => `- Limitation: ${text(l)}`));
      } else {
        const result = ActionsResult.parse(stage.run.result);
        if (!result.suggestions.length) lines.push('No immediate action established from this evidence.');
        for (const [i,a] of result.suggestions.entries()) lines.push(`${i+1}. **${text(a.action)}** ${text(a.rationale)} Evidence: ${a.evidenceIds.map(text).join(', ')}`);
        lines.push('', ...result.limitations.map(l => `- Limitation: ${text(l)}`));
      }
    }
    if (stage.run) lines.push('', `Run: ${stage.run.runId} · Input SHA-256: ${stage.run.inputHash} · Prompt: ${stage.run.promptVersion}`, '');
  }
  lines.push('', '## Evidence index', '', 'Suggestions are proposals. Reference validation proves supplied evidence membership, not that a semantic claim is correct.', '');
  for (const e of actionEvidence(b)) lines.push(`- **${text(e.id)}**: ${text(e.statement)}`);
  lines.push('', `Snapshot SHA-256: ${b.snapshotHash}`, '', 'Model usage is recorded per child in JSON. Billed cost and remaining subscription quota are unknown. No target code was executed and no GitHub or email writes were performed.', '');
  return lines.join('\n');
}
export function repositoryBriefHtml(raw: unknown) {
  const b = validateRepositoryBrief(raw), s = b.snapshot;
  const esc = (value: unknown) => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const parts = [`<h1>${esc(b.request.repository)} repository brief</h1><p>Status: <strong>${b.status === 'running' ? 'unfinished — outcome unknown' : b.status}</strong> · ${b.budget.consumed}/4 agent attempts</p>`,
    `<p>Activity: [${esc(b.request.since)}, ${esc(b.request.until)})</p><p><a href="repository-brief.md">Markdown</a> · <a href="repository-brief.json">Saved evidence</a> · <a href="events.json">Trace</a></p>`,
    '<p>Backlog counts are current at collection. Themes cover sampled titles/labels, without bodies, comments, diffs or review state. Suggestions do not establish merge safety.</p>'];
  if (b.failure) parts.push(`<p>Workflow failure: ${b.failure}</p>`);
  if (s) {
    const m = repositoryMetrics(s);
    parts.push(`<h2>Counts and coverage</h2><p>Collected ${esc(s.startedAt)} to ${esc(s.finishedAt)}. GitHub search is indexed and non-atomic.</p><table><thead><tr><th>Metric</th><th>Total</th><th>Inspected membership</th></tr></thead><tbody>`);
    for (const c of m.counts) parts.push(`<tr><td>${esc(c.label)}</td><td>${c.totalReliable ? c.total : 'unknown'}</td><td>${c.sampled}; ${c.complete ? 'complete' : 'partial/unavailable'}; ${c.rejected} rejected</td></tr>`);
    parts.push('</tbody></table><p>Closures count currently closed items with a closure in the window, not reopen/close event throughput.</p>', '<h2>CI and contributors</h2>',
      `<p>Default branch: ${esc(s.defaultBranch ?? 'unknown')}. Latest observed GitHub Actions attempts for runs created in the window.</p>`,
      `<p>${m.ci.available ? `Sample ${m.ci.sampled}/${m.ci.reportedTotal} (${m.ci.complete ? 'complete' : 'partial'}). ${m.ci.passed} successful; ${m.ci.failed} failed; ${m.ci.excluded} excluded. Success rate: <strong>${m.ci.successRate === null ? 'unknown' : (100*m.ci.successRate).toFixed(1)+'%'}</strong> (${m.ci.passed}/${m.ci.denominator}).` : 'CI unavailable; no rate established.'}</p>`,
      '<p>Rate denominator: completed success, failure, timed_out, action_required, startup_failure. Pending, cancelled, skipped, neutral and unknown outcomes are excluded. External CI and job logs are not covered.</p>',
      `<p>Verified first-time PR authors: <strong>${m.contributors.verifiedNew.length}</strong>; ${m.contributors.checked}/${m.contributors.candidates} sampled non-bot candidates checked; ${m.contributors.unknown} unknown/unchecked. Population/history ${m.contributors.complete ? 'complete' : 'partial'}. This excludes other forms of contribution.</p>`);
    parts.push('<h3>Failed CI runs in the sample</h3><p>These links come from saved run metadata. Health/action agents received aggregate CI counts, without these details or logs.</p><ul>');
    for (const r of s.ci.runs.filter(r => r.status === 'completed' && ['failure','timed_out','action_required','startup_failure'].includes(r.conclusion ?? '')))
      parts.push(`<li><a href="https://github.com/${b.request.repository}/actions/runs/${r.id}">${esc(r.name)} — run ${r.id}, attempt ${r.attempt}</a> · ${esc(r.conclusion)}</li>`);
    parts.push('</ul>');
    for (const c of s.contributors.checks.filter(c => c.outcome === 'new')) parts.push(`<p>${esc(c.author)}: <a href="https://github.com/${b.request.repository}/pull/${c.firstPR}">first PR #${c.firstPR}</a> (${esc(c.firstCreatedAt)})</p>`);
    for (const stage of b.stages) {
      const label = stage.key === 'issue_themes' ? 'Issue themes' : stage.key === 'pr_themes' ? 'Pull request themes' : stage.key === 'health' ? 'Health observations' : 'Suggested actions';
      parts.push(`<h2>${label}</h2><p>${stage.status}${stage.reason ? ` (${stage.reason})` : ''}</p>`);
      if (stage.key.endsWith('themes')) parts.push(`<p>Theme coverage: ${themeInput(s,stage.key === 'issue_themes' ? 'issues' : 'prs').items.length} most recently updated captured open items. Each item belongs to one group.</p>`);
      if (stage.run?.status === 'completed') {
        if (stage.key.endsWith('themes')) for (const g of ThemeResult.parse(stage.run.result).groups) parts.push(`<h3>${esc(g.label)} — ${g.itemIds.length}</h3><p>${esc(g.summary)}</p><p>${g.itemIds.map(id => `<a href="https://github.com/${b.request.repository}/${id.startsWith('pr:') ? 'pull' : 'issues'}/${id.split(':')[1]}">#${id.split(':')[1]}</a>`).join(', ')}</p>`);
        else {
          const result = stage.key === 'health' ? HealthResult.parse(stage.run.result) : ActionsResult.parse(stage.run.result);
          const refs = (ids: string[]) => ids.map(id => `<a href="#${esc(id)}">${esc(id)}</a>`).join(', ');
          if ('observations' in result) for (const o of result.observations) parts.push(`<p>${esc(o.summary)} <small>Evidence: ${refs(o.evidenceIds)}</small></p>`);
          else {
            if (!result.suggestions.length) parts.push('<p>No immediate action established.</p>');
            parts.push('<ol>');
            for (const a of result.suggestions) parts.push(`<li><strong>${esc(a.action)}</strong> ${esc(a.rationale)} <small>Evidence: ${refs(a.evidenceIds)}</small></li>`);
            parts.push('</ol>');
          }
          parts.push('<ul>'); for (const l of result.limitations) parts.push(`<li>Limitation: ${esc(l)}</li>`); parts.push('</ul>');
        }
      }
      if (stage.run) parts.push(`<details><summary>Run provenance</summary><p>${stage.run.runId}<br>Input SHA-256: ${stage.run.inputHash}<br>Prompt: ${stage.run.promptVersion}</p></details>`);
    }
    parts.push('<h2>Evidence index</h2><p>Evidence membership is validated; semantic support remains model-assessed.</p><dl>');
    for (const e of actionEvidence(b)) parts.push(`<dt id="${esc(e.id)}">${esc(e.id)}</dt><dd>${esc(e.statement)}</dd>`);
    parts.push('</dl>');
  } else parts.push('<p>Collection has no saved outcome.</p>');
  parts.push(`<footer><p>Workflow ${b.workflowId} · ${b.execution.provider} / ${esc(b.execution.model)}<br>Snapshot SHA-256: ${b.snapshotHash ?? 'not established'}</p><p>Cost and remaining subscription quota are unknown. No target code execution or GitHub/email writes.</p></footer>`);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Repository brief</title><style>body{max-width:1050px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui;color:#17212c;background:#fafafa}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ccc;padding:.5rem}h2{margin-top:2.5rem}a{color:#175cad}small{display:block}dt{font-weight:bold;margin-top:1rem}dd,details,footer{overflow-wrap:anywhere}footer{border-top:1px solid #ccc;margin-top:2rem}li{margin:.5rem 0}</style><body>${parts.join('\n')}</body></html>\n`;
}
