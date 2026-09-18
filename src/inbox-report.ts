import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, loadIndex, loadAttempts, latestAttempt, type Attempt, type Observation, type Refresh } from './inbox-store.ts';
import { optionalJson, atomicJson } from './batch-store.ts';
import { escapeHtml as esc, scriptJson } from './batch-report.ts';
import { loadLocationRuns, attachedLocation } from './location-workflow.ts';
import { locationHtml } from './location-view.ts';

export function category(o: Observation, attempt?: Attempt) {
  if (o.state === 'closed') return 'closed';
  if (o.rejection) return 'attention';
  if (!attempt) return 'waiting';
  if (attempt.record.status !== 'completed') return 'attention';
  const a = attempt.record.assessment!;
  if (a.kind === 'bug_report') return a.bug_readiness === 'ready' ? 'ready' : 'questions';
  return a.kind;
}
const labels: Record<string, string> = { ready: 'Ready to investigate', questions: 'Needs information',
  feature_request: 'Feature request', support_question: 'Support question', other: 'Other request',
  unclear: 'Unclear request', waiting: 'Waiting', attention: 'Needs attention', closed: 'Closed on GitHub' };
export async function renderInbox(directory: string) {
  const config = await loadConfig(directory);
  const index = await loadIndex(directory, config);
  const attempts = await loadAttempts(directory, config);
  const locationRuns = await loadLocationRuns(directory);
  let names: string[] = [];
  try { names = (await readdir(join(directory, 'refreshes'))).filter(n => n.endsWith('.json')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const latestRefresh = names.length ? await optionalJson(join(directory, 'refreshes', names.at(-1)!)) as Refresh : undefined;
  const rows = index.observations.map(o => { const attempt = o.snapshot ? latestAttempt(attempts, o.snapshot) : undefined;
    return { observation: o, attempt, category: category(o, attempt) }; }).sort((a, b) => b.observation.updatedAt.localeCompare(a.observation.updatedAt));
  const finished = attempts.filter(a => a.record.status !== 'running');
  const sum = (key: 'inputTokens' | 'outputTokens') => finished.length && finished.every(a => Number.isFinite(a.record.tokenUsage?.totals[key])) ?
    finished.reduce((total, a) => total + a.record.tokenUsage!.totals[key], 0) : null;
  const counts = Object.fromEntries(Object.keys(labels).map(c => [c, rows.filter(r => r.category === c).length]));
  const finishedLocations = locationRuns.filter(r => r.status !== 'running');
  const locationUsage = (key: 'inputTokens' | 'outputTokens') => finishedLocations.length && finishedLocations.every(r => Number.isFinite(r.tokenUsage?.totals[key])) ?
    finishedLocations.reduce((total, r) => total + r.tokenUsage!.totals[key], 0) : null;
  const summary = { schemaVersion: 1, repository: config.repository, provider: config.provider, model: config.model,
    promptVersion: config.promptVersion, generatedAt: new Date().toISOString(), lastScanAt: index.lastScanAt ?? null,
    scannedEntries: index.scannedEntries ?? null, windowFull: index.windowFull ?? null, latestRefresh: latestRefresh ?? null,
    locationBriefs: rows.filter(r => attachedLocation(locationRuns, r.attempt?.record, r.observation.snapshot)?.status === 'completed').length,
    locationRuns: { attempts: locationRuns.length, completed: locationRuns.filter(r => r.status === 'completed').length,
      failed: locationRuns.filter(r => r.status === 'failed').length, unfinished: locationRuns.filter(r => r.status === 'running').length,
      steps: locationRuns.reduce((total, r) => total + r.events.filter(e => e.type === 'stepStart').length, 0),
      inputTokensReported: locationUsage('inputTokens'), outputTokensReported: locationUsage('outputTokens') },
    counts, attempts: attempts.length, completed: finished.filter(a => a.record.status === 'completed').length,
    failed: finished.filter(a => a.record.status === 'failed').length, interruptedUnresolved: attempts.length - finished.length,
    steps: attempts.reduce((sum, a) => sum + a.record.events.filter(e => e.type === 'stepStart').length, 0),
    inputTokensReported: sum('inputTokens'), outputTokensReported: sum('outputTokens'), quotaConsumed: null, billedCost: null };
  await atomicJson(join(directory, 'summary.json'), summary);
  const cards = rows.map(({ observation: o, attempt, category: group }) => {
    const run = attempt?.record; const a = run?.assessment;
    const oldCount = attempts.filter(x => x.record.input.number === o.number && x !== attempt).length;
    return `<article data-category="${group}" data-search="${esc(`${o.number} ${o.title}`.toLowerCase())}">
      <div class="card-top"><span class="badge ${group}">${labels[group]}</span><span>#${o.number}</span></div>
      <h2><a href="https://github.com/${esc(config.repository)}/issues/${o.number}" target="_blank" rel="noopener noreferrer">${esc(o.title)}</a></h2>
      <p class="meta">Observed ${esc(o.observedAt)} · GitHub updated ${esc(o.updatedAt)} · ${o.commentsExcluded} comments excluded</p>
      ${o.rejection ? '<p>The title or body exceeds the input contract, or is invalid. No model assessment was requested for this snapshot.</p>' : ''}
      ${group === 'waiting' ? '<p>Queued for a future bounded refresh.</p>' : ''}
      ${run && run.status !== 'completed' ? `<p class="problem">${run.status === 'running' ? 'Interrupted or still running: outcome unknown. Inspect and recover before retrying.' : `Assessment failed: ${esc(run.failure)}. No automatic retry.`}</p>` : ''}
      ${a ? `<p class="assessment">${esc(a.summary)}</p>${o.state === 'closed' ? '<p>This assessment predates the observed closure.</p>' : ''}
        ${a.questions.length ? `<div class="questions"><h3>Proposed follow-up questions</h3><ol>${a.questions.map(q => `<li>${esc(q.question)}</li>`).join('')}</ol><p class="meta">Drafts only. Nothing has been sent.</p></div>` : ''}
        ${a.evidence.length ? `<details><summary>Evidence for bug readiness</summary><dl>${a.evidence.map(e => `<dt>${esc(e.field)}</dt><dd>${esc(e.quote)}</dd>`).join('')}</dl></details>` : ''}` : ''}
      ${locationHtml(attachedLocation(locationRuns, run, o.snapshot))}
      ${o.snapshot ? `<details><summary>Read observed issue text</summary><pre>${esc(o.snapshot.body || '(Empty body)')}</pre></details>` : ''}
      <details><summary>Run details${oldCount ? ` · ${oldCount} earlier attempt${oldCount === 1 ? '' : 's'}` : ''}</summary>
        <p>Request type describes this report; it does not accept or reject it. Source freshness is limited to the observations shown above.</p>
        <pre>${esc(JSON.stringify({ model: config.model, provider: config.provider, runId: run?.runId ?? null,
          prompt: config.promptVersion, assessedSnapshotUpdatedAt: run?.input.updatedAt ?? null,
          assessment: a ? { kind: a.kind, bug_readiness: a.bug_readiness } : null,
          steps: run?.events.filter(e => e.type === 'stepStart').length ?? null, usage: run?.tokenUsage?.totals ?? null }, null, 2))}</pre>
        ${attempt ? `<a href="records/${String(attempt.sequence).padStart(8, '0')}-${esc(run!.runId)}.json">Original run record</a>` : ''}
      </details></article>`;
  }).join('');
  const filters = [['assessed', 'Assessed'], ...Object.entries(labels), ['all', 'Everything']];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(config.repository)} · Onionsoup inbox</title>
  <style> :root{color-scheme:light;--ink:#233b35;--muted:#596960;--line:#d8dfd7;--paper:#f6f5ee}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1060px;margin:0 auto;padding:40px 24px}header{padding:8px 0 24px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}h1{font-size:38px;line-height:1.15;margin:10px 0}h2{font-size:22px;line-height:1.3;margin:12px 0}h3{font-size:16px}a{color:inherit;text-underline-offset:4px}.lede{max-width:740px}.meta{color:var(--muted);font-size:13px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin:24px 0}.stat{background:white;border:1px solid var(--line);padding:14px}.stat strong{display:block;font-size:26px}.stat span{font-size:13px;color:var(--muted)}.controls{background:var(--paper);padding:12px 0;position:sticky;top:0;z-index:1;border-bottom:1px solid var(--line)}.filters{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}button,input{font:inherit}button{border:1px solid var(--line);background:white;padding:7px 11px;border-radius:5px;cursor:pointer}button[aria-pressed=true]{background:var(--ink);color:white}input{width:100%;padding:10px 12px;border:1px solid var(--line);background:white}article{background:white;border:1px solid var(--line);border-radius:8px;padding:24px;margin:18px 0}.card-top{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:13px}.badge{padding:4px 10px;border-radius:16px;background:#edf0ea}.ready{background:#dcefe4}.questions,.attention{background:#fff2d6}.feature_request{background:#e6eafa}.questions{padding:4px 18px;border-radius:4px}.problem{color:#884126}details{margin:16px 0;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 ui-monospace,monospace;background:#f3f5f1;padding:14px}dd{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 14px}dt{font-weight:600;font-size:13px}.location-brief{overflow-wrap:anywhere;margin:20px 0;padding:16px;background:#f2f5f8;border-left:3px solid #627f9d}.location-brief a,.location-brief code{overflow-wrap:anywhere}.empty{padding:32px;text-align:center;color:var(--muted)}[hidden]{display:none!important}@media(max-width:600px){main{padding:22px 14px}h1{font-size:29px}article{padding:18px}.controls{position:static}}</style></head><body><main>
  <header><div class="eyebrow">Onionsoup / read-only maintenance inbox</div><h1>${esc(config.repository)}</h1><p class="lede">Browse request assessments, proposed questions, and code-location briefs for selected ready reports. Nothing here changes GitHub.</p><p class="meta">${esc(config.model)} · ${esc(config.promptVersion)} · Last scan ${esc(index.lastScanAt ?? 'not completed')}</p></header>
  <section class="stats"><div class="stat"><strong>${counts.ready}</strong><span>Ready to investigate</span></div><div class="stat"><strong>${counts.questions}</strong><span>Need information</span></div><div class="stat"><strong>${counts.feature_request}</strong><span>Feature requests</span></div><div class="stat"><strong>${counts.waiting}</strong><span>Waiting for assessment</span></div><div class="stat"><strong>${counts.attention}</strong><span>Need attention</span></div><div class="stat"><strong>${summary.locationBriefs}</strong><span>Code-location briefs</span></div></section>
  <details><summary>Refresh status and usage</summary><p>Latest refresh: ${esc(latestRefresh?.status ?? 'none')}${latestRefresh?.warning ? ` (${esc(latestRefresh.warning)})` : ''}. ${latestRefresh?.attempted ?? 0} attempts; ${latestRefresh?.completed ?? 0} completed; ${latestRefresh?.failed ?? 0} failed; ${latestRefresh?.skipped ?? 0} known open snapshots skipped.</p>
  <p>Readiness: ${summary.attempts} total attempts · ${summary.steps} recorded steps · ${summary.inputTokensReported ?? 'unknown'} input tokens · ${summary.outputTokensReported ?? 'unknown'} output tokens.</p>
  <p>Code-location, including historical versions: ${summary.locationRuns.attempts} attempts · ${summary.locationRuns.completed} completed · ${summary.locationRuns.failed} failed · ${summary.locationRuns.unfinished} unfinished · ${summary.locationRuns.steps} steps · ${summary.locationRuns.inputTokensReported ?? 'unknown'} input tokens · ${summary.locationRuns.outputTokensReported ?? 'unknown'} output tokens. SDK counts are not a bill; quota consumption and cost are unknown. Interrupted calls may have unreported usage.</p>
  <p>The latest scan read ${index.scannedEntries ?? 0} API entries (including pull requests). ${index.windowFull ? 'The scan reached its limit; older updates may be outside this window.' : 'The scan did not fill its configured window.'} Previously seen issues outside the window retain their last observation. A title/body change requires a new assessment; metadata-only changes reuse the original result. No claim of complete repository coverage or human-validated accuracy.</p></details>
  <div class="controls"><label for="search">Find an issue</label><input id="search" type="search" placeholder="Issue number or title"><div class="filters" role="group" aria-label="Filter issues">${filters.map(([key, label]) => `<button data-filter="${key}" aria-pressed="${key === 'assessed'}">${label}${counts[key] !== undefined ? ` (${counts[key]})` : ''}</button>`).join('')}</div><span id="visible" class="meta" role="status"></span></div>
  <div id="issues">${cards}</div><p id="empty" class="empty" hidden>No issues match this view. Try another filter, or refresh to assess queued reports.</p>
  <footer class="meta">Generated ${esc(summary.generatedAt)}. This is a local snapshot; run the refresh command and reload to update it.</footer></main>
  <script>const cards=[...document.querySelectorAll('article')];let filter='assessed';const assessed=${scriptJson(['ready','questions','feature_request','support_question','other','unclear'])};function update(){const q=document.getElementById('search').value.toLowerCase();let count=0;for(const card of cards){const visible=(filter==='all'||(filter==='assessed'?assessed.includes(card.dataset.category):filter===card.dataset.category))&&card.dataset.search.includes(q);card.hidden=!visible;if(visible)count++;}document.getElementById('visible').textContent=count+' issue'+(count===1?'':'s')+' shown';document.getElementById('empty').hidden=count!==0;}document.getElementById('search').addEventListener('input',update);for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{filter=button.dataset.filter;for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b===button));update();});update();</script></body></html>`;
  await writeFile(join(directory, 'index.html'), html, { mode: 0o600 });
  return summary;
}
