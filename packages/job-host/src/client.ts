import { setTimeout as delay } from 'node:timers/promises';
import { HOST_LIMITS, HostError, type JobRequest, type JobView } from './index.ts';
export function createJobClient(options:{url:string;token:string}){
  const base=new URL(options.url);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new HostError('local_host_required');
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(options.token))throw new HostError('invalid_token');
  const request=async(method:string,path:string,input?:unknown,signal?:AbortSignal)=>{
    const r=await fetch(new URL(path,base),{method,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),headers:{Authorization:`Bearer ${options.token}`,'Content-Type':'application/json'},...(input!==undefined?{body:JSON.stringify(input)}:{})});
    const chunks:Uint8Array[]=[];let n=0;const reader=r.body!.getReader();try{while(true){const chunk=await reader.read();if(chunk.done)break;n+=chunk.value.length;if(n>HOST_LIMITS.resultBytes+262144)throw new HostError('response_limit');chunks.push(chunk.value);}}finally{await reader.cancel();}
    const result=JSON.parse(Buffer.concat(chunks).toString());if(!r.ok)throw new HostError('host_request_rejected',r.status);return result;
  };
  const inspect=(id:string,signal?:AbortSignal):Promise<JobView>=>request('GET',`/v1/jobs/${encodeURIComponent(id)}`,undefined,signal);
  return {discover:(signal?:AbortSignal)=>request('GET','/v1/capabilities',undefined,signal),
    submit:(input:JobRequest,signal?:AbortSignal):Promise<{jobId:string;reused:boolean}>=>request('POST','/v1/jobs',input,signal),inspect,
    cancel:(id:string,signal?:AbortSignal)=>request('POST',`/v1/jobs/${encodeURIComponent(id)}/cancel`,{},signal),
    async wait(id:string,signal?:AbortSignal){for(let n=0;n<620;n++){const job=await inspect(id,signal);if(!['queued','running'].includes(job.status))return job;await delay(1000,undefined,{signal});}throw new HostError('wait_limit');},
  };
}
export type JobClient = ReturnType<typeof createJobClient>;
