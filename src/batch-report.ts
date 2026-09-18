import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadReviewedCases, summarizeModel } from './batch-review.ts';
import { atomicJson } from './batch-store.ts';
import { assessmentLabel } from './assessment-view.ts';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function renderBatchReport(directory: string) {
  const { manifest, cases, costs } = await loadReviewedCases(directory);
  const metrics = manifest.models.map(model => summarizeModel(manifest, model, cases, costs[model]));
  const summary = { schemaVersion: 2, batchId: manifest.batchId, promptVersion: manifest.frozen.promptVersion,
    criteria: manifest.criteria, generatedAt: new Date().toISOString(), models: metrics };
  await atomicJson(join(directory, 'summary.json'), summary);
  const title = `${manifest.repository}: ${manifest.cases.length}-issue review`;
  const statRows = metrics.map(m => `<tr><td>${escapeHtml(m.model)}</td><td>${m.completed}/${m.assigned}</td><td>${m.failed}</td><td>${m.reviewed}/${m.assigned}</td><td>${m.acceptanceRate === null ? 'Pending' : `${Math.round(m.acceptanceRate * 100)}%`}</td><td>${escapeHtml(m.readiness)}</td></tr>`).join('');
  const cards = manifest.cases.map((item, index) => {
    const order = index % 2 ? [...manifest.models].reverse() : manifest.models;
    const outputs = order.map((model, position) => {
      const { run, review } = cases.find(c => c.model === model && c.issue === item.input.number)!;
      const a = run?.assessment;
      const content = a ? `<strong>${escapeHtml(assessmentLabel(a))}</strong><p>${escapeHtml(a.summary)}</p>
        <ul>${a.evidence.map(e => `<li><b>${escapeHtml(e.field)}</b> (${escapeHtml(e.source)}): <q>${escapeHtml(e.quote)}</q></li>`).join('')}</ul>
        ${a.questions.length ? `<h4>Proposed questions</h4><ul>${a.questions.map(q => `<li>${escapeHtml(q.question)}</li>`).join('')}</ul>` : '<p>No follow-up questions.</p>'}` :
        `<p>${escapeHtml(run?.failure ?? run?.status ?? 'Not run')}</p>`;
      return `<section class="candidate"><h3>${manifest.models.length === 1 ? 'Assessment' : `Candidate ${position + 1}`}</h3>${content}
        <details><summary>Model and recorded usage</summary><pre>${escapeHtml(JSON.stringify({ model, runId: run?.runId, usage: run?.tokenUsage?.totals ?? null }, null, 2))}</pre><p>SDK estimates are not subscription charges. Actual quota/cost is unknown.</p></details>
        ${run && run.status !== 'running' ? `<form data-model="${escapeHtml(model)}" data-issue="${item.input.number}" data-run="${escapeHtml(run.runId)}">
          <label>Verdict <select name="verdict"><option value="">Unreviewed</option>${['accept', 'revise', 'reject'].map(v => `<option value="${v}" ${review?.verdict === v ? 'selected' : ''}>${v === 'accept' ? 'Accept unchanged' : v === 'revise' ? 'Needs revision' : 'Reject'}</option>`).join('')}</select></label>
          <fieldset><legend>Defects found (leave unchecked if none)</legend>${[
            ['falseReady', 'Unsupported ready decision'], ['unnecessaryQuestions', 'Unnecessary questions'],
            ['overlookedEvidence', 'Overlooked supplied information'], ['unsupportedClaims', 'Unsupported claims'],
          ].map(([key, label]) => `<label><input type="checkbox" name="${key}" ${(review as unknown as Record<string, unknown>)?.[key] ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>
          <label>Correction or reason <textarea name="notes" rows="3" maxlength="6000">${escapeHtml(review?.notes ?? '')}</textarea></label>
        </form>` : '<p>Feedback becomes available when this run finishes.</p>'}</section>`;
    }).join('');
    return `<article id="issue-${item.input.number}"><h2><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">#${item.input.number}: ${escapeHtml(item.input.title)}</a></h2>
      <p>Snapshot: ${escapeHtml(item.input.updatedAt)}. ${item.commentsExcluded} comments excluded. Bucket: ${item.bucket}. ${item.declaredAgentGenerated ? 'The report declares agent involvement.' : 'Authorship is not verified.'}</p>
      <details><summary>Read the frozen issue text</summary><pre>${escapeHtml(item.input.body)}</pre></details>
      <div class="candidates">${outputs}</div></article>`;
  }).join('');
  const embedded = { batchId: manifest.batchId, reviews: cases.flatMap(c => c.review ? [c.review] : []) };
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title><style>
    body{font:16px/1.5 system-ui,sans-serif;max-width:1300px;margin:2rem auto;padding:0 1rem;color:#20252a;background:#fafaf7} h1,h2,h3{line-height:1.25} a{color:#165c80} pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem;font:14px/1.5 ui-monospace,monospace} q{white-space:pre-wrap;overflow-wrap:anywhere} table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #ccc;padding:.5rem;text-align:left} .toolbar{position:sticky;top:0;background:#e6efeb;padding:1rem;border:1px solid #abc;z-index:1} .candidates{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem}.candidate,article{border:1px solid #ddd;padding:1rem;margin:1rem 0;background:white}label{display:block;margin:.5rem 0}textarea{width:95%}button,select,input,textarea{font:inherit}button{padding:.4rem .8rem}summary{cursor:pointer}fieldset{border:1px solid #ddd}#status{font-weight:600}small{color:#555}
    </style><h1>${escapeHtml(title)}</h1>
    <p>Evaluate whether each assessment saves a maintainer work. A successful model call is not an accepted assessment. Review only the saved title/body; linked issues may have changed. No feedback is posted to GitHub.</p>
    <p>Graduation: at least 30 cases, every case reviewed, at least 90% accepted unchanged, no failed runs or unsupported ready decisions, and a separate human decision on quota/cost. This qualifies only a supervised pilot.</p>
    <table><thead><tr><th>Model</th><th>Completed</th><th>Failed</th><th>Reviewed</th><th>Accepted unchanged</th><th>Gate</th></tr></thead><tbody>${statRows}</tbody></table>
    <p>These totals update after feedback is imported with the CLI. Request type describes the report; it does not approve or reject it. Legacy v1 outcomes retain their original labels.</p>
    <div class="toolbar"><label>Reviewer <input id="reviewer" maxlength="100" placeholder="Your name"></label><label>Role <select id="role"><option value="operator">Operator / proxy reviewer</option><option value="maintainer">Repository maintainer</option></select></label>
    <button id="export">Export feedback JSON</button> <label>Load saved feedback <input id="load" type="file" accept=".json,application/json"></label>
    <p id="status" role="status">Select a verdict to mark an assessment reviewed. Export before closing.</p></div>
    ${cards}<script id="batch-data" type="application/json">${scriptJson(embedded)}</script><script>
    const data=JSON.parse(document.getElementById('batch-data').textContent);
    const forms=[...document.querySelectorAll('form')];
    const flags=['falseReady','unnecessaryQuestions','overlookedEvidence','unsupportedClaims'];
    const key='onionsoup-feedback-'+data.batchId;
    const originals=new Map(data.reviews.map(r=>[r.model+':'+r.issue,r]));
    const status=document.getElementById('status');
    function readForms(){return {schemaVersion:1,reviews:forms.flatMap(f=>{
      const verdict=f.elements.verdict.value;if(!verdict)return [];
      const old=originals.get(f.dataset.model+':'+f.dataset.issue);
      const content={verdict,notes:f.elements.notes.value};for(const flag of flags)content[flag]=f.elements[flag].checked;
      if(old && Object.entries(content).every(([k,v])=>old[k]===v)) {const {recordedAt,...review}=old;return [review];}
      const reviewer=document.getElementById('reviewer').value.trim();if(!reviewer)throw new Error('Enter your reviewer name before saving new reviews.');
      if(verdict==='accept' && flags.some(k=>content[k]))throw new Error('An unchanged acceptance cannot also flag a defect.');
      if(verdict!=='accept'&&!content.notes.trim())throw new Error('Add a correction or reason for each revised/rejected assessment.');
      return [{batchId:data.batchId,model:f.dataset.model,issue:Number(f.dataset.issue),runId:f.dataset.run,reviewer,role:document.getElementById('role').value,...content}];
    })};}
    function fill(bundle){
      if(bundle.schemaVersion!==1||!Array.isArray(bundle.reviews))throw new Error('Invalid feedback file');
      for(const r of bundle.reviews){
        if(r.batchId!==data.batchId)throw new Error('Feedback is for a different batch');
        const f=forms.find(f=>f.dataset.model===r.model&&Number(f.dataset.issue)===r.issue&&f.dataset.run===r.runId);
        if(!f)throw new Error('Feedback refers to a different run');
      }
      for(const r of bundle.reviews){const f=forms.find(f=>f.dataset.model===r.model&&Number(f.dataset.issue)===r.issue);f.elements.verdict.value=r.verdict;f.elements.notes.value=r.notes;for(const k of flags)f.elements[k].checked=r[k];originals.set(r.model+':'+r.issue,r);}
      status.textContent='Loaded '+bundle.reviews.length+' reviews. Export to preserve changes.';
    }
    document.getElementById('export').addEventListener('click',()=>{try{
      const bundle=readForms();const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='feedback-'+data.batchId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status.textContent='Exported '+bundle.reviews.length+' reviews. Import the file with npm run batch -- import-feedback.';
    }catch(e){status.textContent=e.message;}});
    document.getElementById('load').addEventListener('change',async e=>{try{fill(JSON.parse(await e.target.files[0].text()));}catch(error){status.textContent=error.message;}});
    document.addEventListener('change',()=>{try{localStorage.setItem(key,JSON.stringify(readForms()));}catch(e){status.textContent=e.message+' Export feedback to save your work.';}});
    try{const draft=localStorage.getItem(key);if(draft)fill(JSON.parse(draft));}catch(e){status.textContent='Local draft storage unavailable. Export feedback to save your work.';}
    </script></html>`;
  await writeFile(join(directory, 'report.html'), html, { mode: 0o600 });
  const markdown = [`# ${title}`, '', `Batch: ${manifest.batchId}. Prompt: ${manifest.frozen.promptVersion}.`, '',
    'Open report.html to review snapshots and export feedback. Acceptance rates remain pending until all assigned cases are reviewed.', '',
    '| Model | Completed | Failed | Reviewed | Accepted unchanged | Gate |', '| --- | --- | --- | --- | --- | --- |',
    ...metrics.map(m => `| ${m.model} | ${m.completed}/${m.assigned} | ${m.failed} | ${m.reviewed}/${m.assigned} | ${m.acceptanceRate === null ? 'Pending' : `${Math.round(m.acceptanceRate * 100)}%`} | ${m.readiness} |`), '',
    'Actual subscription quota consumption and billed cost are unknown. SDK token counters are available in summary.json.', '',
    '| Issue | Model | Outcome | Review |', '| --- | --- | --- | --- |',
    ...cases.map(c => `| [#${c.issue}](https://github.com/${manifest.repository}/issues/${c.issue}) | ${c.model} | ${assessmentLabel(c.run?.assessment) ?? c.run?.failure ?? c.run?.status ?? 'Not run'} | ${c.review?.verdict ?? 'Unreviewed'} |`), ''];
  await writeFile(join(directory, 'report.md'), markdown.join('\n'), { mode: 0o600 });
}
