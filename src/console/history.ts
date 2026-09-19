import { readdir, realpath, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeliveryRecord, deliveryStatus, occurrenceId } from '../delivery/contracts.ts';
import { hash } from '../repository-brief/contracts.ts';
import { validateRepositoryBrief, type RepositoryBrief } from '../repository-brief/record.ts';
import type { Job } from './config.ts';
const execute=promisify(execFile);
export async function scopedRead(root:string,file:string) {
  const base=await realpath(root), target=await realpath(join(base,file)), rel=relative(base,target);
  if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)) throw new Error('Artifact escaped its configured root');
  const bytes=await readFile(target); if(bytes.length>30*1024*1024) throw new Error('Artifact too large'); return bytes;
}
export const scopedJson=async(root:string,file:string):Promise<unknown>=>JSON.parse((await scopedRead(root,file)).toString('utf8'));
export type BriefEntry={ brief:RepositoryBrief;hash:string };
export type DeliveryEntry={ record:DeliveryRecord; status:ReturnType<typeof deliveryStatus>;configMatches:boolean;locked:boolean };
export async function history(job:Job) {
  const briefs=new Map<string,BriefEntry>(), conflicts=new Set<string>(), deliveries:DeliveryEntry[]=[];
  let invalid=0,truncated=false;
  const add=(raw:unknown)=>{
    const b=validateRepositoryBrief(raw); if(b.request.repository!==job.config.repository) return;
    const h=hash(b), previous=briefs.get(b.workflowId);
    if(previous && previous.hash!==h) { conflicts.add(b.workflowId); briefs.delete(b.workflowId); invalid++; }
    else if(!conflicts.has(b.workflowId)) briefs.set(b.workflowId,{ brief:b,hash:h });
  };
  const dirs=async(root:string)=>{
    try { const entries=(await readdir(root,{ withFileTypes:true })).filter(e=>e.isDirectory()&&!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name));
      if(entries.length>300) truncated=true; return entries.slice(0,300).map(e=>e.name); }
    catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') invalid++; return []; }
  };
  for(const root of job.briefRoots) for(const name of await dirs(root)) {
    try { add(await scopedJson(root,`${name}/repository-brief.json`)); } catch { invalid++; }
  }
  for(const name of (await dirs(job.deliveryState)).filter(n=>/^[a-f0-9]{64}$/.test(n))) {
    try {
      const r=DeliveryRecord.parse(await scopedJson(job.deliveryState,`${name}/delivery.json`));
      if(r.jobId!==job.config.jobId) continue;
      if(name!==occurrenceId(job.config,r.occurrence) || r.request.repository!==job.config.repository) throw new Error('Wrong delivery identity');
      const directory=join(job.deliveryState,name);
      const locked=(await readdir(directory)).includes('.lock');
      deliveries.push({ record:r,status:deliveryStatus(r),configMatches:r.configHash===hash(job.config),locked });
      try {
        const b=await scopedJson(job.deliveryState,`${name}/${r.brief?'brief.json':'analysis/repository-brief.json'}`);
        if(r.brief && (hash(validateRepositoryBrief(b))!==r.brief.hash || validateRepositoryBrief(b).workflowId!==r.brief.workflowId)) throw new Error('Frozen brief mismatch');
        add(b);
      } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') invalid++; }
    } catch { invalid++; }
  }
  return { briefs:[...briefs.values()].sort((a,b)=>b.brief.startedAt.localeCompare(a.brief.startedAt)),
    deliveries:deliveries.sort((a,b)=>b.record.createdAt.localeCompare(a.record.createdAt)),invalid,truncated };
}
export async function timerStatus(job:Job) {
  if(!job.timerUnit) return 'unconfigured';
  try { const { stdout }=await execute('systemctl',['--user','show',job.timerUnit,'--property=ActiveState','--value'],{ timeout:3000,maxBuffer:4096 });
    return stdout.trim()==='active'?'active':'inactive'; } catch { return 'unavailable'; }
}
