import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,stat,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {Files,Runtime,POLICY,Receipt,type Scope} from './contracts.ts';
import {checks} from './fixture.ts';
const env=()=>Object.fromEntries(Object.entries({PATH:'/usr/bin:/bin',HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}).filter((e):e is [string,string]=>typeof e[1]==='string'));
const command=async(args:string[])=> (await promisify(execFile)('/usr/bin/podman',args,{timeout:15000,maxBuffer:100000,env:env()})).stdout;
const bytesHash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export async function pinRuntime(image:string,nodePath:string):Promise<Runtime> {
  const info=JSON.parse(await command(['info','--format','json']));
  if(info.host?.security?.rootless!==true||info.host?.cgroupVersion!=='v2') throw new Error('Rootless cgroup v2 required');
  const imageInfo=JSON.parse(await command(['image','inspect',image]))[0];
  if(Object.keys(imageInfo.Config?.Volumes??{}).length||imageInfo.Config?.Healthcheck?.Test?.some((v:string)=>v!=='NONE')) throw new Error('Runtime must have no automatic volumes or healthcheck');
  const imageId=(await command(['image','inspect','--format','{{.Id}}',image])).trim();
  const path=await realpath(nodePath);if(!(await stat(path)).isFile()) throw new Error('Node must be a regular file');
  return Runtime.parse({schemaVersion:1,imageId:imageId.startsWith('sha256:')?imageId:'sha256:'+imageId,nodePath:path,nodeHash:bytesHash(await readFile(path)),podmanVersion:(await command(['--version'])).trim()});
}
export async function validateRuntime(raw:unknown) {
  const r=Runtime.parse(raw),actual=await pinRuntime(r.imageId,r.nodePath);
  if(hash(actual)!==hash(r)) throw new Error('Runtime changed');return r;
}
const harness=`import {readFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
try {
  const mod=await import('file:///work/tasks.mjs');
  const results=[];
  for(const c of request.calls) {
    if(typeof mod[c.name]!=='function') results.push({id:c.id,available:false});
    else results.push({id:c.id,available:true,value:await mod[c.name](...c.args)});
  }
  process.stdout.write(JSON.stringify({nonce:request.nonce,results}));
} catch { process.exitCode=2; }
`;
export function sandboxArgs(runtime:Runtime,name:string,work:string,runner:string,node:string) {
  for(const path of [work,runner,node]) if(!path.startsWith('/')||/[:,\n\r]/.test(path)) throw new Error('Invalid mount path');
  return ['run','--pull=never','--name',name,'--network=none','--read-only','--read-only-tmpfs=false','--cap-drop=all','--security-opt=no-new-privileges',
    '--user=65534:65534','--pids-limit='+POLICY.pids,'--memory='+POLICY.memoryMiB+'m','--memory-swap='+POLICY.memoryMiB+'m','--cpus='+POLICY.cpus,
    '--ulimit=nofile=64:64','--ulimit=core=0:0','--ulimit=fsize=8388608:8388608','--ipc=private','--pid=private','--uts=private','--log-driver=none',
    '--http-proxy=false','--unsetenv-all','--env=PATH=/runtime','--env=HOME=/tmp','--env=LANG=C.UTF-8',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size='+POLICY.tmpMiB+'m','--workdir=/work',
    '--volume',work+':/work:ro','--volume',runner+':/harness:ro','--volume',node+':/runtime/node:ro',
    '--entrypoint=/runtime/node','-i',runtime.imageId,'--max-old-space-size=96','/harness/invoke.mjs'];
}
export type ExecutionIntent={receiptId:string;containerName:string;startedAt:string;treeHash:string;scopeHash:string;runtimeHash:string;policyHash:string;harnessHash:string;phase:Receipt['phase']};
export async function verifyFiles(rawFiles:unknown,scope:Scope,runtime:Runtime,options:{directory:string;phase:Receipt['phase'];signal?:AbortSignal;
  checkpoint?:(intent:ExecutionIntent)=>Promise<void>;seed?:string;wallMs?:number}):Promise<Receipt> {
  const files=Files.parse(rawFiles);await validateRuntime(runtime);options.signal?.throwIfAborted();
  const directory=resolve(options.directory);await mkdir(directory,{mode:0o700});
  const work=join(directory,'work'),runner=join(directory,'harness'),node=join(directory,'node');
  await mkdir(work,{mode:0o755});await mkdir(runner,{mode:0o755});
  for(const [path,content] of Object.entries(files)) await writeFile(join(work,path),content,{mode:0o444,flag:'wx'});
  await writeFile(join(runner,'invoke.mjs'),harness,{mode:0o444,flag:'wx'});
  const binary=await readFile(runtime.nodePath);if(bytesHash(binary)!==runtime.nodeHash) throw new Error('Runtime changed');
  await writeFile(node,binary,{mode:0o555,flag:'wx'});
  const receiptId=randomUUID(),intent:ExecutionIntent={receiptId,containerName:'onionsoup-fixture-'+receiptId,startedAt:new Date().toISOString(),
    treeHash:hash(files),scopeHash:hash(scope),runtimeHash:hash(runtime),policyHash:hash(POLICY),harnessHash:bytesHash(harness),phase:options.phase};
  const args=sandboxArgs(runtime,intent.containerName,work,runner,node);
  const execution={hostWorkingDirectory:directory,command:['/usr/bin/podman',...args],containerEnvironment:{PATH:'/runtime',HOME:'/tmp',LANG:'C.UTF-8'}};
  const commandHash=hash(execution);
  const definitionHash=hash(await Promise.all(['sandbox.ts','fixture.ts','contracts.ts'].map(async name=>[name,await readFile(new URL(name,import.meta.url),'utf8')])));
  await writeFile(join(directory,'execution.json'),JSON.stringify({...execution,commandHash,definitionHash},null,2),{mode:0o600,flag:'wx'});
  await options.checkpoint?.(intent);
  options.signal?.throwIfAborted();
  const expected=checks(scope.case,options.seed??randomUUID()),nonce=randomUUID();
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),bytes=0,stop:Receipt['status']|undefined,exitCode:number|null=null;
  let stopping:Promise<unknown>|undefined;
  const child=spawn('/usr/bin/podman',args,{cwd:directory,env:env(),stdio:['pipe','pipe','pipe']});
  const terminate=(reason:Receipt['status'])=>{
    if(stop) return;stop=reason;
    stopping=command(['rm','--force','--time','0',intent.containerName]).catch(()=>{}).finally(()=>{child.kill('SIGKILL');});
  };
  const collect=(chunk:Buffer,out:boolean)=>{bytes+=chunk.length;if(bytes>POLICY.outputBytes) terminate('output_limit');
    if(out) stdout=Buffer.concat([stdout,chunk]).subarray(0,POLICY.outputBytes);else stderr=Buffer.concat([stderr,chunk]).subarray(0,POLICY.outputBytes);};
  child.stdout.on('data',b=>collect(b,true));child.stderr.on('data',b=>collect(b,false));
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({nonce,calls:expected.map(({expected:_,...c})=>c)}));
  const abort=()=>terminate('cancelled');options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted) abort();
  const timer=setTimeout(()=>terminate('timeout'),Math.min(options.wallMs??POLICY.wallMs,POLICY.wallMs));
  await new Promise<void>(resolve=>{child.once('error',()=>{stop??='setup_error';resolve();});child.once('close',code=>{exitCode=code;resolve();});});
  clearTimeout(timer);options.signal?.removeEventListener('abort',abort);await stopping;
  let oomKilled:boolean|null=null;
  try {oomKilled=JSON.parse(await command(['inspect','--format','{{json .State.OOMKilled}}',intent.containerName]));} catch { /* Removed or failed before container admission. */ }
  let cleanup:Receipt['cleanup']='removed';
  try {await command(['rm','--force','--time','0','--ignore',intent.containerName]);} catch {cleanup='failed';}
  const checkResults:Receipt['checks']=[];let status:Receipt['status']=stop??(exitCode===125||exitCode===126||exitCode===127?'setup_error':'execution_error');
  if(!stop&&exitCode===0) try {
    const parsed=z.object({nonce:z.literal(nonce),results:z.array(z.object({id:z.string(),available:z.boolean(),value:z.unknown().optional()}).strict())}).strict().parse(JSON.parse(stdout.toString('utf8')));
    if(parsed.results.length!==expected.length||new Set(parsed.results.map(r=>r.id)).size!==expected.length) throw new Error('Bad result membership');
    for(const c of expected) {
      const r=parsed.results.find(r=>r.id===c.id);if(!r) throw new Error('Missing result');
      const outcome=!r.available?'capability_absent':JSON.stringify(r.value)===JSON.stringify(c.expected)?'passed':'assertion_failed';
      checkResults.push({id:c.id,criterionIds:c.criterionIds,status:outcome,reason:outcome==='passed'?'matched':outcome==='capability_absent'?'export_absent':'value_mismatch'});
    }
    if(scope.case==='feature') {
      const documented=/exportTasks/.test(files['README.md'])&&/```/.test(files['README.md']);
      checkResults.push({id:'export-documentation',criterionIds:['AC3'],status:documented?'passed':'assertion_failed',reason:documented?'matched':'value_mismatch'});
    }
    status=checkResults.some(c=>c.status==='capability_absent')?'capability_absent':checkResults.some(c=>c.status==='assertion_failed')?'assertion_failed':'passed';
  } catch {status='execution_error';checkResults.length=0;}
  if(cleanup==='failed') status='execution_error';
  await writeFile(join(directory,'observations.json'),JSON.stringify({calls:expected,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')},null,2),{mode:0o600,flag:'wx'});
  if(cleanup==='removed') await rm(node);
  return Receipt.parse({schemaVersion:1,...intent,finishedAt:new Date().toISOString(),status,checks:checkResults,exitCode,oomKilled,cleanup,
    commandHash,definitionHash,caseSetHash:hash(expected),outputHash:bytesHash(Buffer.concat([stdout,stderr])),outputBytes:bytes});
}
