import { hash } from '../repository-brief/contracts.ts';
import { eligiblePacket, type ChangeWorkflow } from '../change-proposal/record.ts';
import { proposalHtml } from '../change-proposal/render.ts';
import { randomUUID } from 'node:crypto';
import { escapeHtml as esc } from '../batch-report.ts';
import { scheduleControl } from '../delivery/control.ts';
import { nextOccurrence } from '../delivery/schedule.ts';
import { loadJob, type Job } from './config.ts';
import { history, timerStatus, type BriefEntry } from './history.ts';
import type { Operator } from './actions.ts';
import type { OperatorRequest, OperatorRecord } from './contracts.ts';
import { repositoryMetrics } from '../repository-brief/metrics.ts';
import { validatePacket, type Packet } from '../packet.ts';
import { locationHtml } from '../location-view.ts';
const styles=`:root{color-scheme:light;--ink:#233b35;--muted:#596960;--line:#d8dfd7;--paper:#f6f5ee}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 24px}nav{display:flex;gap:18px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:18px}h1{font-size:36px;line-height:1.15;margin:24px 0 12px}h2{font-size:24px}h3{font-size:18px}a{color:inherit;text-underline-offset:4px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:12px}.muted,small{color:var(--muted)}article,.panel{background:white;border:1px solid var(--line);border-radius:9px;padding:22px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}.metric strong{display:block;font-size:26px}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}button{font:inherit;padding:8px 14px;cursor:pointer;border:1px solid var(--ink);border-radius:5px;background:var(--ink);color:white}button.secondary{background:white;color:var(--ink)}button:disabled{opacity:.5;cursor:default}form{margin:0}.tag{display:inline-block;border-radius:20px;padding:3px 10px;background:#edf0ea;font-size:13px}.warn{background:#fff2d6;color:#75431b;padding:12px;border-radius:5px}.bad{background:#fae1df;color:#7d2b23;padding:12px;border-radius:5px}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid var(--line)}pre,code{overflow-wrap:anywhere;white-space:pre-wrap}pre{font:13px/1.7 ui-monospace,monospace;background:#f3f5f1;padding:14px}details{margin:18px 0}summary{cursor:pointer}.row{display:flex;justify-content:space-between;gap:16px;align-items:center}.location-brief{overflow-wrap:anywhere}.notice{margin:20px 0}.history{overflow-x:auto}footer{margin-top:32px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted);font-size:13px}@media(max-width:600px){main{padding:20px 12px}h1{font-size:28px}.row{align-items:start;flex-direction:column}article,.panel{padding:16px}}`;
export function page(title:string,body:string,refresh=false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh?'<meta http-equiv="refresh" content="5">':''}<title>${esc(title)} · Onionsoup</title><style>${styles}</style></head><body><main><nav><strong>Onionsoup</strong><a href="/">Repositories</a><a href="/operations">Activity</a><a href="/fixtures">Fixture trials</a> · <a href="/publications">Draft publications</a><a href="/">Refresh</a></nav>${body}<footer>Local operator console · Model suggestions require judgment. No target code execution or GitHub writes.</footer></main></body></html>`;
}
function form(job:Job,token:string,action:OperatorRequest['action'],label:string,extra:Record<string,string|number>={},disabled=false,featureQuery=false) {
  const fields={ csrf:token,requestId:randomUUID(),jobId:job.id,revision:job.revision,action,...extra };
  return `<form method="post" action="/actions">${Object.entries(fields).map(([k,v])=>`<input type="hidden" name="${k}" value="${esc(String(v))}">`).join('')}${featureQuery?'<label>Source search literal <input name="query" maxlength="160" required placeholder="A relevant symbol or phrase"></label> ':''}<button ${disabled?'disabled':''} class="${action==='run_now'?'':'secondary'}">${esc(label)}</button></form>`;
}
const status=(s:string)=>`<span class="tag">${esc(s.replaceAll('_',' '))}</span>`;
export async function dashboard(operator:Operator,token:string) {
  const blocks:string[]=[], busy=!!operator.active||await operator.locked();
  for(const c of operator.config.jobs) {
    try {
      const job=await loadJob(operator.config,c.id), h=await history(job), control=await scheduleControl(job.deliveryState,job.config.jobId), timer=await timerStatus(job);
      const next=nextOccurrence(job.config), latest=h.briefs[0]?.brief, success=h.briefs.find(b=>b.brief.status==='completed')?.brief;
      const numbers=latest?.snapshot?repositoryMetrics(latest.snapshot).counts:[];
      blocks.push(`<article><div class="row"><div><div class="eyebrow">${esc(job.id)}</div><h2>${esc(job.config.repository)}</h2></div>${status(control.paused?'paused':timer==='active'?'schedule active':`timer ${timer}`)}</div>
      <p>Daily/weekly schedule: <strong>${esc(job.config.schedule.time)} ${esc(job.config.schedule.timeZone)}</strong> · ${job.config.schedule.weekdays.map(d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}.</p>
      <p class="muted">Next configured occurrence: ${control.paused?'paused':esc(next?.dueAt??'unknown')}. Timer observation: ${timer}. Last complete analysis: ${esc(success?.finishedAt??'none observed')}.</p>
      ${job.config.smtp.security==='loopback'?'<p class="warn">Local relay configured. SMTP acceptance does not establish forwarding or inbox receipt.</p>':'<p class="muted">SMTP acceptance does not establish inbox receipt.</p>'}
      <p class="muted">Delivery recipient: ${esc(job.config.to)}.</p>
      <div class="grid">${numbers.filter(n=>['openIssues','openPRs'].includes(n.key)).map(n=>`<div class="metric"><strong>${n.totalReliable?n.total:'unknown'}</strong><span>${esc(n.label)}</span><br><small>${n.sampled} inspected · ${n.complete?'complete':'partial'} membership</small></div>`).join('')}<div class="metric"><strong>${h.briefs.length}</strong><span>Saved briefs</span></div></div>
      <div class="actions">${form(job,token,'run_now','Run brief now',{},busy)}${form(job,token,control.paused?'resume':'pause',control.paused?'Resume schedule':'Pause schedule',{},busy)}${job.inboxDirectory?`<a href="/issues/${job.id}/index.html">Issue inbox</a>`:''}</div>
      <p class="muted">Run now uses up to four Terra agent invocations and sends through this job’s configured relay. Pause affects future ticks; active work continues.</p>
      ${h.invalid?`<p class="warn">${h.invalid} invalid/unreadable artifact(s) excluded. Inspect local records before acting.</p>`:''}${h.truncated?'<p class="warn">History scan reached its bound; this view is incomplete.</p>':''}
      <h3>Brief history</h3>${h.briefs.length?`<div class="history"><table><thead><tr><th>Activity window ends</th><th>Analysis</th><th>Report</th></tr></thead><tbody>${h.briefs.slice(0,100).map(b=>`<tr><td>${esc(b.brief.request.until)}</td><td>${status(b.brief.status)}</td><td><a href="/briefs/${job.id}/${b.brief.workflowId}">Read brief</a></td></tr>`).join('')}</tbody></table></div>`:'<p>No saved briefs yet.</p>'}
      <h3>Delivery history</h3>${h.deliveries.length?h.deliveries.slice(0,100).map(d=>`<div class="panel"><div class="row"><strong>${esc(d.record.occurrence)}</strong>${status(d.status)}</div><p>${d.record.attempts.length}/3 attempts · <a href="/deliveries/${job.id}/${encodeURIComponent(d.record.occurrence)}/events">Trace</a></p>${!d.configMatches?'<p class="warn">Configuration changed; browser retry is disabled.</p>':''}${d.locked?'<p class="warn">Delivery lock present. Work may be active or interrupted.</p>':''}${d.status==='unknown'?'<p class="warn">Outcome unknown. Inspect relay evidence and reconcile through the delivery CLI before retrying.</p>':''}${d.configMatches&&!d.locked&&['prepared','rejected'].includes(d.status)&&d.record.attempts.length<3?form(job,token,'retry',d.status==='prepared'?'Send saved brief':'Retry saved message',{ occurrence:d.record.occurrence,attempts:d.record.attempts.length },busy):''}</div>`).join(''):'<p>No delivery attempts yet.</p>'}</article>`);
    } catch { blocks.push(`<article><h2>${esc(c.id)}</h2><p class="bad">Job unavailable. Check its configuration and artifacts locally.</p></article>`); }
  }
  return page('Maintainer inbox',`<div class="eyebrow">Maintainer workspace</div><h1>Your repositories, at a glance.</h1><p>Read saved briefs, track automation, and choose the next bounded investigation.</p>${operator.active?`<p class="warn">Work is active. <a href="/operations/${operator.active}">View progress</a>.</p>`:busy?'<p class="warn">An action lock is present. Another worker may be active or interrupted. Inspect activity and the previous worker before removing a stale lock.</p>':''}${blocks.join('')}`);
}
export async function briefPage(operator:Operator,job:Job,entry:BriefEntry,token:string) {
  const b=entry.brief, items=b.snapshot?.collections.find(c=>c.key==='openIssues')?.items??[];
  const existing=(await operator.records()).records, busy=!!operator.active||await operator.locked();
  return page(`${b.request.repository} brief`,`<h1>${esc(b.request.repository)}</h1><p>${status(b.status)} Activity [${esc(b.request.since)}, ${esc(b.request.until)})</p><div class="actions"><a href="/briefs/${job.id}/${b.workflowId}/report">Read full report</a><a href="/briefs/${job.id}/${b.workflowId}/json">Saved evidence</a><a href="/briefs/${job.id}/${b.workflowId}/events">Trace</a></div>
    <iframe title="Repository brief" src="/briefs/${job.id}/${b.workflowId}/report" style="width:100%;height:720px;border:1px solid #d8dfd7;margin-top:20px" sandbox="allow-same-origin allow-popups"></iframe>
    <h2>Choose an issue to investigate</h2><p>These are sampled open issues at collection. A click fetches fresh issue text and assesses readiness; only a ready bug report advances to pinned source inspection. Up to two agent invocations. Tests are read, not run.</p>
    ${job.source?`<p class="muted">Configured source commit: <code>${job.source.commit}</code>. This may differ from the affected release.</p>`:'<p class="warn">Configure an operator-owned checkout and pinned commit to enable investigation.</p>'}
    ${items.map(item=>{
      const previous=existing.find(r=>r.request.action==='investigate'&&r.request.briefId===b.workflowId&&r.request.number===item.number&&r.request.revision===job.revision);
      return `<article><div class="row"><div><strong>#${item.number}</strong><h3>${esc(item.title)}</h3><a href="https://github.com/${b.request.repository}/issues/${item.number}">Original issue</a></div>${previous?`<a href="/operations/${previous.workflowId}">View investigation</a>`:form(job,token,'investigate','Assess & investigate',{ briefId:b.workflowId,briefHash:entry.hash,number:item.number },!job.source||busy||!['completed','partial'].includes(b.status))}</div></article>`;
    }).join('')||'<p>No captured issue candidates.</p>'}`);
}
export function operationPage(r:OperatorRecord,active:boolean,packet?:Packet,controls?:{job:Job;token:string;busy:boolean},proposal?:ChangeWorkflow) {
  const q=r.request;
  let details='';
  if(packet) {
    const p=validatePacket(packet), a=p.readiness?.assessment;
    details=`<h2>Investigation result</h2><h3>#${p.issue.number}: ${esc(p.issue.title)}</h3><p>${status(p.status)} ${a?`${status(a.kind)} ${status(a.bug_readiness)}`:''}</p><p>${esc(a?.summary??'No accepted readiness result.')}</p>${a?.questions.length?`<h3>Missing information</h3><ul>${a.questions.map(q=>`<li>${esc(q.question)}</li>`).join('')}</ul>`:''}${locationHtml(p.location).replace(/<a href="locations\/[^\"]+">Original code-location record<\/a>/g,`<a href="/operations/${r.workflowId}/packet.json">Saved packet</a>`)}<p><a href="/operations/${r.workflowId}/packet.json">Packet evidence</a> · <a href="/operations/${r.workflowId}/packet.md">Markdown packet</a> · <a href="/operations/${r.workflowId}/packet.events">Packet trace</a></p>`;
  }
  if(packet&&controls&&r.status==='completed'&&controls.job.revision===q.revision) {
    try {
      eligiblePacket(packet);
      details+=`<article><h2>Prepare a change proposal</h2><p>Draft scope, acceptance criteria, checks and open questions. Up to two Terra calls. This does not accept scope or authorize implementation.</p>${form(controls.job,controls.token,'propose','Draft change proposal',
        {parentOperationId:r.workflowId,packetId:packet.packetId,packetHash:hash(packet)},controls.busy,packet.readiness!.assessment!.kind==='feature_request')}</article>`;
    } catch { /* The classification remains visible without broadening eligibility. */ }
  }
  if(proposal) details+=`<h2>Saved change proposal</h2><p><a href="/operations/${r.workflowId}/proposal.json">Proposal evidence</a> · <a href="/operations/${r.workflowId}/proposal.md">Markdown</a> · <a href="/operations/${r.workflowId}/proposal.events">Proposal trace</a></p>${proposalHtml(proposal)}`;
  if(q.action==='propose') details+=`<p><a href="/operations/${q.parentOperationId}">Parent investigation</a></p>`;
  return page('Operator action',`<h1>${esc(q.action.replaceAll('_',' '))}</h1><p>${status(r.status==='running'?(active?'running':'interrupted — outcome unknown'):r.status)} · Job ${esc(q.jobId)}</p><p>Started ${esc(r.startedAt)}${r.finishedAt?` · Finished ${esc(r.finishedAt)}`:''}</p>${q.action==='investigate'?`<p><a href="/briefs/${q.jobId}/${q.briefId}">Parent repository brief</a> · Selected issue #${q.number}</p>`:''}${r.result?`<p>Result: ${esc(r.result.type==='delivery'?r.result.status:r.result.type==='packet'||r.result.type==='proposal'?r.result.status:r.result.type==='skipped'?r.result.reason:r.result.paused?'schedule paused':'schedule resumed')}</p>`:''}${r.status==='failed'?'<p class="warn">The action stopped. Inspect child artifacts before starting another attempt; completed external effects may still exist.</p>':''}${r.status==='running'&&!active?'<p class="warn">No automatic replay. Inspect the delivery/packet records and any retained lock before recovery.</p>':''}${r.result?.type==='delivery'?`<p><a href="/">View delivery history</a></p>`:''}${details}<details><summary>Provenance</summary><pre>${esc(JSON.stringify({ actionId:r.workflowId,inputHash:r.inputHash,request:r.request,sourceCommit:r.commit,snapshotUpdatedAt:r.snapshot?.updatedAt },null,2))}</pre><a href="/operations/${r.workflowId}/events">Action trace</a></details>`,active);
}
export async function activityPage(operator:Operator) {
  const h=await operator.records();
  return page('Activity',`<h1>Operator activity</h1>${h.invalid?`<p class="warn">${h.invalid} invalid action record(s).</p>`:''}${h.truncated?'<p class="warn">History is bounded; older actions may be omitted.</p>':''}${h.records.map(r=>`<article><div class="row"><a href="/operations/${r.workflowId}">${esc(r.request.jobId)} · ${esc(r.request.action.replaceAll('_',' '))}</a>${status(r.status==='running'&&operator.active!==r.workflowId?'interrupted — unknown':r.status)}</div><p class="muted">${esc(r.startedAt)}</p></article>`).join('')||'<p>No operator actions yet.</p>'}`);
}
