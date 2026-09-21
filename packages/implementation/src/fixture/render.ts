import {text,quote} from '@onionsoup/maintenance/packet';
import {escapeHtml} from '../escape.ts';
import {validateFixtureWorkflow} from './record.ts';
import {ReviewResult} from './contracts.ts';
export function fixtureMarkdown(raw:unknown) {
  const w=validateFixtureWorkflow(raw),r=w.stages.find(s=>s.agent==='change-review')?.run;
  const review=r?.status==='completed'?ReviewResult.parse(r.result):undefined;
  return [`# Owned fixture: ${w.case} / ${w.mode}`,'',`Status: ${w.status} · Outcome: ${w.outcome??'unfinished; outcome unknown'}`,'',
    'Authorization covers this owned fixture only. Publication is not authorized. Passing finite checks and model review do not establish universal correctness or independent human acceptance.','',
    `Base commit: ${w.scope?.baseCommit??'unavailable'}`,`Base tree: ${w.scope?.baseTree??'unavailable'}`,`Candidate diff hash: ${w.diffHash??'unavailable'}`,`Independently applied diff tree: ${w.diffAppliedTreeHash??'not established'}`,'',
    '## Accepted criteria','',...(w.scope?.proposal.acceptanceCriteria??[]).map(c=>`- ${c.id}: ${text(c.criterion.text)}`),'',
    ...(['baseline','candidate'] as const).flatMap(phase=>{const receipt=w[phase];return [`## ${phase}`,'',receipt?`Outcome: ${receipt.status}; cleanup: ${receipt.cleanup}`:'Not executed.',
      ...(receipt?.checks??[]).map(c=>`- ${c.id} (${c.criterionIds.join(', ')}): ${c.status} — ${c.reason}`),''];}),
    '## Independent model review','',review?`Verdict: ${review.verdict}`:'No completed review.',
    ...(review?.findings??[]).map(f=>`- ${f.severity}: ${f.path}:${f.line} (${f.criterionIds.join(', ')}): ${text(f.explanation)}`),
    ...(review?.limitations??[]).map(l=>`- ${text(l)}`),'','## Candidate diff','',quote(w.diff??'No candidate.'),'','## Provenance','',
    quote(JSON.stringify({workflowId:w.workflowId,scopeId:w.scope?.scopeId,policyVersion:w.scope?.policyVersion,image:w.runtime.imageId,nodeHash:w.runtime.nodeHash,
      budget:w.budget,stages:w.stages.map(s=>({agent:s.agent,runId:s.run?.runId,prompt:s.run?.promptVersion,status:s.run?.status,usage:s.run?.tokenUsage?.totals})),pendingExecution:w.pendingExecution},null,2)),''].join('\n');
}
export const fixtureHtml=(raw:unknown)=>`<pre>${escapeHtml(fixtureMarkdown(raw))}</pre>`;
