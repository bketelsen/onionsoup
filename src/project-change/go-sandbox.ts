import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../batch-store.ts';
import {hash} from '../repository-brief/contracts.ts';
import {git} from '../fixture-runner/fixture.ts';
import {Runtime,Dependency,Verification,validateJob,type Job} from './contracts.ts';
import {GO_PROFILE} from './profiles.ts';
import {GO_LIMITS as L,goProfileHash,evaluateGoOutput} from './go-profile.ts';
import {validateGoRuntime} from './go-dependencies.ts';
import {snapshot,treeDigest,byteHash} from './source.ts';
import {runContainer} from './container.ts';
import type {seedsFrom} from './profile.ts';
export async function verifyGoProject(checkout:string,commit:string,job:Job,runtime:Runtime,dependencies:Dependency,seeds:ReturnType<typeof seedsFrom>,options:{directory:string;phase:'baseline'|'candidate';signal?:AbortSignal;checkpoint?:(intent:unknown)=>Promise<void>}) {
 validateJob(job);Dependency.parse(dependencies);
 if(job.profile!==GO_PROFILE||runtime.schemaVersion!==2||dependencies.schemaVersion!==2||seeds.length)throw new Error('Go profile required');
 await validateGoRuntime(runtime);options.signal?.throwIfAborted();
 if(await goProfileHash()!==job.profileHash||dependencies.lockHash!==job.lockHash||dependencies.packageHash!==job.packageHash||dependencies.goHash!==runtime.goHash||await treeDigest(dependencies.directory)!==dependencies.treeHash)throw new Error('Go execution inputs changed');
 const directory=resolve(options.directory);await mkdir(directory,{mode:0o700});const work=join(directory,'work'),runner=join(directory,'harness');
 await snapshot(checkout,commit,work,true);await mkdir(runner,{mode:0o755});
 await writeFile(join(runner,'invoke.sh'),await readFile(new URL('go-harness.sh',import.meta.url)),{flag:'wx',mode:0o444});
 await writeFile(join(runner,'onionsoup_trial_test.go'),await readFile(new URL('go-checks.txt',import.meta.url)),{flag:'wx',mode:0o444});
 await writeFile(join(runner,'overlay.json'),JSON.stringify({Replace:{'/work/onionsoup_trial_test.go':'/harness/onionsoup_trial_test.go'}}),{flag:'wx',mode:0o444});
 const nonce=randomUUID(),receiptId=randomUUID(),containerName='onionsoup-project-'+receiptId,startedAt=new Date().toISOString();
 for(const path of [work,runner,runtime.goDirectory,dependencies.directory])if(!path.startsWith('/')||/[:,\r\n]/.test(path))throw new Error('Unsafe mount path');
 const args=['run','--pull=never','--name',containerName,'--network=none','--read-only','--read-only-tmpfs=false','--cap-drop=all','--security-opt=no-new-privileges',
  '--user=65534:65534','--pids-limit='+L.pids,'--memory='+L.memoryMiB+'m','--memory-swap='+L.memoryMiB+'m','--cpus='+L.cpus,'--ulimit=nofile=256:256','--ulimit=core=0:0','--ulimit=fsize=67108864:67108864',
  '--ipc=private','--pid=private','--uts=private','--log-driver=none','--http-proxy=false','--unsetenv-all',
  '--env=PATH=/go/bin:/usr/bin:/bin','--env=HOME=/scratch','--env=TMPDIR=/scratch/tmp','--env=LANG=C.UTF-8',
  '--env=GOENV=off','--env=GOWORK=off','--env=GOTOOLCHAIN=local','--env=GOTELEMETRY=off','--env=GOAUTH=off','--env=GOPROXY=off','--env=GOSUMDB=off','--env=GOVCS=*:off','--env=CGO_ENABLED=0','--env=GOMODCACHE=/modules','--env=GOPATH=/scratch/gopath','--env=GOFLAGS=-mod=readonly -buildvcs=false -p=2',
  '--tmpfs=/scratch:rw,exec,nosuid,nodev,size='+L.scratchMiB+'m','--workdir=/work',
  '--volume',work+':/work:ro','--volume',runner+':/harness:ro','--volume',runtime.goDirectory+':/go:ro','--volume',dependencies.directory+':/modules:ro',
  '--entrypoint=/bin/sh',runtime.imageId,'/harness/invoke.sh',nonce];
 const intent={receiptId,phase:options.phase,containerName,startedAt,jobHash:hash(job),tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),runtimeHash:hash(runtime),dependencyHash:hash(dependencies),profileHash:job.profileHash,seedHash:hash(seeds),commandHash:hash(args)};
 await atomicJson(join(directory,'execution.json'),{...intent,command:['/usr/bin/podman',...args]});await options.checkpoint?.(intent);options.signal?.throwIfAborted();
 const {out,err,bytes,stop,exitCode,cleanup}=await runContainer(args,directory,containerName,L,options.signal);
 let status:Verification['status']=stop??'execution_error',checks:Verification['checks']=[];
 if(!stop&&exitCode===0&&cleanup==='removed')try {
  checks=evaluateGoOutput(out.toString(),nonce,await readFile(join(work,'README.md'),'utf8'));status=checks.every(c=>c.status==='passed')?'passed':'checks_failed';
 }catch{status='execution_error';checks=[];}
 await atomicJson(join(directory,'observations.json'),{stdout:out.toString(),stderr:err.toString(),bytes});
 return Verification.parse({schemaVersion:1,...intent,finishedAt:new Date().toISOString(),status,checks,exitCode,cleanup,outputHash:byteHash(Buffer.concat([out,err]))});
}
