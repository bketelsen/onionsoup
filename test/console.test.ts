import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { validateRepositoryBrief } from '../src/repository-brief/record.ts';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { atomicJson, readJson } from '../src/batch-store.ts';
import { createRepositoryBrief } from '../src/repository-brief/recipe.ts';
import { hash } from '../src/repository-brief/contracts.ts';
import { DeliveryConfig } from '../src/delivery/contracts.ts';
import { runNow, tick, prepareSaved } from '../src/delivery/runtime.ts';
import { scheduleControl, setSchedulePaused } from '../src/delivery/control.ts';
import { nextOccurrence } from '../src/delivery/schedule.ts';
import { ConsoleConfig, loadJob } from '../src/console/config.ts';
import { Operator, type OperatorDependencies } from '../src/console/actions.ts';
import { consoleServer } from '../src/console/server.ts';
import { history } from '../src/console/history.ts';
import { workflowEvents } from '../src/workflow-events.ts';
const delivery=DeliveryConfig.parse({ schemaVersion:1,jobId:'fixture',repository:'example/widget',provider:'copilot',days:7,maxSuggestions:0,
  schedule:{ timeZone:'America/New_York',time:'08:00',weekdays:[0,1,2,3,4,5,6],catchUpHours:2 },
  from:'sender@example.invalid',to:'operator@example.invalid',smtp:{ host:'127.0.0.1',port:2525,security:'loopback' } });
const until='2026-09-18T12:00:00.000Z',stamp='2026-09-17T12:00:00Z';
const row={ number:7,repository_url:'https://api.github.com/repos/example/widget',title:'<script>untrusted title</script>',body:'not used',labels:[],
  user:{ login:'example',type:'User' },state:'open',created_at:stamp,updated_at:stamp,closed_at:null };
function model(result:unknown) { return new MockLanguageModelV3({ doStream:async()=>({ stream:simulateReadableStream({ initialDelayInMs:null,chunkDelayInMs:null,chunks:[
  { type:'stream-start',warnings:[] },{ type:'tool-call',toolCallId:'one',toolName:'submit_result',input:JSON.stringify(result) },
  { type:'finish',finishReason:{ unified:'tool-calls',raw:'tool-calls' },usage:{ inputTokens:{ total:1,noCache:1,cacheRead:0,cacheWrite:0 },outputTokens:{ total:1,text:1,reasoning:0 } } }] }) }) }); }
