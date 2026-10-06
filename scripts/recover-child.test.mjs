import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../packages/owners/src/runtime.ts';
import { chatPath } from '../packages/owners/src/chats.ts';
import { childStore } from '../packages/owners/test/fixtures/child-recovery.ts';
import { childRecoverySnapshot, readChildAbandonment } from '../packages/owners/src/child-recovery.ts';
import { recoverChild } from './recover-child.mjs';
import { createAdmission } from './deploy-admission.mjs';

async function fixture(context) {
  const state = await mkdtemp(join(tmpdir(),'child-recovery-command-'));
  const config = resolve('packages/owners/test/fixtures/owners');
  const runtime = await Runtime.open({state,declarations:config});
  const directory = chatPath(runtime,'clippy');
  const database = join(state,'history.db');
  const db = childStore(database,'ses_child','ses_parent',directory);
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = database;
  context.after(()=>{db.close();if(previous===undefined)delete process.env.OPENCODE_DB;else process.env.OPENCODE_DB=previous;});
  const flags = {busy:false,prompt:false,independent:false,change:false};
  const endpoint = {instanceId:'fixture',opencodePid:1,opencodeStartTime:'1',surfacePid:2,url:'http://127.0.0.1:1234/'};
  const input={state,config,directory,child:'ses_child',parent:'ses_parent',admissionEffects:{
    endpoint:async()=>endpoint,processes:async()=>flags.independent,sleep:async()=>{
      if(flags.change)db.prepare('update session set time_updated=time_updated+1').run();
    },
    request:async(_endpoint,path,scope)=>{
      if(path==='/session/status')return flags.busy?{ses_child:{type:'busy'}}:{};
      if(path==='/permission'||path==='/question')return flags.prompt?[{id:'pending'}]:[];
      if(path==='/session')return scope===directory?[{id:'ses_parent',directory}]:[];
      if(path==='/session/ses_parent/children')return [{id:'ses_child',parentID:'ses_parent',directory}];
      if(path==='/session/ses_parent/message')return [{info:{id:'user',role:'user'}},{info:{role:'assistant',parentID:'user',finish:'stop',time:{completed:2}}}];
      if(path==='/session/ses_child/message')throw new Error('HTTP 400 Expected OutputFormatJsonSchema');
      return [];
    },
  }};
  return {input,db,database,flags,endpoint};
}

test('preview and digest approval recover one inactive HTTP400 child without rewriting history',async context=>{
  const {input,database,endpoint}=await fixture(context);
  const before=await readFile(database);
  const preview=await recoverChild(input);
  assert.equal(preview.state,'preview');
  assert.equal(await readChildAbandonment(input.state,input.child),undefined);
  await assert.rejects(recoverChild({...input,approveDigest:'0'.repeat(64),reason:'Approved abandonment'}),/approval_stale/);
  await assert.rejects(recoverChild({...input,approveDigest:preview.digest,reason:'Missing person'}),/approver_required/);
  const saved=await recoverChild({...input,approveDigest:preview.digest,approvedBy:'Brian',reason:'Explicitly approved inactive watcher abandonment'});
  assert.equal(saved.state,'abandoned');
  assert.equal(saved.approvedBy,'Brian');
  assert.ok(saved.recordedBy);
  assert.equal(saved.database,database);
  assert.deepEqual(await readFile(database),before);
  const admission=await createAdmission(input);
  const staleCandidate={childID:input.child,parentID:input.parent,directory:input.directory,digest:'0'.repeat(64)};
  assert.equal(await admission.childRecoveryQuiet(staleCandidate,endpoint),true,'a recorded abandonment is terminal without claiming success');
});

test('busy child, pending prompt, independent process and changing history all refuse recovery',async context=>{
  const {input,flags}=await fixture(context);
  for(const key of ['busy','prompt','independent','change']){
    flags[key]=true;
    await assert.rejects(recoverChild({...input,approveDigest:'0'.repeat(64),reason:'Not sufficient while active'}),/not_idle/);
    assert.equal(await readChildAbandonment(input.state,input.child),undefined);
    flags[key]=false;
  }
});
