import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorkloads, parseWorkloadProjection, selectWorkloadFacts, workloadCommand } from '../src/workloads.ts';
const uid='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
const pod=`${uid}|private-namespace|private-name|2026-09-01T00:00:00Z||Job|${owner}|Failed|False||main,0,false,,Error,1,2026-09-10T00:00:00Z,,,;\n`;
const job=`${owner}|private-namespace|private-job|2026-09-01T00:00:00Z||||True||0|1|1|\n`;
const target={schemaVersion:1,assetId:'test',host:'example.invalid',user:'operator',access:'sudo'};
test('status projections normalize names away, retain timestamps, join owners by identity, and preserve missing numeric fields',()=>{
  const p=parseWorkloadProjection('pods','v1\n'+pod),j=parseWorkloadProjection('jobs','v1\n'+job);assert.equal(p.facts[0].ownerId,j.facts[0].id);
  assert.ok(!JSON.stringify(p.facts).includes('private'));assert.equal(Object.values(p.lookup)[0].name,'private-name');
  const input=selectWorkloadFacts([...p.facts,...j.facts]);assert.equal(input.facts.length,2);assert.equal(input.eligible,1);
  const other=parseWorkloadProjection('jobs','v1\n'+job.replace('private-namespace','elsewhere'));assert.equal(selectWorkloadFacts([...p.facts,...other.facts]).facts.length,1);
  for(const bad of ['', 'v1\n'+pod+pod,'v1\n'+pod.replace('Error','private error message'),'v1\n'+pod.replace('2026-09-01T00:00:00Z','not-time')])assert.throws(()=>parseWorkloadProjection('pods',bad));
  assert.equal(parseWorkloadProjection('pods','v1\n').facts.length,0);
  assert.throws(()=>parseWorkloadProjection('pods','v1\n'+pod.repeat(5001)));
  assert.throws(()=>parseWorkloadProjection('pods','x'.repeat(256*1024+1)));
  assert.throws(()=>parseWorkloadProjection('pods','v1\n'+pod.replace('private-name','$(id)')));
  const missing=parseWorkloadProjection('jobs','v1\n'+job.replace('0|1|1|','|||')).facts[0];if(missing.kind==='Job')assert.equal(missing.succeeded,null);
});
test('collector persists each query, suppresses failed diagnostics and records partial owner coverage',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workload-source-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'run');let calls=0;
  const result=await collectWorkloads(target,{directory,transport:async(_,section)=>{
    calls++;const saved=JSON.parse(await readFile(join(directory,'observation.json'),'utf8'));assert.equal(saved.queries.find((q:any)=>q.section===section).status,'running');
    return section==='pods'?{code:0,stdout:'v1\n'+pod}:section==='jobs'?{code:1,stdout:'private-token'}:{code:0,stdout:'v1\n'};
  }});assert.equal(calls,4);assert.equal(result.status,'partial');assert.equal(result.selected.length,1);assert.equal(result.facts.length,1);assert.ok(!JSON.stringify(result).includes('private'));
  assert.match(await readFile(join(directory,'resources.private.json'),'utf8'),/private-name/);
});
test('fixed commands cannot select logs, secrets, remote contexts or arbitrary arguments; cancellation skips later reads',async t=>{
  for(const section of ['pods','jobs','replicasets','deployments'] as const){const command=workloadCommand(target,section);assert.match(command,/sudo -n \/usr\/bin\/k3s kubectl/);assert.match(command,/--server=https:\/\/127.0.0.1:6443/);assert.ok(!command.includes('.spec.template'));assert.ok(!command.includes('.message'));}
  assert.throws(()=>workloadCommand({...target,command:'delete'},'pods'));assert.throws(()=>workloadCommand(target,'secrets' as any));
  const root=await mkdtemp(join(tmpdir(),'workload-cancel-'));t.after(()=>rm(root,{recursive:true,force:true}));const controller=new AbortController();let calls=0;
  const result=await collectWorkloads(target,{directory:join(root,'run'),signal:controller.signal,transport:async()=>{calls++;controller.abort();return {code:0,stdout:'v1\n'};}});
  assert.equal(calls,1);assert.equal(result.eligible,null);assert.ok(result.queries.slice(1).every(q=>q.status==='not_attempted'));
});

test('selection reports omissions and prioritizes active findings ahead of ready restart history',()=>{
  const seed=parseWorkloadProjection('pods','v1\n'+pod).facts[0];if(seed.kind!=='Pod')throw new Error('Fixture');
  const rows=Array.from({length:12},(_,i)=>({...structuredClone(seed),id:'r-'+i.toString(16).padStart(64,'0'),phase:'Running' as const,ready:'True' as const,containers:seed.containers.map(c=>({...c,restarts:1}))}));
  rows[11].ready='False' as any;
  const selected=selectWorkloadFacts(rows);assert.equal(selected.eligible,12);assert.equal(selected.omitted,2);assert.equal(selected.selected[0],rows[11].id);
});
