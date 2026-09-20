import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const execute=promisify(execFile),app=resolve('apps/chat-cli/dist/main.js');
test('compiled CLI creates/resumes private state without credentials and interactive target selection persists',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chat-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=join(root,'config.json'),session=join(root,'session');
  await writeFile(config,JSON.stringify({schemaVersion:1,provider:'copilot',runsDirectory:'jobs',observations:[],targets:[{schemaVersion:1,assetId:'cluster',host:'example.invalid',user:'operator'}],maxJobs:1}));
  const base=[app,'--config',config,'--provider','copilot','--session',session];
  const fresh=JSON.parse((await execute(process.execPath,[...base,'--status'],{cwd:tmpdir(),env:{PATH:'/nonexistent'}})).stdout);assert.equal(fresh.turns,0);assert.equal(fresh.childAdmissions,0);
  const status=JSON.parse((await execute(process.execPath,[...base,'--resume','--status'],{cwd:tmpdir(),env:{PATH:'/nonexistent'}})).stdout);assert.equal(status.sessionId,fresh.sessionId);
  const child=spawn(process.execPath,[...base,'--resume'],{cwd:tmpdir(),env:{PATH:'/nonexistent'},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
  child.stdin.end('/target cluster\n/status\n/quit\n');const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,err);assert.match(out,/Selected cluster/);assert.equal(JSON.parse(await readFile(join(session,'session.json'),'utf8')).memory.selectedTarget,'cluster');
  await assert.rejects(stat(join(session,'.lock')),{code:'ENOENT'});await assert.rejects(stat(join(root,'jobs','.host-lock')),{code:'ENOENT'});
  const fileMode=(await stat(join(session,'session.json'))).mode&0o777;assert.equal(fileMode,0o600);
  await assert.rejects(execute(process.execPath,[...base,'--resume','--provider','codex','--status'],{env:{PATH:'/nonexistent'}}));
});
test('missing or malformed auth gets safe actionable diagnostics without consuming a turn',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chat-cli-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=join(root,'config.json'),auth=join(root,'auth.json'),session=join(root,'session');
  await writeFile(config,JSON.stringify({schemaVersion:1,provider:'copilot',runsDirectory:'jobs',observations:[],targets:[],maxJobs:1}));
  const base=[app,'--config',config,'--provider','copilot','--session',session,'--message','hello'];
  const env={PATH:'/nonexistent',ONIONSOUP_AUTH_PATH:auth};
  for(const [index,code] of ['provider_auth_missing','provider_auth_unreadable'].entries()){
    if(index)await writeFile(auth,'invalid JSON containing private-fixture-value');
    await assert.rejects(execute(process.execPath,[...base,...(index?['--resume']:[])],{cwd:tmpdir(),env}),error=>{
      const e=error as Error&{stdout:string;stderr:string;code:number};assert.equal(e.code,1);
      const reply=JSON.parse(e.stdout);assert.equal(reply.error,code);assert.match(reply.message,/ONIONSOUP_AUTH_PATH/);
      assert.ok(!JSON.stringify(e).includes('private-fixture-value'));return true;
    });
    const saved=JSON.parse(await readFile(join(session,'session.json'),'utf8'));assert.equal(saved.turns.length,0);assert.equal(saved.memory.admissions,0);
  }
  const child=spawn(process.execPath,[app,'--config',config,'--provider','copilot','--session',session,'--resume'],{cwd:tmpdir(),env,stdio:['pipe','pipe','pipe']});let err='';child.stderr.on('data',c=>err+=c);child.stdout.resume();
  child.stdin.end('hello\n/status\n/quit\n');const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0);assert.match(err,/No turn or child allowance was consumed/);assert.ok(!err.includes('private-fixture-value'));
});
