import { text, quote } from '../packet.ts';
import { validateChangeWorkflow, proposalResult } from './record.ts';
import type { z } from 'zod';
import type { Claim } from './contracts.ts';
const claim=(c:z.infer<typeof Claim>)=>`${text(c.text)} (${c.basis}; ${c.evidenceIds.map(text).join(', ')})`;
export function proposalMarkdown(raw:unknown) {
  const w=validateChangeWorkflow(raw),p=proposalResult(w);
  const lines=[`# Change proposal: ${text(w.parent.issue.repository)} #${w.parent.issue.number}`,'',text(w.parent.issue.title),'',
    `Kind: ${w.changeKind} · Workflow: ${w.status} · Proposal: ${p?.status??'unavailable'}`,'',
    'Maintainer acceptance: not recorded. Verification: not executed. All changes and checks below are proposals, not instructions authorized for execution.','',
    `Pinned commit: ${w.parent.repository.commit}`,'',`Parent packet: ${w.parent.packetId} · Hash: ${w.parentHash}`,''];
  if(p) {
    lines.push('## Desired outcome','',claim(p.outcome),'','## Proposed scope','',...p.changes.map(c=>`- ${claim(c)}`),'',
      '## Non-goals','',...p.nonGoals.map(c=>`- ${claim(c)}`),'','## Acceptance criteria','',...p.acceptanceCriteria.map(c=>`- **${c.id}**: ${claim(c.criterion)}`),'',
      '## Verification plan','',...p.verification.map(v=>`- ${v.criterionIds.join(', ')} · ${v.kind} · base expectation: ${v.baselineExpectation}: ${claim(v.check)}`),'',
      '## Compatibility, migration and documentation','',`- Compatibility: ${claim(p.compatibility)}`,`- Migration: ${claim(p.migration)}`,`- Documentation: ${claim(p.documentation)}`,'',
      '## Open questions','',...p.questions.map(q=>`- ${q.blocking?'Blocking':'Advisory'}: ${text(q.question)} (${q.evidenceIds.map(text).join(', ')})`),'',
      '## Risks','',...p.risks.map(c=>`- ${claim(c)}`),'');
  }
  lines.push('## Preparation limits','',...(w.preparation?.limitations??['Preparation unavailable.']).map(l=>`- ${text(l)}`),'',
    '## Source evidence','');
  for(const s of w.preparation?.sources??[]) lines.push(`### ${s.id}: ${text(s.path)}:${s.startLine}–${s.endLine}`,'',`Relevance: ${s.relevance}`,'',quote(s.quote),'');
  lines.push('## Provenance','',quote(JSON.stringify({workflowId:w.workflowId,execution:w.execution,budget:w.budget,
    parentPacketId:w.parent.packetId,query:w.query,sourceAttempts:w.preparation?.attempts,stages:w.stages.map(s=>({agent:s.agent,runId:s.run?.runId,promptVersion:s.run?.promptVersion,status:s.run?.status,usage:s.run?.tokenUsage?.totals}))},null,2)),
    '', 'Token counts are provider reports. Billed cost and subscription quota consumption are unknown.','');return lines.join('\n');
}

// The console consumes a safe fragment, not model-authored Markdown/HTML.
export function proposalHtml(raw:unknown) {
  const w=validateChangeWorkflow(raw),p=proposalResult(w);
  const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const c=(v:z.infer<typeof Claim>)=>`${esc(v.text)} <small>(${v.basis}; ${v.evidenceIds.map(esc).join(', ')})</small>`;
  const list=(items:string[])=>items.length?`<ul>${items.map(i=>`<li>${i}</li>`).join('')}</ul>`:'<p class="muted">None specified.</p>';
  return `<article><h3>${esc(w.parent.issue.repository)} #${w.parent.issue.number}: ${esc(w.parent.issue.title)}</h3>
    <p><strong>${p?.status??'unavailable'}</strong> · ${w.changeKind}</p>
    <p class="warn">Maintainer acceptance: not recorded. Verification: not executed. Changes and checks are proposed.</p>
    ${p?`<h3>Desired outcome</h3><p>${c(p.outcome)}</p>
    <h3>Proposed scope</h3>${list(p.changes.map(c))}<h3>Non-goals</h3>${list(p.nonGoals.map(c))}
    <h3>Acceptance criteria</h3>${list(p.acceptanceCriteria.map(a=>`<strong>${a.id}</strong>: ${c(a.criterion)}`))}
    <h3>Verification plan</h3>${list(p.verification.map(v=>`<strong>${v.criterionIds.join(', ')} · ${v.kind}</strong>: ${c(v.check)}<br><small>Base expectation: ${v.baselineExpectation}; not executed.</small>`))}
    <h3>Open questions</h3>${list(p.questions.map(q=>`<strong>${q.blocking?'Blocking':'Advisory'}</strong>: ${esc(q.question)}`))}
    <h3>Compatibility</h3><p>${c(p.compatibility)}</p><h3>Migration</h3><p>${c(p.migration)}</p><h3>Documentation</h3><p>${c(p.documentation)}</p>
    <h3>Risks</h3>${list(p.risks.map(c))}`:'<p>No validated proposal result is available.</p>'}
    <h3>Preparation limits</h3>${list((w.preparation?.limitations??['Preparation unavailable.']).map(esc))}
    <details><summary>Inspected source and provenance</summary><p>Pinned commit: <code>${w.parent.repository.commit}</code></p>
    ${(w.preparation?.sources??[]).map(s=>`<h4>${s.id} · ${esc(s.path)}:${s.startLine}–${s.endLine}</h4><p>${s.relevance}</p><pre>${esc(s.quote)}</pre>`).join('')}
    <p>Parent packet: ${w.parent.packetId} · Workflow: ${w.workflowId} · Reserved invocations: ${w.budget.consumed}/${w.budget.limit}</p></details></article>`;
}
