import { validateBriefing } from './briefing-record.ts';
import { text, quote } from './packet.ts';
export function briefingMarkdown(raw: unknown): string {
  const b = validateBriefing(raw);
  const lines = [`# Maintenance briefing: ${text(b.repository)}`, '',
    `Status: **${b.status === 'running' ? 'unfinished — outcome unknown' : b.status}**`, '',
    `Workflow: ${b.workflowId} · Started: ${b.startedAt}${b.finishedAt ? ` · Finished: ${b.finishedAt}` : ''}`, '',
    `Execution: ${b.execution.provider} / ${text(b.execution.model)} · Invocations reserved: **${b.budget.consumed}/7**`, '',
    `Pinned commit: ${b.commit ?? 'not established'}`, '',
    '[Saved record and evidence](briefing.json) · [Workflow trace](events.json)', '',
    'Scope: up to five readiness assessments and the first two ready bug reports in captured order. This capacity policy is not a priority judgment. Classification makes no acceptance decision. Source and tests are reading suggestions; target code was not executed.', '',
    'The invocation allowance counts agent attempts, not model turns, tokens, subscription quota, or billed cost. Cost is unknown.', ''];
  if (b.failure) lines.push(`Workflow failure: **${b.failure}**. Remaining work has no established outcome.`, '');
  if (b.intake) {
    lines.push(`Intake: ${b.intake.method} · Captured: ${b.intake.capturedAt} · ${b.intake.issues.length}/${b.intake.requestedCount} snapshots · ${b.intake.scannedEntries} API entries inspected.`, '');
    if (b.intake.method === 'recently_updated_open') lines.push('Selection inspects at most 100 recently updated API entries, then takes open issues. This is not an exhaustive backlog scan.', '');
    for (const r of b.intake.rejected) lines.push(`- Issue #${r.number}: **${r.reason}**; no assessment attempted.`);
    lines.push('');
  } else lines.push('Intake did not complete; no captured issue set is available.', '');
  if (b.intake?.issues.length) {
    lines.push('## At a glance', '', '| Issue | Request kind | Bug readiness | Location |', '| --- | --- | --- | --- |');
    for (const [index, captured] of b.intake.issues.entries()) {
      const item = b.readiness?.items[index], a = item?.run?.assessment, slot = b.locations[index];
      lines.push(`| [#${captured.snapshot.number}](https://github.com/${b.repository}/issues/${captured.snapshot.number}) | ${a?.kind ?? 'unknown'} | ${a?.bug_readiness ?? item?.status ?? 'not_started'} | ${slot.handoff?.disposition ?? slot.disposition} |`);
    }
    lines.push('');
  }
  for (const [index, captured] of (b.intake?.issues ?? []).entries()) {
    const issue = captured.snapshot, item = b.readiness?.items[index], run = item?.run, a = run?.assessment;
    const slot = b.locations[index], h = slot.handoff, l = h?.location;
    lines.push(`## Issue #${issue.number}: ${text(issue.title)}`, '',
      `[Original issue](https://github.com/${b.repository}/issues/${issue.number}) · State at capture: ${captured.state} · Snapshot: ${issue.updatedAt}`, '',
      `Observed: ${captured.observedAt} · Comments excluded: ${captured.commentsExcluded}`, '',
      `Readiness attempt: **${item?.status ?? 'not_started'}**${item?.reason ? ` (${item.reason})` : ''}`, '');
    if (a) {
      lines.push(`Kind: **${a.kind}** · Bug readiness: **${a.bug_readiness}**`, '', text(a.summary), '');
      for (const q of a.questions) lines.push(`- Question: ${text(q.question)}`);
      for (const e of a.evidence) lines.push(`Evidence (${e.field}, ${e.source}):`, '', quote(e.quote), '');
    } else lines.push('No completed readiness assessment available.', '');
    lines.push(`Location: **${h?.disposition ?? slot.disposition}**${h?.reason ? ` (${h.reason})` : ''}`, '');
    if (slot.disposition === 'selection_limit') lines.push('Not attempted: two earlier ready reports filled the location allowance.', '');
    if (l?.brief) {
      lines.push(text(l.brief.summary), '');
      if (l.brief.schemaVersion === 3) lines.push(`Bounded test search: **${l.brief.testSearch.status}** — ${text(l.brief.testSearch.reason)}`, '');
      for (const [label, pointers] of [['Code', l.brief.codePointers], ['Test', l.brief.testPointers]] as const) {
        for (const c of pointers) {
          const path = c.path.split('/').map(encodeURIComponent).map(s => s.replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');
          lines.push(`${label}: [${text(c.path)}:${c.startLine}–${c.endLine}](https://github.com/${b.repository}/blob/${b.commit}/${path}#L${c.startLine}-L${c.endLine})`, '',
            ...('relevance' in c ? [`Model-assessed relevance: **${text(String(c.relevance))}**; coverage was not measured.`, ''] : []),
            text(c.reason), '', quote(c.quote), '');
        }
        if (!pointers.length) lines.push(`No ${label.toLowerCase()} starting point established.`, '');
      }
      for (const u of l.brief.uncertainties) lines.push(`- Uncertainty: ${text(u)}`);
      lines.push('');
    }
    lines.push('Provenance:', '', quote(JSON.stringify({ inputHash: item?.inputHash, readinessWorkflowId: b.readiness?.workflowId,
      readinessRunId: run?.runId, readinessPrompt: run?.promptVersion, handoffId: h?.workflowId, locationRunId: l?.runId,
      locationParentId: l?.input.parent.runId, locationPrompt: l?.promptVersion, locationRuntime: l?.runtimeHash }, null, 2)), '');
  }
  return lines.join('\n');
}
