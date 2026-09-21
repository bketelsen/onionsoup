import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Verification} from './contracts.ts';
const env=()=>Object.fromEntries(Object.entries({PATH:'/usr/bin:/bin',HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}).filter((e):e is [string,string]=>typeof e[1]==='string'));
const command=async(args:string[])=> (await promisify(execFile)('/usr/bin/podman',args,{timeout:15000,maxBuffer:100000,env:env()})).stdout;
export async function runContainer(args:string[],directory:string,containerName:string,limits:{outputBytes:number;wallMs:number},signal?:AbortSignal) {
  let out=Buffer.alloc(0),err=Buffer.alloc(0),bytes=0,stop:Verification['status']|undefined,exitCode:number|null=null,stopping:Promise<unknown>|undefined;
  const child=spawn('/usr/bin/podman',args,{cwd:directory,env:env(),stdio:['ignore','pipe','pipe']});
  const terminate=(reason:Verification['status'])=>{if(stop)return;stop=reason;stopping=command(['rm','--force','--time','0',containerName]).catch(()=>{}).finally(()=>child.kill('SIGKILL'));};
  const collect=(b:Buffer,stdout:boolean)=>{bytes+=b.length;if(bytes>limits.outputBytes)terminate('output_limit');if(stdout)out=Buffer.concat([out,b]).subarray(0,limits.outputBytes);else err=Buffer.concat([err,b]).subarray(0,limits.outputBytes);};
  child.stdout.on('data',b=>collect(b,true));child.stderr.on('data',b=>collect(b,false));
  const abort=()=>terminate('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>terminate('timeout'),limits.wallMs);
  await new Promise<void>(resolve=>{child.once('error',()=>{stop='execution_error';resolve();});child.once('close',c=>{exitCode=c;resolve();});});
  clearTimeout(timer);signal?.removeEventListener('abort',abort);await stopping;
  let cleanup:Verification['cleanup']='removed';try{await command(['rm','--force','--time','0','--ignore',containerName]);}catch{cleanup='failed';}

  return {out,err,bytes,stop,exitCode,cleanup};
}
