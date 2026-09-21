import {repositoryAdapterHash} from './task-verification.ts';
import {nodeTaskInput,evaluateNodeTask} from './node-task-verification.ts';
import {NodeVerificationPlan} from './repository-profile.ts';
import {runContainer} from './container.ts';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {atomicJson} from '@onionsoup/runtime/storage';
import {Runtime} from './contracts.ts';
import {validateRuntime} from '../fixture/sandbox.ts';
import {git} from '../fixture/fixture.ts';
import {Dependency,Verification,validateJob,PROFILE_LIMITS as L,type Job} from './contracts.ts';
import {snapshot,treeDigest,byteHash} from './source.ts';
import {evaluateObservations,documentationSatisfied,profileHash,statuses,type seedsFrom} from './profile.ts';
const env=()=>Object.fromEntries(Object.entries({PATH:'/usr/bin:/bin',HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}).filter((e):e is [string,string]=>typeof e[1]==='string'));
const command=async(args:string[])=> (await promisify(execFile)('/usr/bin/podman',args,{timeout:15000,maxBuffer:100000,env:env()})).stdout;
export async function verifyProject(checkout:string,commit:string,job:Job,runtime:Runtime,dependencies:Dependency,seeds:ReturnType<typeof seedsFrom>,options:{directory:string;phase:'baseline'|'candidate';signal?:AbortSignal;verificationPlan?:import('./repository-profile.ts').VerificationPlan;checkpoint?:(intent:unknown)=>Promise<void>}) {
  validateJob(job);Dependency.parse(dependencies);if((job.schemaVersion===1?job.profile!=='onionsoup-publication-filter-v1':job.repositoryProfile.execution.adapter!=='node-typescript-v1')||runtime.schemaVersion!==1||dependencies.schemaVersion!==1)throw new Error('Node profile required');await validateRuntime(runtime);options.signal?.throwIfAborted();
  const task=job.schemaVersion===2;
  if(task&&(hash(runtime)!==job.runtimeHash||hash(dependencies)!==job.dependencyHash))throw new Error('Accepted environment changed');
  if((task?await repositoryAdapterHash('node-typescript-v1'):await profileHash())!==job.profileHash||dependencies.lockHash!==job.lockHash||dependencies.packageHash!==job.packageHash||dependencies.nodeHash!==runtime.nodeHash||await treeDigest(dependencies.directory)!==dependencies.treeHash)throw new Error('Execution inputs changed');
  const directory=resolve(options.directory);await mkdir(directory,{mode:0o700});const work=join(directory,'work'),runner=join(directory,'harness'),node=join(directory,'node');
  await snapshot(checkout,commit,work);await mkdir(join(work,'node_modules'),{mode:0o755});await mkdir(runner,{mode:0o755});
  const binary=await readFile(runtime.nodePath);if(byteHash(binary)!==runtime.nodeHash)throw new Error('Runtime changed');await writeFile(node,binary,{flag:'wx',mode:0o555});
  await writeFile(join(runner,'invoke.mjs'),await readFile(new URL(task?'node-task-harness.mjs':'profile-harness.mjs',import.meta.url)),{flag:'wx',mode:0o444});
  const nonce=randomUUID();if(task)await writeFile(join(runner,'checks.mjs'),NodeVerificationPlan.parse(options.verificationPlan).source,{flag:'wx',mode:0o444});await writeFile(join(runner,'input.json'),JSON.stringify(task?nodeTaskInput(job,options.verificationPlan,nonce):{nonce,seeds,statuses,targets:[seeds[0].bundle.target]}),{flag:'wx',mode:0o444});
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
  const {out,err,bytes,stop,exitCode,cleanup}=await runContainer(args,directory,containerName,L,options.signal);
  let status:Verification['status']=stop??'execution_error',checks:Verification['checks']=[];
  if(!stop&&exitCode===0&&cleanup==='removed')try {
    const observed=JSON.parse(out.toString());if(observed.nonce!==nonce)throw new Error('Protocol mismatch');if(task){const files=Object.fromEntries(await Promise.all(job.allowedFiles.map(async p=>[p,await readFile(join(work,p),'utf8')])));checks=evaluateNodeTask(job,options.verificationPlan,observed,nonce,files);}
    else {checks=evaluateObservations(observed,seeds);
    const docs=await readFile(join(work,'docs/specs/draft-publication.md'),'utf8');checks.push({id:'documentation',status:documentationSatisfied(docs)?'passed':'failed'});}
    status=checks.every(c=>c.status==='passed')?'passed':'checks_failed';
  }catch{status='execution_error';checks=[];}
  await atomicJson(join(directory,'observations.json'),{stdout:out.toString(),stderr:err.toString(),bytes});if(cleanup==='removed')await rm(node);
  return Verification.parse({schemaVersion:1,...intent,finishedAt:new Date().toISOString(),status,checks,exitCode,cleanup,outputHash:byteHash(Buffer.concat([out,err]))});
}
