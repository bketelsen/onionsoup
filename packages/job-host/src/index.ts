import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';

export const HOST_LIMITS = { inputBytes: 32768, resultBytes: 8*1024*1024, ledgerBytes: 32*1024*1024, jobs: 500, queue: 16 } as const;
const Id = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const Status = z.enum(['queued','running','completed','failed','cancelled','interrupted']);
export const JobRequest = z.object({ capability: Id, input: z.json(), idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  correlationId: z.uuid().optional(), parentJobId: z.uuid().optional() }).strict();
export type JobRequest = z.infer<typeof JobRequest>;
const Event = z.object({ sequence: z.number().int().positive(), at: z.iso.datetime(), status: Status }).strict();
const Job = z.object({ schemaVersion:z.literal(1), jobId:z.uuid(), owner:Id, capability:Id, version:Id, binding:z.string().length(64),
  input:z.json(), inputHash:z.string().length(64), idempotencyKey:JobRequest.shape.idempotencyKey,
  correlationId:z.uuid().optional(), parentJobId:z.uuid().optional(), createdAt:z.iso.datetime(), status:Status,
  events:z.array(Event).min(1).max(5), resultHash:z.string().length(64).optional() }).strict();
export type Job = z.infer<typeof Job>;
export type JobView = Job & { result?: unknown };
export const Invoker = z.object({ id:Id, tokenHash:z.string().regex(/^[a-f0-9]{64}$/), capabilities:z.array(Id).min(1).max(20), maxJobs:z.number().int().min(1).max(HOST_LIMITS.jobs) }).strict();
export type Invoker = z.infer<typeof Invoker>;
export type Capability = { id:string; version:string; description:string; input:z.ZodType; output:z.ZodType;
  validateOutput?:(value:unknown)=>unknown;
  metadata:unknown; effects:string[]; timeoutMs:number;
  execute:(input:any, context:{ directory:string; signal:AbortSignal; job:Job; dependency:(id:string)=>Promise<JobView> })=>Promise<unknown> };