async function fixture(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),'onionsoup-console-'));t.after(()=>rm(root,{ recursive:true,force:true }));
  const config=ConsoleConfig.parse({ schemaVersion:1,stateDirectory:join(root,'operator'),jobs:[{ id:'widget',deliveryConfig:join(root,'config.json'),deliveryState:join(root,'deliveries'),
    briefRoots:[join(root,'briefs')],source:{ checkout:join(root,'source'),commit:'a'.repeat(40) } }] });
  await atomicJson(config.jobs[0].deliveryConfig,delivery);await mkdir(join(root,'briefs'));
  const generate:typeof createRepositoryBrief=async(raw,options)=>{
    let i=0;
    return createRepositoryBrief(raw,{ ...options,reader:async endpoint=>{
      if(endpoint==='repos/example/widget') return { full_name:'example/widget',default_branch:'main' };
      if(endpoint.includes('/actions/runs')) return { total_count:0,workflow_runs:[] };
      const q=new URL(endpoint,'https://api.github.com/').searchParams.get('q')??'';
      return { total_count:q.includes('is:issue')&&q.includes('is:open')?1:0,incomplete_results:false,items:q.includes('is:issue')&&q.includes('is:open')?[row]:[] };
    },modelFactory:async()=>({ provider:'copilot',modelId:'gpt-5.6-terra',model:model(i++===0?{ schemaVersion:1,groups:[{ label:'Reported behavior',summary:'One issue requires investigation.',itemIds:['issue:7'] }] }:{ schemaVersion:1,observations:[],limitations:['Only metadata inspected.'] }) }) });
  };
  const b=await generate({ schemaVersion:1,repository:delivery.repository,since:'2026-09-11T12:00:00.000Z',until,maxSuggestions:0 },{ directory:join(root,'briefs','saved'),provider:'copilot' });
  assert.equal(b.status,'completed');
  const job=await loadJob(config,'widget');
  const request=(action:'run_now'|'pause'|'resume')=>({ requestId:randomUUID(),jobId:job.id,revision:job.revision,action });
  const investigation=()=>({ requestId:randomUUID(),jobId:job.id,revision:job.revision,action:'investigate',briefId:b.workflowId,briefHash:hash(validateRepositoryBrief(b)),number:7 });
  return { root,config,b,job,generate,request,investigation };
}
async function http(t:TestContext,operator:Operator) {
  const server=consoleServer(operator);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{ await operator.idle();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); });
  const origin=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const html=await (await fetch(origin)).text(),csrf=/name="csrf" value="([a-f0-9]+)"/.exec(html)![1];
  const post=(body:Record<string,unknown>,headers:Record<string,string>={})=>fetch(origin+'/actions',{ method:'POST',redirect:'manual',headers:{ Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...headers },body:new URLSearchParams({ csrf,...Object.fromEntries(Object.entries(body).map(([k,v])=>[k,String(v)])) }) });
  return { server,origin,html,csrf,post };
}
test('dashboard and report show validated history, evidence links and inert untrusted content',async t=>{
  const f=await fixture(t), op=new Operator(f.config), s=await http(t,op);
  assert.match(s.html,/example\/widget/);assert.match(s.html,/Run brief now/);assert.match(s.html,/No delivery attempts/);
  const response=await fetch(`${s.origin}/briefs/widget/${f.b.workflowId}`), html=await response.text();
  assert.match(html,/&lt;script&gt;untrusted title/);assert.ok(!html.includes('<script>untrusted'));
  assert.match(html,/Assess &amp; investigate/);assert.match(html,/Parent|pinned|commit/);
  assert.match(response.headers.get('content-security-policy')!,/form-action 'self'/);
  const report=await (await fetch(`${s.origin}/briefs/widget/${f.b.workflowId}/report`)).text();
  assert.match(report,new RegExp(`/briefs/widget/${f.b.workflowId}/events`));
  assert.ok(!report.includes('href="events.json"'));
});
test('HTTP rejects cross-origin actions, wrong token, injected fields and forged host before work',async t=>{
  const f=await fixture(t);let calls=0;
  const op=new Operator(f.config,{ runNow:async()=>{ calls++;throw new Error(); } }), s=await http(t,op), r=f.request('run_now');
  assert.equal((await s.post(r,{ Origin:'https://evil.invalid' })).status,409);
  assert.equal((await s.post({ ...r,csrf:'bad' })).status,409);
  assert.equal((await s.post({ ...r,checkout:'/tmp/attacker' })).status,409);
  const forgedHost=await new Promise<number|undefined>((resolve,reject)=>{ const req=httpRequest(s.origin,{ headers:{ Host:'evil.invalid' } },res=>{ res.resume();resolve(res.statusCode); });req.on('error',reject);req.end(); });
  assert.equal(forgedHost,403);
  assert.equal((await fetch(s.origin,{ headers:{ 'Sec-Fetch-Site':'cross-site' } })).status,403);
  assert.equal(calls,0);assert.equal((await op.records()).records.length,0);
});
test('run-now POST records intent, preserves exact duplicate identity and sends only once',async t=>{
  const f=await fixture(t);let generations=0,sends=0;
  const op=new Operator(f.config,{ deliveryOptions:{ now:new Date(until),generate:async(...args)=>{ generations++;return f.generate(...args); },sender:async()=>{ sends++;return 'accepted'; } } });
  const s=await http(t,op), r=f.request('run_now');assert.equal((await s.post(r)).status,303);await op.idle();
  assert.equal((await s.post(r)).status,303);await op.idle();
  assert.equal(generations,1);assert.equal(sends,1);
  const saved=await op.record(r.requestId);assert.equal(saved.result?.type,'delivery');assert.equal(saved.status,'completed');
  assert.equal((await history(f.job)).briefs.length,2);
  assert.equal(workflowEvents(saved).events[1].childWorkflowId,saved.result&&'workflowId'in saved.result?saved.result.workflowId:undefined);
});
test('pause is durable and affects scheduled ticks while explicit run-now remains possible',async t=>{
  const f=await fixture(t), op=new Operator(f.config);const r=f.request('pause');await op.submit(r);await op.idle();
  assert.equal((await scheduleControl(f.job.deliveryState,delivery.jobId)).paused,true);
  let generated=0;const options={ stateDirectory:f.job.deliveryState,now:new Date(until),generate:async(...args:Parameters<typeof createRepositoryBrief>)=>{ generated++;return f.generate(...args); },sender:async()=> 'accepted' as const };
  assert.equal((await tick(delivery,options)).status,'paused');assert.equal(generated,0);
  await runNow(delivery,randomUUID(),options);assert.equal(generated,1);
  await op.submit(f.request('resume'));await op.idle();assert.equal((await scheduleControl(f.job.deliveryState,delivery.jobId)).paused,false);
});
test('stale configuration, arbitrary issue and substituted brief are refused before admission',async t=>{
  const f=await fixture(t), op=new Operator(f.config);
  await assert.rejects(op.submit({ ...f.investigation(),number:8 }));
  await assert.rejects(op.submit({ ...f.investigation(),briefHash:'b'.repeat(64) }));
  await atomicJson(f.config.jobs[0].deliveryConfig,{ ...delivery,to:'other@example.invalid' });
  await assert.rejects(op.submit(f.request('run_now')));assert.equal((await op.records()).records.length,0);
});
test('investigation binds parent and fresh snapshot; duplicate selection reuses action identity',async t=>{
  const f=await fixture(t);let reads=0,packets=0;
  const deps:OperatorDependencies={ openSource:async()=>({}) as any,source:{ scan:async()=>{ throw new Error(); },get:async()=>{ reads++;return { number:7,title:'Fresh issue',state:'open',updatedAt:stamp,observedAt:stamp,commentsExcluded:0,
    snapshot:{ schemaVersion:1,repository:delivery.repository,number:7,title:'Fresh issue',body:'New details',updatedAt:stamp } }; } },packet:async()=>{ packets++;throw new Error('synthetic packet failure'); } };
  const op=new Operator(f.config,deps), r=f.investigation(), id=await op.submit(r);await op.idle();
  assert.equal(await op.submit(f.investigation()),id);await op.idle();assert.equal(reads,1);assert.equal(packets,1);
  const record=await op.record(id);assert.equal(record.snapshot?.body,'New details');assert.equal(record.commit,f.job.source?.commit);assert.equal(record.status,'failed');
  const events=workflowEvents(record);assert.equal(events.events[0].parentWorkflowId,f.b.workflowId);assert.ok(!JSON.stringify(events).includes('New details'));
});
test('a newly closed issue never reaches the model or packet worker',async t=>{
  const f=await fixture(t);let packets=0;
  const op=new Operator(f.config,{ openSource:async()=>({}) as any,source:{ scan:async()=>{ throw new Error(); },get:async()=>({ number:7,title:'Closed',state:'closed',updatedAt:stamp,observedAt:stamp,commentsExcluded:0 }) },packet:async()=>{ packets++;throw new Error(); } });
  const id=await op.submit(f.investigation());await op.idle();assert.equal(packets,0);assert.deepEqual((await op.record(id)).result,{ type:'skipped',reason:'closed' });
});
test('initial checkpoint failure prevents effects, and final checkpoint failure stays unknown after restart',async t=>{
  for(const phase of ['running','completed']) {
    const f=await fixture(t);let calls=0;
    const op=new Operator(f.config,{ runNow:async()=>{ calls++;return { directory:'unused',workflowId:randomUUID(),occurrence:'ondemand-'+randomUUID(),status:'accepted',attempts:1,briefWorkflowId:randomUUID() }; },persist:async(file,raw)=>{
      if((raw as {status:string}).status===phase) throw new Error('disk failed');await atomicJson(file,raw);
    } });
    const r=f.request('run_now');
    if(phase==='running') { await assert.rejects(op.submit(r));assert.equal(calls,0); }
    else { await op.submit(r);await op.idle();assert.equal(calls,1);assert.equal((await op.record(r.requestId)).status,'running');
      const restarted=new Operator(f.config);assert.equal(await restarted.submit(r),r.requestId);assert.equal(restarted.active,undefined); }
  }
});
test('concurrent action admission and stale-lock recovery cannot start extra work',async t=>{
  const f=await fixture(t);let unblock!:()=>void;const gate=new Promise<void>(r=>unblock=r);
  const op=new Operator(f.config,{ runNow:async()=>{ await gate;throw new Error('fixture stopped'); } });
  const id=await op.submit(f.request('run_now'));await assert.rejects(op.submit(f.request('run_now')));
  const other=new Operator(f.config);await assert.rejects(other.submit(f.request('run_now')));unblock();await op.idle();
  await mkdir(join(f.config.stateDirectory,'.action.lock'));await assert.rejects(other.submit(f.request('run_now')));assert.equal((await op.record(id)).status,'failed');
});
test('delivery retry rejects changed attempt count and uncertain sends',async t=>{
  const f=await fixture(t), prepared=await prepareSaved(delivery,f.b,{ stateDirectory:f.job.deliveryState });let sends=0;
  const op=new Operator(f.config,{ deliveryOptions:{ sender:async()=>{ sends++;return 'unknown'; } } });
  const r={ ...f.request('run_now'),action:'retry',occurrence:prepared.occurrence,attempts:0 };
  await op.submit(r);await op.idle();assert.equal(sends,1);
  await assert.rejects(op.submit({ ...r,requestId:randomUUID(),attempts:1 }));
});
test('history exposes corruption and refuses symlink escape and conflicting duplicate identities',async t=>{
  const f=await fixture(t), extra=join(f.root,'briefs','duplicate');await mkdir(extra);
  await atomicJson(join(extra,'repository-brief.json'),{ ...f.b,workflowId:randomUUID(),schemaVersion:999 });
  assert.equal((await history(f.job)).invalid,1);
  await rm(join(extra,'repository-brief.json'));await symlink(join(f.root,'config.json'),join(extra,'repository-brief.json'));
  assert.equal((await history(f.job)).invalid,1);
  await rm(join(extra,'repository-brief.json'));await atomicJson(join(extra,'repository-brief.json'),{ ...f.b,finishedAt:'2026-09-19T20:00:00Z' });
  const conflicting=await history(f.job);assert.equal(conflicting.briefs.length,0);assert.equal(conflicting.invalid,1);
});
test('next occurrence honors Eastern DST and skips the repeated fold instant',()=>{
  const c={ ...delivery,schedule:{ ...delivery.schedule,time:'01:30' } };
  assert.equal(nextOccurrence(c,new Date('2026-11-01T05:40:00Z'))?.dueAt,'2026-11-02T06:30:00.000Z');
  assert.equal(nextOccurrence(delivery,new Date('2026-03-07T14:00:00Z'))?.dueAt,'2026-03-08T12:00:00.000Z');
});

