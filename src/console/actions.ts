import { createChangeProposal } from '../change-proposal/recipe.ts';
import { eligiblePacket } from '../change-proposal/record.ts';
import type { Packet } from '../packet.ts';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, optionalJson, readJson } from '../batch-store.ts';
import { hash } from '../repository-brief/contracts.ts';
import { createPacket } from '../packet.ts';
import { githubSource } from '../inbox-source.ts';
import { LocationSource } from '../location-source.ts';
import { runNow, deliver, type DeliveryOptions } from '../delivery/runtime.ts';
import { setSchedulePaused } from '../delivery/control.ts';
import { loadJob, type ConsoleConfig } from './config.ts';
import { history, scopedJson } from './history.ts';
import { OperatorRequest, OperatorRecord } from './contracts.ts';
import { workflowEvents } from '../workflow-events.ts';
export type OperatorDependencies={ runNow?:typeof runNow; deliver?:typeof deliver; packet?:typeof createPacket; proposal?:typeof createChangeProposal;
  source?:typeof githubSource; openSource?:typeof LocationSource.open; deliveryOptions?:Partial<DeliveryOptions>; persist?:typeof atomicJson };
const at=()=>new Date().toISOString();
export class Operator {
  active?:string;
  private pending?:Promise<void>;
  private storageFailures=new Set<string>();
  constructor(readonly config:ConsoleConfig,private deps:OperatorDependencies={}) {}
  directory(id:string) { OperatorRequest.options[0].shape.requestId.parse(id); return join(this.config.stateDirectory,'operations',id); }
  async locked() {
    try { await stat(join(this.config.stateDirectory,'.action.lock'));return true; } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') return false;throw e; }
  }
  async records() {
    let entries:string[]=[];
    try { entries=(await readdir(join(this.config.stateDirectory,'operations'))).filter(n=>/^[a-f0-9-]{36}$/.test(n)).sort(); }
    catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    const records:OperatorRecord[]=[]; let invalid=0;
    for(const id of entries.slice(0,500)) try {
      const r=OperatorRecord.parse(await scopedJson(this.config.stateDirectory,`operations/${id}/operation.json`));
      if(r.workflowId!==id) throw new Error('Wrong action directory'); records.push(r);
    } catch { invalid++; }
    return { records:records.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)),invalid,truncated:entries.length>500 };
  }
  async record(id:string) {
    this.directory(id);
    const r=OperatorRecord.parse(await scopedJson(this.config.stateDirectory,`operations/${id}/operation.json`));
    if(r.workflowId!==id) throw new Error('Wrong action identity'); return r;
  }
  private async save(r:OperatorRecord) {
    const dir=this.directory(r.workflowId); OperatorRecord.parse(r);
    try {
      await (this.deps.persist??atomicJson)(join(dir,'operation.json'),r);
      await atomicJson(join(dir,'events.json'),workflowEvents(r));
    } catch(e) { this.storageFailures.add(r.workflowId); throw e; }
  }
  async submit(raw:unknown) {
    const request=OperatorRequest.parse(raw), directory=this.directory(request.requestId), file=join(directory,'operation.json');
    const previous=await optionalJson(file);
    if(previous) { const r=OperatorRecord.parse(previous); if(r.inputHash!==hash(request)) throw new Error('Action ID reused'); return r.workflowId; }
    if(this.active) throw new Error('Console worker busy');
    // This lock also excludes a second console process using the same state root.
    await mkdir(this.config.stateDirectory,{ recursive:true,mode:0o700 });
    const lock=join(this.config.stateDirectory,'.action.lock'); await mkdir(lock,{ mode:0o700 });
    let launched=false;
    try {
      const raced=await optionalJson(file);
      if(raced) { const prior=OperatorRecord.parse(raced);if(prior.inputHash!==hash(request)) throw new Error('Action ID reused');return prior.workflowId; }
      const job=await loadJob(this.config,request.jobId);
      if(job.revision!==request.revision) throw new Error('Configuration changed');
      let handoffFile:string|undefined, parentPacket:Packet|undefined;
      if(request.action==='propose') {
        if(!job.source) throw new Error('No pinned source');
        const parent=await this.record(request.parentOperationId);
        if(parent.status!=='completed'||parent.request.action!=='investigate'||parent.request.jobId!==job.id||parent.request.revision!==job.revision||parent.result?.type!=='packet') throw new Error('Invalid proposal parent');
        parentPacket=eligiblePacket(await scopedJson(this.config.stateDirectory,`operations/${parent.workflowId}/packet/packet.json`));
        if(parentPacket.packetId!==request.packetId||parent.result.workflowId!==request.packetId||hash(parentPacket)!==request.packetHash||
          hash(parentPacket.issue)!==hash(parent.snapshot)||parentPacket.issue.number!==parent.request.number||parentPacket.repository.name!==job.config.repository||
          parentPacket.repository.commit!==job.source.commit||parentPacket.repository.commit!==parent.commit) throw new Error('Parent packet changed');
        if(parentPacket.readiness!.assessment!.kind==='feature_request'?!request.query:request.query!==undefined) throw new Error('Invalid feature query');
        const identity=[job.id,job.revision,request.parentOperationId,request.packetId,request.packetHash,request.query??null];
        handoffFile=join(this.config.stateDirectory,'proposals',`${hash(identity)}.json`);
        const prior=await optionalJson(handoffFile);
        if(prior) {
          const existing=await this.record((prior as {operationId:string}).operationId),q=existing.request;
          if(q.action!=='propose'||hash([q.jobId,q.revision,q.parentOperationId,q.packetId,q.packetHash,q.query??null])!==hash(identity)) throw new Error('Proposal identity mismatch');
          return existing.workflowId;
        }
      }
      if(request.action==='investigate') {
        if(!job.source) throw new Error('No configured pinned source');
        const b=(await history(job)).briefs.find(b=>b.brief.workflowId===request.briefId);
        if(!b || b.hash!==request.briefHash || !['completed','partial'].includes(b.brief.status) ||
          !b.brief.snapshot?.collections.find(c=>c.key==='openIssues')?.items.some(i=>i.number===request.number)) throw new Error('Issue is not in the selected saved brief');
        handoffFile=join(this.config.stateDirectory,'handoffs',`${hash([job.revision,request.briefId,request.briefHash,request.number])}.json`);
        const prior=await optionalJson(handoffFile);
        if(prior) {
          const id=OperatorRequest.options[0].shape.requestId.parse((prior as { operationId?:unknown }).operationId);
          const existing=await this.record(id), q=existing.request;
          if(q.action!=='investigate'||hash([q.revision,q.briefId,q.briefHash,q.number])!==hash([request.revision,request.briefId,request.briefHash,request.number])) throw new Error('Handoff identity mismatch');
          return id;
        }
      }
      if(request.action==='retry') {
        const d=(await history(job)).deliveries.find(d=>d.record.occurrence===request.occurrence);
        if(!d||!d.configMatches||d.locked||!['prepared','rejected'].includes(d.status)||d.record.attempts.length!==request.attempts) throw new Error('Delivery is no longer retryable');
      }
      const r=OperatorRecord.parse({ schemaVersion:1,kind:'operator-action',workflowId:request.requestId,request,inputHash:hash(request),startedAt:at(),status:'running' });
      await mkdir(directory,{ recursive:true,mode:0o700 }); await this.save(r);
      if(handoffFile) await atomicJson(handoffFile,{ operationId:r.workflowId });
      this.active=r.workflowId;
      this.pending=(async()=>{
        try {
          const options={ ...this.deps.deliveryOptions,stateDirectory:job.deliveryState };
          if(request.action==='run_now') {
            const result=await (this.deps.runNow??runNow)(job.config,r.workflowId,options);
            r.result={ type:'delivery',occurrence:result.occurrence,workflowId:result.workflowId,status:result.status };
          } else if(request.action==='retry') {
            const result=await (this.deps.deliver??deliver)(job.config,request.occurrence,{ ...options,expectedAttempts:request.attempts });
            r.result={ type:'delivery',occurrence:result.occurrence,workflowId:result.workflowId,status:result.status };
          } else if(request.action==='pause'||request.action==='resume') {
            const c=await setSchedulePaused(job.deliveryState,job.config.jobId,request.action==='pause');
            r.result={ type:'schedule',paused:c.paused };
          } else if(request.action==='propose') {
            const proposal=await (this.deps.proposal??createChangeProposal)(parentPacket!,{directory:join(directory,'proposal'),provider:job.config.provider,
              checkout:job.source!.checkout,query:request.query,signal:AbortSignal.timeout(240000)});
            r.result={type:'proposal',workflowId:proposal.workflowId,status:proposal.status};
          } else {
            const signal=AbortSignal.timeout(300000);
            await (this.deps.openSource??LocationSource.open.bind(LocationSource))(job.source!.checkout,job.config.repository,job.source!.commit,signal);
            r.commit=job.source!.commit; await this.save(r);
            const observation=await (this.deps.source??githubSource).get(job.config.repository,request.number,signal);
            if(observation.number!==request.number) throw new Error('Source issue mismatch');
            if(observation.state!=='open'||!observation.snapshot) r.result={ type:'skipped',reason:observation.state!=='open'?'closed':'invalid_snapshot' };
            else {
              if(observation.snapshot.repository!==job.config.repository||observation.snapshot.number!==request.number) throw new Error('Snapshot scope mismatch');
              r.snapshot=observation.snapshot; await this.save(r);
              const packet=await (this.deps.packet??createPacket)(r.snapshot,{ directory:join(directory,'packet'),checkout:job.source!.checkout,
                commit:job.source!.commit,provider:job.config.provider,signal });
              await atomicJson(join(directory,'packet','events.json'),workflowEvents(packet));
              r.result={ type:'packet',workflowId:packet.packetId,status:packet.status };
            }
          }
          r.status='completed';r.finishedAt=at();await this.save(r);
        } catch {
          // A checkpoint failure must leave the last durable state authoritative.
          // Do not overwrite it with a fabricated failure when the effect is unknown.
          if(this.storageFailures.has(r.workflowId)) return;
          const saved=OperatorRecord.parse(await readJson(file));
          if(saved.status==='running') { saved.status='failed';saved.failure='operation_failed';saved.finishedAt=at();await this.save(saved); }
        }
      })().catch(()=>{}).finally(async()=>{ this.active=undefined; this.storageFailures.delete(r.workflowId); await rm(lock,{ recursive:true }); }).catch(()=>{});
      launched=true; return r.workflowId;
    } finally { if(!launched) { this.storageFailures.delete(request.requestId);await rm(lock,{ recursive:true }); } }
  }
  async idle() { await this.pending; }
}