export class HostError extends Error { constructor(readonly code:string, readonly status=400){super(code);} }
const canonical = (v:any):any => Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest = (v:unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const tokenHash = (token:string) => createHash('sha256').update(token).digest('hex');
const stamp = () => new Date().toISOString();
async function boundedJson(root:string,relative:string,limit:number){
  const expected=join(await realpath(root),relative),actual=await realpath(join(root,relative));
  if(actual!==expected)throw new HostError('invalid_artifact');
  const file=await open(actual,'r');try{if(!(await file.stat()).isFile())throw new HostError('invalid_artifact');
    const buffer=Buffer.alloc(limit+1);let n=0;
    while(n<buffer.length){const {bytesRead}=await file.read(buffer,n,buffer.length-n,n);if(!bytesRead)break;n+=bytesRead;}
    if(n>limit)throw new HostError('artifact_too_large');return JSON.parse(buffer.subarray(0,n).toString());
  }finally{await file.close();}
}

export async function openJobHost(options:{ directory:string; binding:unknown; capabilities:Capability[]; invokers:Invoker[]; persist?:typeof atomicJson }){
  const root=resolve(options.directory), capabilities=new Map(options.capabilities.map(c=>[Id.parse(c.id),c]));
  const invokers=z.array(Invoker).min(1).max(20).parse(options.invokers);
  if(capabilities.size!==options.capabilities.length||new Set(invokers.map(i=>i.id)).size!==invokers.length||new Set(invokers.map(i=>i.tokenHash)).size!==invokers.length)throw new HostError('duplicate_registration');
  for(const c of capabilities.values()){Id.parse(c.version);z.number().int().min(1).max(600000).parse(c.timeoutMs);}
  if(invokers.some(i=>i.capabilities.some(c=>!capabilities.has(c))))throw new HostError('unknown_grant');
  const binding=digest({protocol:'job-host-v1',configuration:options.binding,invokers:invokers.map(({tokenHash,...i})=>i),
    capabilities:[...capabilities.values()].map(c=>({id:c.id,version:c.version,input:z.toJSONSchema(c.input),output:z.toJSONSchema(c.output),metadata:c.metadata,effects:c.effects,timeoutMs:c.timeoutMs}))});
  const Ledger=z.object({schemaVersion:z.literal(1),binding:z.literal(binding),jobs:z.array(Job).max(HOST_LIMITS.jobs)}).strict();
  await mkdir(root,{recursive:true,mode:0o700});const lock=join(root,'.host-lock');await mkdir(lock,{mode:0o700});
  let ledger:z.infer<typeof Ledger>={schemaVersion:1,binding,jobs:[]}, broken=false,stopped=false,closed=false;
  let serial:Promise<unknown>=Promise.resolve(),draining:Promise<void>|undefined;
  const controllers=new Map<string,AbortController>();
  const exclusive=<T>(fn:()=>Promise<T>)=>{const p=serial.then(fn);serial=p.catch(()=>{});return p;};
  const save=async()=>{try{const checked=Ledger.parse(ledger);if(Buffer.byteLength(JSON.stringify(checked))>HOST_LIMITS.ledgerBytes)throw Error();await(options.persist??atomicJson)(join(root,'ledger.json'),checked);}catch{broken=true;for(const c of controllers.values())c.abort();throw new HostError('persistence_failed',503);}};
  const transition=(job:Job,status:Job['status'])=>{job.status=status;job.events.push({sequence:job.events.length+1,at:stamp(),status});};
  try{
    await atomicJson(join(lock,'owner.json'),{pid:process.pid,at:stamp()});
    try{ledger=Ledger.parse(await boundedJson(root,'ledger.json',HOST_LIMITS.ledgerBytes));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const ids=new Set<string>(),keys=new Set<string>();
    for(const j of ledger.jobs){const c=capabilities.get(j.capability),owner=invokers.find(i=>i.id===j.owner),key=j.owner+':'+j.idempotencyKey;
      if(ids.has(j.jobId)||keys.has(key)||j.binding!==binding||!c||j.version!==c.version||!owner?.capabilities.includes(j.capability)||digest(j.input)!==j.inputHash||j.events.at(-1)?.status!==j.status||j.events.some((e,n)=>e.sequence!==n+1)||j.status==='completed'&&!j.resultHash)throw new HostError('invalid_ledger');
      c.input.parse(j.input);ids.add(j.jobId);keys.add(key);
      if(j.status==='running'||j.status==='queued')transition(j,'interrupted');
    }
    await save();
  }catch(e){await rm(lock,{recursive:true,force:true});throw e;}
  const owner=(id:string)=>{const p=invokers.find(i=>i.id===id);if(!p)throw new HostError('unauthorized',401);return p;};
  async function inspect(principal:string,id:string):Promise<JobView>{
    z.uuid().parse(id);owner(principal);const job=ledger.jobs.find(j=>j.jobId===id&&j.owner===principal);
    if(!job)throw new HostError('job_not_found',404);const view=structuredClone(job);
    if(view.status==='completed'){
      const result=await boundedJson(root,join(id,'result.json'),HOST_LIMITS.resultBytes);
      if(digest(result)!==view.resultHash)throw new HostError('result_mismatch',409);
      const c=capabilities.get(job.capability)!;return {...view,result:c.validateOutput?c.validateOutput(c.output.parse(result)):c.output.parse(result)};
    }return view;
  }
  function start(){
    if(draining||stopped||broken)return;
    draining=(async()=>{while(!stopped&&!broken){
      const job=await exclusive(async()=>{if(stopped||broken)return;const j=ledger.jobs.find(j=>j.status==='queued');if(!j)return;controllers.set(j.jobId,new AbortController());transition(j,'running');await save();return j;});
      if(!job)break;const c=capabilities.get(job.capability)!,controller=controllers.get(job.jobId)!;if(stopped)controller.abort();
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(c.timeoutMs)]);let status:Job['status']='failed',resultHash:string|undefined;
      try{
        signal.throwIfAborted();const directory=join(root,job.jobId);await mkdir(directory,{mode:0o700});
        let result=c.output.parse(JSON.parse(JSON.stringify(await c.execute(structuredClone(job.input),{directory,signal,job:structuredClone(job),dependency:async id=>{
          const dependency=await inspect(job.owner,id);if(dependency.status!=='completed')throw new HostError('dependency_unavailable');return dependency;
        }}))));if(c.validateOutput)result=c.validateOutput(result);signal.throwIfAborted();z.json().parse(result);
        if(Buffer.byteLength(JSON.stringify(result))>HOST_LIMITS.resultBytes)throw new HostError('result_too_large');
        try{await(options.persist??atomicJson)(join(directory,'result.json'),result);}catch{broken=true;throw new HostError('persistence_failed');}
        resultHash=digest(result);status='completed';
      }catch{status=signal.aborted?'cancelled':'failed';}
      controllers.delete(job.jobId);
      await exclusive(async()=>{if(resultHash)job.resultHash=resultHash;transition(job,status);await save();});
    }})().catch(()=>{broken=true;}).finally(()=>{draining=undefined;if(!stopped&&!broken&&ledger.jobs.some(j=>j.status==='queued'))start();});
  }
  return {
    authenticate(token:string){const h=Buffer.from(tokenHash(token),'hex');const found=invokers.find(i=>timingSafeEqual(h,Buffer.from(i.tokenHash,'hex')));if(!found)throw new HostError('unauthorized',401);return found.id;},
    discover(principal:string){const p=owner(principal);return {schemaVersion:1,binding,invoker:p.id,remainingAdmissions:p.maxJobs-ledger.jobs.filter(j=>j.owner===p.id).length,
      capabilities:[...capabilities.values()].filter(c=>p.capabilities.includes(c.id)).map(c=>({id:c.id,version:c.version,description:c.description,inputSchema:z.toJSONSchema(c.input),outputSchema:z.toJSONSchema(c.output),metadata:c.metadata,effects:c.effects,timeoutMs:c.timeoutMs})),limits:HOST_LIMITS,lifecycle:{automaticReplay:false,concurrency:1}};},
    async submit(principal:string,raw:unknown){return exclusive(async()=>{
      if(stopped||broken)throw new HostError('host_unavailable',503);const p=owner(principal),r=JobRequest.parse(raw),c=capabilities.get(r.capability);
      if(!c||!p.capabilities.includes(r.capability))throw new HostError('capability_not_allowed',403);
      const input=z.json().parse(c.input.parse(r.input));if(Buffer.byteLength(JSON.stringify(input))>HOST_LIMITS.inputBytes)throw new HostError('input_too_large',413);
      const prior=ledger.jobs.find(j=>j.owner===principal&&j.idempotencyKey===r.idempotencyKey);
      if(prior){if(prior.capability!==r.capability||prior.inputHash!==digest(input)||prior.correlationId!==r.correlationId||prior.parentJobId!==r.parentJobId)throw new HostError('idempotency_conflict',409);return {jobId:prior.jobId,reused:true};}
      if(r.parentJobId)await inspect(principal,r.parentJobId);
      if(ledger.jobs.length>=HOST_LIMITS.jobs||ledger.jobs.filter(j=>j.owner===principal).length>=p.maxJobs)throw new HostError('admission_limit',429);
      if(ledger.jobs.filter(j=>j.status==='queued'||j.status==='running').length>=HOST_LIMITS.queue)throw new HostError('queue_full',429);
      const job:Job={schemaVersion:1,jobId:randomUUID(),owner:principal,capability:c.id,version:c.version,binding,input,inputHash:digest(input),idempotencyKey:r.idempotencyKey,
        ...(r.correlationId?{correlationId:r.correlationId}:{}),...(r.parentJobId?{parentJobId:r.parentJobId}:{}),createdAt:stamp(),status:'queued',events:[{sequence:1,at:stamp(),status:'queued'}]};
      ledger.jobs.push(job);await save();queueMicrotask(start);return {jobId:job.jobId,reused:false};
    });},
    inspect,
    async cancel(principal:string,id:string){return exclusive(async()=>{const j=await inspect(principal,id);if(j.status==='queued'){transition(ledger.jobs.find(j=>j.jobId===id)!,'cancelled');await save();}else if(j.status==='running')controllers.get(id)?.abort();return {jobId:id,status:j.status==='running'?'cancellation_requested':j.status==='queued'?'cancelled':j.status};});},
    async close(){if(closed)return;stopped=true;for(const c of controllers.values())c.abort();await draining;await exclusive(async()=>{for(const j of ledger.jobs)if(j.status==='queued')transition(j,'interrupted');if(!broken)await save();});closed=true;await rm(lock,{recursive:true});},
  };
}
export type JobHost = Awaited<ReturnType<typeof openJobHost>>;
async function body(req:IncomingMessage){let n=0;const chunks:Buffer[]=[];for await(const chunk of req){n+=chunk.length;if(n>HOST_LIMITS.inputBytes+2048)throw new HostError('input_too_large',413);chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
export async function listenJobHost(host:JobHost,port=0){
  const server=createServer(async(req,res)=>{try{
    if(req.headers.origin)throw new HostError('browser_origin_denied',403);
    const authorization=req.headers.authorization??'';if(!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))throw new HostError('unauthorized',401);
    const principal=host.authenticate(authorization.slice(7));let result:unknown;
    if(req.method==='GET'&&req.url==='/v1/capabilities')result=host.discover(principal);
    else if(req.method==='POST'&&req.url==='/v1/jobs'){if(req.headers['content-type']!=='application/json')throw new HostError('json_required',415);result=await host.submit(principal,await body(req));res.statusCode=202;}
    else {const match=/^\/v1\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(req.url??'');if(!match)throw new HostError('not_found',404);
      if(req.method==='GET'&&!match[2])result=await host.inspect(principal,match[1]);else if(req.method==='POST'&&match[2])result=await host.cancel(principal,match[1]);else throw new HostError('not_found',404);}
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(result));
  }catch(e){res.statusCode=e instanceof HostError?e.status:400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e instanceof HostError?e.code:'invalid_request'}));}});
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=32;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address() as {port:number};return {url:`http://127.0.0.1:${address.port}`,async close(){server.closeIdleConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await host.close();}};
}
