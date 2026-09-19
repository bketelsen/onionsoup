import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '../repository-brief/contracts.ts';
import {atomicJson} from '../batch-store.ts';
import {Runtime} from '../fixture-runner/contracts.ts';
import {validateRuntime} from '../fixture-runner/sandbox.ts';
import {git} from '../fixture-runner/fixture.ts';
import {Dependency,Verification,validateJob,PROFILE_LIMITS as L,type Job} from './contracts.ts';
import {snapshot,treeDigest,byteHash} from './source.ts';
import {evaluateObservations,profileHash,statuses,type seedsFrom} from './profile.ts';
const env=()=>Object.fromEntries(Object.entries({PATH:'/usr/bin:/bin',HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}).filter((e):e is [string,string]=>typeof e[1]==='string'));
const command=async(args:string[])=> (await promisify(execFile)('/usr/bin/podman',args,{timeout:15000,maxBuffer:100000,env:env()})).stdout;
export async function verifyProject(checkout:string,commit:string,job:Job,runtime:Runtime,dependencies:Dependency,seeds:ReturnType<typeof seedsFrom>,options:{directory:string;phase:'baseline'|'candidate';signal?:AbortSignal;checkpoint?:(intent:unknown)=>Promise<void>}) {
  validateJob(job);Dependency.parse(dependencies);await validateRuntime(runtime);options.signal?.throwIfAborted();
  if(await profileHash()!==job.profileHash||dependencies.lockHash!==job.lockHash||dependencies.packageHash!==job.packageHash||dependencies.nodeHash!==runtime.nodeHash||await treeDigest(dependencies.directory)!==dependencies.treeHash)throw new Error('Execution inputs changed');
  const directory=resolve(options.directory);await mkdir(directory,{mode:0o700});const work=join(directory,'work'),runner=join(directory,'harness'),node=join(directory,'node');
  await snapshot(checkout,commit,work);await mkdir(join(work,'node_modules'),{mode:0o755});await mkdir(runner,{mode:0o755});
  const binary=await readFile(runtime.nodePath);if(byteHash(binary)!==runtime.nodeHash)throw new Error('Runtime changed');await writeFile(node,binary,{flag:'wx',mode:0o555});
  await writeFile(join(runner,'invoke.mjs'),await readFile(new URL('profile-harness.mjs',import.meta.url)),{flag:'wx',mode:0o444});
  const nonce=randomUUID();await writeFile(join(runner,'input.json'),JSON.stringify({nonce,seeds,statuses,targets:[seeds[0].bundle.target]}),{flag:'wx',mode:0o444});
  const receiptId=randomUUID(),containerName='onionsoup-project-'+receiptId,startedAt=new Date().toISOString();
  for(const path of [work,runner,node,dependencies.directory])if(!path.startsWith('/')||/[:,\r\n]/.test(path))throw new Error('Unsafe mount path');
  const args=['run','--pull=never','--name',containerName,'--network=none','--read-only','--read-only-tmpfs=false','--cap-drop=all','--security-opt=no-new-privileges',
    '--user=65534:65534','--pids-limit='+L.pids,'--memory='+L.memoryMiB+'m','--memory-swap='+L.memoryMiB+'m','--cpus='+L.cpus,
    '--ulimit=nofile=256:256','--ulimit=core=0:0','--ulimit=fsize=16777216:16777216','--ipc=private','--pid=private','--uts=private','--log-driver=none','--http-proxy=false','--unsetenv-all',
    '--env=PATH=/runtime:/usr/bin:/bin','--env=HOME=/tmp','--env=LANG=C.UTF-8','--env=TMPDIR=/tmp','--tmpfs=/tmp:rw,noexec,nosuid,nodev,size='+L.tmpMiB+'m','--workdir=/work',
    '--volume',work+':/work:ro','--volume',dependencies.directory+':/work/node_modules:ro','--volume',runner+':/harness:ro','--volume',node+':/runtime/node:ro',
    '--entrypoint=/runtime/node',runtime.imageId,'--max-old-space-size=384','--import','/work/node_modules/tsx/dist/loader.mjs','/harness/invoke.mjs'];
  const intent={receiptId,phase:options.phase,containerName,startedAt,jobHash:hash(job),tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),runtimeHash:hash(runtime),dependencyHash:hash(dependencies),profileHash:job.profileHash,seedHash:hash(seeds),commandHash:hash(args)};
  await atomicJson(join(directory,'execution.json'),{...intent,command:['/usr/bin/podman',...args]});await options.checkpoint?.(intent);options.signal?.throwIfAborted();
  let out=Buffer.alloc(0),err=Buffer.alloc(0),bytes=0,stop:Verification['status']|undefined,exitCode:number|null=null,stopping:Promise<unknown>|undefined;
  const child=spawn('/usr/bin/podman',args,{cwd:directory,env:env(),stdio:['ignore','pipe','pipe']});
  const terminate=(reason:Verification['status'])=>{if(stop)return;stop=reason;stopping=command(['rm','--force','--time','0',containerName]).catch(()=>{}).finally(()=>child.kill('SIGKILL'));};
  const collect=(b:Buffer,stdout:boolean)=>{bytes+=b.length;if(bytes>L.outputBytes)terminate('output_limit');if(stdout)out=Buffer.concat([out,b]).subarray(0,L.outputBytes);else err=Buffer.concat([err,b]).subarray(0,L.outputBytes);};
  child.stdout.on('data',b=>collect(b,true));child.stderr.on('data',b=>collect(b,false));
  const abort=()=>terminate('cancelled');options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(()=>terminate('timeout'),L.wallMs);
  await new Promise<void>(resolve=>{child.once('error',()=>{stop='execution_error';resolve();});child.once('close',c=>{exitCode=c;resolve();});});
  clearTimeout(timer);options.signal?.removeEventListener('abort',abort);await stopping;
  let cleanup:Verification['cleanup']='removed';try{await command(['rm','--force','--time','0','--ignore',containerName]);}catch{cleanup='failed';}
  let status:Verification['status']=stop??'execution_error',checks:Verification['checks']=[];
  if(!stop&&exitCode===0&&cleanup==='removed')try {
    const observed=JSON.parse(out.toString());if(observed.nonce!==nonce)throw new Error('Protocol mismatch');checks=evaluateObservations(observed,seeds);
    const docs=await readFile(join(work,'docs/specs/draft-publication.md'),'utf8');checks.push({id:'documentation',status:docs.includes('?status=')&&/filter/i.test(docs)?'passed':'failed'});
    status=checks.every(c=>c.status==='passed')?'passed':'checks_failed';
  }catch{status='execution_error';checks=[];}
  await atomicJson(join(directory,'observations.json'),{stdout:out.toString(),stderr:err.toString(),bytes});if(cleanup==='removed')await rm(node);
  return Verification.parse({schemaVersion:1,...intent,finishedAt:new Date().toISOString(),status,checks,exitCode,cleanup,outputHash:byteHash(Buffer.concat([out,err]))});
}
