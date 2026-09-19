import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/fixture-runner/contracts.ts';
import {createFixture,acceptedScope} from '../src/fixture-runner/fixture.ts';
import {verifyFiles,validateRuntime,sandboxArgs} from '../src/fixture-runner/sandbox.ts';
import {readJson} from '../src/batch-store.ts';
const runtimeFile=process.env.ONIONSOUP_FIXTURE_RUNTIME;
test('real rootless runner enforces boundaries and preserves failure classes', {skip:!runtimeFile&&'Set ONIONSOUP_FIXTURE_RUNTIME to run the real isolation qualification.'},async t=>{
  const outerOomExisted=await stat(join(process.cwd(),'oom')).then(()=>true,()=>false);
  const root=await mkdtemp(join(tmpdir(),'onionsoup-isolation-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=Runtime.parse(await readJson(runtimeFile!)),f=await createFixture(join(root,'base')),scope=acceptedScope('bug',f.files,f.commit);
  const sentinel=join(root,'credential-canary');await writeFile(sentinel,'fake-private-canary');
  process.env.ONIONSOUP_SECRET_CANARY='fake-secret';t.after(()=>{delete process.env.ONIONSOUP_SECRET_CANARY;});
  const secure=`import fs from 'node:fs';import net from 'node:net';
async function boundary(){
 const status=fs.readFileSync('/proc/self/status','utf8');
 if(process.getuid()!==65534||!/^CapEff:\\s+0+$/m.test(status)||!/^NoNewPrivs:\\s+1$/m.test(status)||!/^Seccomp:\\s+2$/m.test(status))throw Error('identity');
 if(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='268435456')throw Error('memory');
 if(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()!=='32')throw Error('pids');
 if(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()!=='100000 100000')throw Error('cpu');
 for(const path of ['/work/tasks.mjs','/harness/invoke.mjs','/etc/fixture-test']){try{fs.writeFileSync(path,'bad');throw Error('writable');}catch(e){if(e.message==='writable')throw e;}}
 if(fs.existsSync(${JSON.stringify(sentinel)})||fs.existsSync('/var/run/docker.sock')||fs.existsSync('/run/podman/podman.sock')||process.env.ONIONSOUP_SECRET_CANARY)throw Error('host-exposed');
 try{fs.writeFileSync('/tmp/overflow',Buffer.alloc(9*1024*1024));throw Error('disk');}catch(e){if(e.message==='disk')throw e;}fs.rmSync('/tmp/overflow',{force:true});
 await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>{s.destroy();reject(Error('network'));});s.on('error',resolve);s.setTimeout(500,()=>{s.destroy();resolve();});});
}
export async function completedCount(tasks){await boundary();return tasks.filter(t=>t.done===true).length;}
export function listTasks(tasks){return tasks.map(t=>t.name).join('\\n');}
`;
  const boundaries=await verifyFiles({...f.files,'tasks.mjs':secure},scope,runtime,{directory:join(root,'boundaries'),phase:'probe'});
  assert.equal(boundaries.status,'passed');assert.equal(boundaries.cleanup,'removed');assert.equal(await readFile(sentinel,'utf8'),'fake-private-canary');
  await assert.rejects(validateRuntime({...runtime,nodeHash:'f'.repeat(64)}),/Runtime changed/);
  assert.throws(()=>sandboxArgs(runtime,'name','/a:bad','/b','/c'));
  const baseline=await verifyFiles(f.files,scope,runtime,{directory:join(root,'bug-baseline'),phase:'baseline'});
  assert.equal(baseline.status,'assertion_failed');assert.ok(baseline.checks.filter(c=>c.criterionIds.includes('AC2')).every(c=>c.status==='passed'));
  const feature=await verifyFiles(f.files,acceptedScope('feature',f.files,f.commit),runtime,{directory:join(root,'feature-baseline'),phase:'baseline'});
  assert.equal(feature.status,'capability_absent');assert.ok(feature.checks.filter(c=>c.criterionIds.includes('AC2')).every(c=>c.status==='passed'));
  for(const [name,code,expected,wallMs] of [
    ['syntax','export function {','execution_error',15000],
    ['missing-import',"import 'nonexistent-dependency';",'execution_error',15000],
    ['timeout','while(true){}','timeout',700],
    ['output',"process.stdout.write('x'.repeat(100000));",'output_limit',15000],
    ['oom','const data=Buffer.alloc(512*1024*1024,1); await new Promise(()=>{});','execution_error',15000],
    ['spoof',`process.stdout.write(JSON.stringify({status:'passed'}));`,'execution_error',15000],
  ] as const){
    const r=await verifyFiles({...f.files,'tasks.mjs':code},scope,runtime,{directory:join(root,name),phase:'probe',wallMs});
    assert.equal(r.status,expected,name);assert.equal(r.cleanup,'removed',name);assert.equal(r.checks.length,0,name);
    if(name==='oom') assert.equal(r.oomKilled,true);
  }
  if(!outerOomExisted) await assert.rejects(stat(join(process.cwd(),'oom')), {code:'ENOENT'});
  let admitted=false;await assert.rejects(verifyFiles(f.files,scope,runtime,{directory:join(root,'checkpoint-failure'),phase:'probe',checkpoint:async()=>{admitted=true;throw new Error('disk');}}),/disk/);assert.equal(admitted,true);
  const controller=new AbortController();
  const cancelled=await verifyFiles({...f.files,'tasks.mjs':'while(true){}'},scope,runtime,{directory:join(root,'cancelled'),phase:'probe',signal:controller.signal,checkpoint:async()=>{setTimeout(()=>controller.abort(),500);}});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.cleanup,'removed');
});
