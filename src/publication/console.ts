import {readdir} from 'node:fs/promises';
import {z} from 'zod';
import {escapeHtml as e} from '../batch-report.ts';
import {hash} from '../repository-brief/contracts.ts';
import {scopedJson} from '../console/history.ts';
import {Digest} from '../fixture-runner/contracts.ts';
import {validateBundle,validateState,type PublicationConfig} from './contracts.ts';
import {loadPublicationConfig,loadBundle,loadState} from './bundle.ts';
import {approvePublication,publish} from './runtime.ts';
import type {PublisherTransport} from './github.ts';
export const PublicationAction=z.object({action:z.enum(['approve','publish']),id:Digest,bundleHash:Digest}).strict();
export async function publicationHistory(c:PublicationConfig) {
  let names:string[]=[];try {names=(await readdir(c.stateDirectory,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^[a-f0-9]{64}$/.test(e.name)).map(e=>e.name).sort();}
  catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;}
  const entries=[];let invalid=0;
  for(const id of names.slice(0,300))try {
    const b=validateBundle(await scopedJson(c.stateDirectory,id+'/bundle.json')),s=validateState(await scopedJson(c.stateDirectory,id+'/state.json'),b);
    if(b.publicationId!==id)throw new Error('Identity mismatch');entries.push({bundle:b,state:s});
  }catch{invalid++;}
  return {entries,invalid,truncated:names.length>300};
}
export class PublicationOperator {
  active?:string;private pending?:Promise<unknown>;
  constructor(readonly configFile:string,private transport?:PublisherTransport){}
  async config(){return loadPublicationConfig(this.configFile);}
  async submit(raw:unknown) {
    const a=PublicationAction.parse(raw);if(this.active)throw new Error('Publisher busy');
    // Reserve this worker before asynchronous configuration reads.
    this.active=a.id;
    try {
      const c=await this.config(),b=await loadBundle(c,a.id);if(hash(b)!==a.bundleHash)throw new Error('Bundle changed');
      if(a.action==='approve') {await approvePublication(c,a.id,a.bundleHash,{authority:'console_operator',reason:'Operator approved this exact saved bundle in the local console.'});this.active=undefined;}
      else {
        const s=await loadState(c,b);if(!s.approval)throw new Error('Approval required');
        this.pending=publish(c,a.id,a.bundleHash,{transport:this.transport}).catch(()=>{}).finally(()=>{this.active=undefined;});
      }
      return a.id;
    }catch(err){this.active=undefined;throw err;}
  }
  async idle(){await this.pending;}
}
export function publicationHtml(entry:Awaited<ReturnType<typeof publicationHistory>>['entries'][number],token:string,busy:boolean,config:PublicationConfig) {
  const {bundle:b,state:s}=entry;
  const form=(action:string,label:string)=>`<form method="post" action="/publication-actions"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${b.publicationId}"><input type="hidden" name="bundleHash" value="${hash(b)}"><button ${busy?'disabled':''}>${label}</button></form>`;
  const current=b.configHash===hash(config);
  return `<h1>${e(b.title)}</h1><p>Status: <strong>${e(s.status)}</strong>${busy?' · publisher busy':''}</p>
    <p>Target: ${e(b.target.repository)} · ${e(b.target.baseBranch)} → ${e(b.branch)}</p>
    <p>Base: <code>${b.target.baseCommit}</code><br>Head: <code>${b.headCommit}</code><br>Bundle: <code>${hash(b)}</code></p>
    <p>Baseline: ${b.fixture.baseline!.status} · Candidate: ${b.fixture.candidate!.status} · separate-context model review: no blocking findings.</p>
    <p><a href="/fixtures/${b.fixture.workflowId}">Source fixture evidence</a> · <a href="/publications/${b.publicationId}/json">Bundle and state</a> · <a href="/publications/${b.publicationId}/events">Events</a></p>
    ${s.pull?`<p>Observed PR: <a href="${e(s.pull.url)}">#${s.pull.number}</a> (${s.pull.state}, ${s.pull.draft?'draft':'not draft'}). Check status above for binding conflicts.</p>`:''}
    ${!current?'<p class="warn">Configuration changed. This bundle cannot authorize new effects.</p>':''}
    <h2>Exact candidate diff</h2><pre>${e(b.diff)}</pre><h2>Exact draft PR body</h2><pre>${e(b.body)}</pre>
    <h2>Publication authority</h2><p>${s.approval?e(s.approval.authority)+' · '+e(s.approval.reason)+' · expires '+e(s.approval.expiresAt):'Approval not recorded.'}</p>
    <p>Approval covers only this bundle. Publish creates a branch and draft PR; it does not merge. Unknown creation outcomes are reconciled without another create request.</p>
    ${current&&['prepared','approved'].includes(s.status)?form('approve',s.approval?'Renew approval for this exact bundle':'Approve this exact bundle'):''}
    ${current&&s.approval&&s.status!=='blocked'?form('publish',s.status==='approved'?'Publish approved draft':'Reconcile publication'):''}
    <h2>Journal</h2><ul>${s.events.map(event=>`<li>${e(event.at)} · ${event.type} · ${event.reason??''}</li>`).join('')}</ul>`;
}
