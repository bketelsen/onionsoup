import {fixtureHistory,fixtureId} from '../fixture-runner/console.ts';
import {fixtureHtml,fixtureMarkdown} from '../fixture-runner/render.ts';
import {escapeHtml} from '../batch-report.ts';
import { validateChangeWorkflow } from '../change-proposal/record.ts';
import { proposalMarkdown } from '../change-proposal/render.ts';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { hash } from '../repository-brief/contracts.ts';
import { Operator } from './actions.ts';
import { loadJob } from './config.ts';
import { history, scopedRead, scopedJson } from './history.ts';
import { dashboard, briefPage, page, operationPage, activityPage } from './view.ts';
import { repositoryBriefHtml, repositoryBriefMarkdown } from '../repository-brief/render.ts';
import { workflowEvents } from '../workflow-events.ts';
import { renderInbox } from '../inbox-report.ts';
import { packetMarkdown, validatePacket } from '../packet.ts';
export function consoleServer(operator:Operator) {
  const token=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    const address=server.address();
    const origin=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`;
    const headers=(type='text/html; charset=utf-8')=>{
      res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${token}'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'`);
    };
    const send=(body:string|Buffer,type?:string)=>{ headers(type);res.end(body); };
    const json=(raw:unknown)=>send(JSON.stringify(raw,null,2)+'\n','application/json; charset=utf-8');
    try {
      if(req.headers.host!==origin.slice(7)||req.headers['sec-fetch-site']==='cross-site') { res.statusCode=403;send('Local origin required.','text/plain');return; }
      const url=new URL(req.url??'/',origin), parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if(req.method==='POST'&&url.pathname==='/actions') {
        if(req.headers.origin!==origin || req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded') throw new Error('Invalid origin or content type');
        let bytes=0,body='';for await(const chunk of req) { bytes+=chunk.length;if(bytes>8192) throw new Error('Body too large');body+=chunk.toString(); }
        const params=new URLSearchParams(body);if(new Set(params.keys()).size!==[...params.keys()].length) throw new Error('Duplicate fields');
        const supplied=params.get('csrf')??'';
        if(supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) throw new Error('Invalid CSRF');
        params.delete('csrf'); const raw:Record<string,unknown>=Object.fromEntries(params);
        for(const field of ['attempts','number']) if(field in raw) { if(!/^\d+$/.test(String(raw[field]))) throw new Error('Invalid number');raw[field]=Number(raw[field]); }
        const id=await operator.submit(raw);res.statusCode=303;res.setHeader('Location',`/operations/${id}`);send('Action recorded.','text/plain');return;
      }
      if(req.method!=='GET') { res.statusCode=405;send('Method not allowed.','text/plain');return; }
      if(url.pathname==='/') { send(await dashboard(operator,token));return; }
      if(parts[0]==='fixtures'&&parts.length<=3) {
        const h=await fixtureHistory(operator.config.fixtureRoots);
        if(parts.length===1) {send(page('Fixture trials',`<h1>Owned fixture trials</h1><p>Saved baseline checks, scoped candidates and independent model review. Publication is not authorized. Launches use the configured CLI, not browser-supplied paths or commands.</p>
          ${h.invalid||h.truncated?'<p class="warn">Some records are unavailable or this bounded view is incomplete.</p>':''}
          ${h.entries.map(({record:r})=>`<article><h2>${r.case} · ${r.mode}</h2><p>${escapeHtml(r.outcome??'unfinished; outcome unknown')}</p><p>${escapeHtml(r.startedAt)}</p><a href="/fixtures/${r.workflowId}">Inspect trial</a></article>`).join('')||'<p>No saved fixture trials configured.</p>'}`));return;}
        const id=fixtureId(parts[1]),entry=h.entries.find(e=>e.record.workflowId===id);
        if(entry) {
          const r=entry.record,base=`/fixtures/${id}`;
          if(parts.length===2) {send(page('Fixture trial',`<h1>Fixture evidence</h1><p><a href="${base}/json">Saved record</a> · <a href="${base}/markdown">Markdown</a> · <a href="${base}/events">Trace</a> · <a href="${base}/diff">Candidate diff</a></p>${fixtureHtml(r)}`));return;}
          if(parts[2]==='json') {json(r);return;}
          if(parts[2]==='events') {json(workflowEvents(r));return;}
          if(parts[2]==='markdown') {send(fixtureMarkdown(r),'text/plain; charset=utf-8');return;}
          if(parts[2]==='diff') {send(r.diff??'No candidate diff.','text/plain; charset=utf-8');return;}
        }
      }
      if(url.pathname==='/operations') { send(await activityPage(operator));return; }
      if(parts[0]==='operations'&&parts[1]&&parts.length<=3) {
        const r=await operator.record(parts[1]);
        if(parts[2]==='events') { json(workflowEvents(r));return; }
        let packet;
        try { packet=validatePacket(await scopedJson(operator.config.stateDirectory,`operations/${r.workflowId}/packet/packet.json`));
          if(r.request.action!=='investigate'||packet.issue.number!==r.request.number||packet.repository.commit!==r.commit||hash(packet.issue)!==hash(r.snapshot)||r.result?.type==='packet'&&r.result.workflowId!==packet.packetId) throw new Error('Packet binding mismatch');
        } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
        let proposal;
        if(r.request.action==='propose') {
          try {
            proposal=validateChangeWorkflow(await scopedJson(operator.config.stateDirectory,`operations/${r.workflowId}/proposal/proposal.json`));
            if(proposal.parent.packetId!==r.request.packetId||proposal.parentHash!==r.request.packetHash||proposal.query!==r.request.query||
              r.result?.type==='proposal'&&r.result.workflowId!==proposal.workflowId) throw new Error('Proposal binding mismatch');
          } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
        }
        if(!parts[2]) { send(operationPage(r,operator.active===r.workflowId,packet,{job:await loadJob(operator.config,r.request.jobId),token,busy:!!operator.active||await operator.locked()},proposal));return; }
        if(proposal&&parts[2]==='proposal.json') {json(proposal);return;}
        if(proposal&&parts[2]==='proposal.md') {send(proposalMarkdown(proposal),'text/plain; charset=utf-8');return;}
        if(proposal&&parts[2]==='proposal.events') {json(workflowEvents(proposal));return;}
        if(packet&&parts[2]==='packet.json') { json(packet);return; }
        if(packet&&parts[2]==='packet.md') { send(packetMarkdown(packet),'text/plain; charset=utf-8');return; }
        if(packet&&parts[2]==='packet.events') { json(workflowEvents(packet));return; }
      }
      if(parts[0]==='briefs'&&parts.length>=3&&parts.length<=4) {
        const job=await loadJob(operator.config,parts[1]), entry=(await history(job)).briefs.find(b=>b.brief.workflowId===parts[2]);
        if(entry) {
          if(!parts[3]) { send(await briefPage(operator,job,entry,token));return; }
          if(parts[3]==='report') {
            const base=`/briefs/${job.id}/${entry.brief.workflowId}`;
            send(repositoryBriefHtml(entry.brief).replaceAll('href="repository-brief.md"',`href="${base}/markdown"`).replaceAll('href="repository-brief.json"',`href="${base}/json"`).replaceAll('href="events.json"',`href="${base}/events"`));return;
          }
          if(parts[3]==='markdown') { send(repositoryBriefMarkdown(entry.brief),'text/plain; charset=utf-8');return; }
          if(parts[3]==='json') { json(entry.brief);return; }
          if(parts[3]==='events') { json(workflowEvents(entry.brief));return; }
        }
      }
      if(parts[0]==='deliveries'&&parts.length===4&&parts[3]==='events') {
        const job=await loadJob(operator.config,parts[1]), d=(await history(job)).deliveries.find(d=>d.record.occurrence===parts[2]);
        if(d) { json(workflowEvents(d.record));return; }
      }
      if(parts[0]==='issues'&&parts.length>=3&&parts.length<=4) {
        const job=await loadJob(operator.config,parts[1]);if(!job.inboxDirectory) throw new Error('No issue inbox configured');
        if(parts.length===3&&parts[2]==='index.html') {
          await renderInbox(job.inboxDirectory);
          const html=(await scopedRead(job.inboxDirectory,'index.html')).toString('utf8');
          send(html.replace('<main>','<main><p><a href="/">← Repository briefs and automation</a></p>').replaceAll('<script>',`<script nonce="${token}">`));return;
        }
        if(parts.length===4&&['records','locations'].includes(parts[2])&&/^[a-zA-Z0-9_.-]+\.json$/.test(parts[3])) {
          json(await scopedJson(job.inboxDirectory,join(parts[2],parts[3])));return;
        }
      }
      res.statusCode=404;send(page('Not found','<h1>Not found</h1><p>This artifact is not available in the configured workspace.</p>'));
    } catch {
      res.statusCode=req.method==='POST'?409:400;
      send(page('Action unavailable','<h1>Unable to complete this request</h1><p>The worker may be busy, the page may be stale, or an artifact/configuration may be unavailable. Reload the workspace and inspect activity before retrying.</p>'));
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