test('real pinned Git source validation works through the operator handoff',async t=>{
  const { execFile }=await import('node:child_process');const { promisify }=await import('node:util');
  const { writeFile }=await import('node:fs/promises');const { fixtureModel }=await import('../src/fixture-model.ts');
  const { createPacket }=await import('../src/packet.ts');
  const f=await fixture(t),checkout=join(f.root,'source');await mkdir(checkout);await writeFile(join(checkout,'README.md'),'Fixture source');
  const git=(...args:string[])=>promisify(execFile)('git',['-C',checkout,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Test','-c','user.email=test@example.invalid',...args]);
  await git('init','-q');await git('remote','add','origin','https://github.com/example/widget');await git('add','.');await git('commit','-qm','fixture');
  const commit=(await git('rev-parse','HEAD')).stdout.trim();f.config.jobs[0].source={ checkout,commit };
  const job=await loadJob(f.config,'widget');let calls=0;
  const op=new Operator(f.config,{ source:{ scan:async()=>{throw new Error();},get:async()=>({ number:7,title:'Feature request',state:'open',updatedAt:stamp,observedAt:stamp,commentsExcluded:0,
    snapshot:{ schemaVersion:1,repository:delivery.repository,number:7,title:'Feature request',body:'Please add blue widgets.',updatedAt:stamp } }) },
    packet:async(raw,options)=>createPacket(raw,{ ...options,modelFactory:async()=>{ calls++;return { provider:'copilot',modelId:'gpt-5.6-terra',model:fixtureModel([{ schemaVersion:2,kind:'feature_request',bug_readiness:'not_applicable',summary:'A request for blue widgets.',evidence:[],questions:[] }]) }; } }) });
  const id=await op.submit({ ...f.investigation(),revision:job.revision });await op.idle();
  assert.equal((await op.record(id)).status,'completed');assert.equal((await op.record(id)).result?.type,'packet');assert.equal(calls,1);
  const server=await http(t,op),html=await (await fetch(`${server.origin}/operations/${id}`)).text();assert.match(html,/feature request/);
  const packet=await (await fetch(`${server.origin}/operations/${id}/packet.json`)).json() as any;
  assert.equal(packet.repository.commit,commit);assert.equal(packet.locationDisposition,'not_eligible');
});
