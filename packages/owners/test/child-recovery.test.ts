import { openRecoveryDatabase } from '../src/recovery-database.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { childStore } from './fixtures/child-recovery.ts';
import { childRecoverySnapshot, recordChildAbandonment, readChildAbandonment, isAbandonedChild, abandonedChildMessages } from '../src/child-recovery.ts';
const identity = {childID:'ses_child',parentID:'ses_parent',directory:'/chats'};
async function fixture() {
  const state = await mkdtemp(join(tmpdir(),'onionsoup-child-recovery-'));
  const database = join(state,'history.db');
  const db = childStore(database);
  const snapshot = childRecoverySnapshot(identity,database);
  const approval = {...identity,version:1 as const,state:'abandoned' as const,digest:snapshot.digest,
    recordedBy: 'fixture-operator', approvedBy:'fixture-person',approvedAt:new Date().toISOString(),reason:'Explicitly abandon this inactive unfinished watcher'};
  return {state,database,db,snapshot,approval};
}

test('explicit abandonment preserves every history row and reads incompatible format without fabricating completion',async context=>{
  const {state,database,db,snapshot,approval}=await fixture();context.after(()=>db.close());
  const before=await readFile(database);
  assert.equal(await abandonedChildMessages(state,identity.childID,identity.parentID,identity.directory,database),undefined);
  await recordChildAbandonment(state,approval,database);
  assert.equal(await isAbandonedChild(state,identity,database),true);
  assert.equal((await readChildAbandonment(state,identity.childID))?.state,'abandoned');
  assert.deepEqual(await readFile(database),before);
  assert.equal(childRecoverySnapshot(identity,database).digest,snapshot.digest);
  const messages=await abandonedChildMessages(state,identity.childID,identity.parentID,identity.directory,database);
  assert.equal(messages?.length,2);
  assert.equal('format' in (messages?.[0]?.info ?? {}),false);
  assert.equal(messages?.[1]?.info.finish,undefined);
  assert.equal(messages?.[1]?.info.time?.completed,undefined);
  assert.equal(messages?.[0]?.parts[0]?.text,'Preserved original watcher prompt');
  const backup=(await readdir(join(state,'child-recovery'))).find(name=>name.endsWith('.backup.json'))!;
  const backedUp=JSON.parse(await readFile(join(state,'child-recovery',backup),'utf8'));
  assert.equal(backedUp.messages[0].session_id,identity.childID);
  assert.equal(backedUp.messages[0].time_created,1);
  assert.equal(backedUp.parts[0].time_created,1);
  assert.equal(await readFile(join(state,'child-recovery',backup),'utf8'),snapshot.serialized);
  assert.equal((await recordChildAbandonment(state,approval,database)).approvedAt,approval.approvedAt);
});

test('wrong ancestry, changed transcript and new descendant cannot reuse an approval',async context=>{
  const {state,database,db,approval}=await fixture();context.after(()=>db.close());
  await assert.rejects(recordChildAbandonment(state,{...approval,digest:'0'.repeat(64)},database),/evidence_changed/);
  await recordChildAbandonment(state,approval,database);
  assert.equal(await isAbandonedChild(state,{...identity,parentID:'ses_other'},database),false);
  db.prepare('update message set data=? where id=?').run(JSON.stringify({role:'user',time:{created:3}}),'msg_user');
  assert.equal(await isAbandonedChild(state,identity,database),false);
  assert.equal(await abandonedChildMessages(state,identity.childID,identity.parentID,identity.directory,database),undefined);
  db.prepare('insert into session values (?,?,?,?)').run('ses_new',identity.childID,identity.directory,4);
  assert.throws(()=>childRecoverySnapshot(identity,database),/has_descendants/);
  assert.equal(await isAbandonedChild(state,identity,database),false);
  assert.equal(await abandonedChildMessages(state,identity.childID,identity.parentID,identity.directory,database),undefined);
});

test('a completed child is not labeled abandoned',async context=>{
  const {state,database,db,approval}=await fixture();context.after(()=>db.close());
  db.prepare('update message set data=? where id=?').run(JSON.stringify({role:'assistant',parentID:'msg_user',finish:'stop',time:{completed:3}}),'msg_answer');
  const digest=childRecoverySnapshot(identity,database).digest;
  await assert.rejects(recordChildAbandonment(state,{...approval,digest},database),/already_completed/);
});

test('native recovery database refuses writes and cannot create a missing store',async context=>{
  const {database,db,state}=await fixture();context.after(()=>db.close());
  const before=await readFile(database);
  const readOnly=openRecoveryDatabase(database);
  try { assert.throws(()=>readOnly.exec('delete from message'),/readonly|read-only/i); }
  finally { readOnly.close(); }
  assert.deepEqual(await readFile(database),before);
  assert.throws(()=>openRecoveryDatabase(join(state,'missing.db')));
});
