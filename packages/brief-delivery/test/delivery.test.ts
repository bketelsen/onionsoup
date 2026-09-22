import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { DeliveryConfig, DeliveryRecord } from '@onionsoup/brief-delivery/contracts';
import { latestOccurrence } from '@onionsoup/brief-delivery/schedule';
import { smtpSender, bytesHash } from '@onionsoup/brief-delivery/mail';
import { tick, prepareSaved, deliver, inspect, reconcile, type DeliveryOptions } from '@onionsoup/brief-delivery/runtime';
import { createRepositoryBrief } from '@onionsoup/repository-brief/recipe';
import { atomicJson, readJson } from '@onionsoup/runtime/storage';
const TEST_MODEL = 'gpt-5.6-terra';
import { workflowEvents } from '@onionsoup/brief-delivery/events';
const config=DeliveryConfig.parse({ schemaVersion:1,jobId:'test-brief',repository:'example/widget',provider:'copilot',days:7,maxSuggestions:0,
  schedule:{ timeZone:'America/New_York',time:'09:00',weekdays:[1,2,3,4,5],catchUpHours:2 },
  from:'onionsoup@example.invalid',to:'maintainer@example.invalid',smtp:{ host:'127.0.0.1',port:2525,security:'loopback' } });
async function fixture(t:TestContext) {
  const parent=await mkdtemp(join(tmpdir(),'onionsoup-delivery-'));
  t.after(()=>rm(parent,{ recursive:true,force:true }));
  let generations=0, modelCalls=0;
  const generate:typeof createRepositoryBrief=async(raw,options)=>{
    generations++;
    return createRepositoryBrief(raw,{ ...options,reader:async endpoint=>endpoint==='repos/example/widget'?{ full_name:'example/widget',default_branch:'main' }:
      endpoint.includes('/actions/runs')?{ total_count:0,workflow_runs:[] }:{ total_count:0,incomplete_results:false,items:[] },
      models:async()=>{ modelCalls++; return { provider:'copilot',modelId:TEST_MODEL,model:new MockLanguageModelV3({
        doStream:async()=>({ stream:simulateReadableStream({ initialDelayInMs:null,chunkDelayInMs:null,chunks:[{ type:'stream-start',warnings:[] },
          { type:'tool-call',toolCallId:'one',toolName:'submit_result',input:JSON.stringify({ schemaVersion:1,observations:[],limitations:['No activity in the sample.'] }) },
          { type:'finish',finishReason:{ unified:'tool-calls',raw:'tool-calls' },usage:{ inputTokens:{ total:1,noCache:1,cacheRead:0,cacheWrite:0 },outputTokens:{ total:1,text:1,reasoning:0 } } }] }) }) }) }; } });
  };
  const options:DeliveryOptions={ stateDirectory:join(parent,'state'),now:new Date('2026-09-18T13:05:00Z'),generate,sender:async()=> 'accepted' };
  return { parent,options,generate,generations:()=>generations,modelCalls:()=>modelCalls };
}
async function sink(t:TestContext,mode:'accept'|'reject'|'drop') {
  const messages:string[]=[], sockets=new Set<import('node:net').Socket>();
  const server=createServer(socket=>{
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});
    socket.write('220 localhost test sink\r\n');
    let pending='',data=false,body='';
    socket.on('data',chunk=>{
      pending+=chunk.toString(); let index;
      while ((index=pending.indexOf('\r\n'))>=0) {
        const line=pending.slice(0,index); pending=pending.slice(index+2);
        if(data) {
          if(line==='.') { data=false; messages.push(body); body=''; if(mode==='drop') socket.destroy(); else socket.write('250 2.0.0 accepted\r\n'); }
          else body+=line+'\r\n';
        } else if(line.startsWith('EHLO')) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if(line.startsWith('MAIL')) socket.write('250 OK\r\n');
        else if(line.startsWith('RCPT')) socket.write(mode==='reject'?'550 5.1.1 rejected\r\n':'250 OK\r\n');
        else if(line==='DATA') { data=true; socket.write('354 send\r\n'); }
        else if(line==='QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{ for(const socket of sockets) socket.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve())); });
  return { messages,config:{ ...config,smtp:{ ...config.smtp,port:(server.address() as import('node:net').AddressInfo).port } } };
}

test('schedule selects one latest occurrence, bounds catch-up and respects DST folds/gaps',()=>{
  assert.equal(latestOccurrence(config,new Date('2026-09-18T12:59:00Z')),undefined);
  assert.deepEqual(latestOccurrence(config,new Date('2026-09-18T13:05:00Z')),{ key:'2026-09-18T09:00',dueAt:'2026-09-18T13:00:00.000Z' });
  assert.equal(latestOccurrence(config,new Date('2026-09-18T15:01:00Z')),undefined);
  assert.equal(latestOccurrence(config,new Date('2026-09-19T13:05:00Z')),undefined);
  const fold={ ...config,schedule:{ ...config.schedule,time:'01:30',weekdays:[0],catchUpHours:3 } };
  assert.deepEqual(latestOccurrence(fold,new Date('2026-11-01T06:45:00Z')),{ key:'2026-11-01T01:30',dueAt:'2026-11-01T05:30:00.000Z' });
  assert.equal(latestOccurrence({ ...fold,schedule:{ ...fold.schedule,catchUpHours:1 } },new Date('2026-11-01T06:45:00Z')),undefined);
  assert.equal(latestOccurrence({ ...fold,schedule:{ ...fold.schedule,time:'02:30' } },new Date('2026-03-08T08:00:00Z')),undefined);
});
test('operator config rejects header injection, credential values, arbitrary plaintext and invalid zones',()=>{
  for(const c of [{ ...config,to:'a@example.invalid\r\nBcc: b@example.invalid' },{ ...config,to:'a@example.invalid,b@example.invalid' },
    { ...config,smtp:{ ...config.smtp,host:'remote.example.invalid' } },{ ...config,smtp:{ ...config.smtp,password:'secret' } },
    { ...config,schedule:{ ...config.schedule,timeZone:'Not/AZone' } }]) assert.throws(()=>DeliveryConfig.parse(c));
  assert.throws(()=>smtpSender({ ...config,smtp:{ host:'smtp.example.invalid',port:465,security:'tls',auth:{ userEnv:'SMTP_USER',passwordEnv:'SMTP_PASS' } } },{}));
});
test('tick sends once, reuses the same frozen brief, and exports private correlated events',async t=>{
  const f=await fixture(t); let sends=0;
  const options={ ...f.options,sender:async()=>{ sends++; return 'accepted' as const; } };
  const first=await tick(config,options); assert.equal(first.status,'accepted'); assert.ok('directory' in first);
  const second=await tick(config,options); assert.deepEqual(second,first); assert.equal(f.generations(),1); assert.equal(sends,1);
  const r=DeliveryRecord.parse(await readJson(join(first.directory,'delivery.json'))), events=workflowEvents(r);
  assert.equal(events.events.filter(e=>e.type==='delivery.accepted').length,1);
  assert.equal(events.events.find(e=>e.type==='delivery.prepared')?.parentWorkflowId,r.brief!.workflowId);
  assert.ok(!JSON.stringify(events).includes(config.to)); assert.ok(!JSON.stringify(events).includes('No activity'));
  for(const name of ['delivery.json','events.json','brief.json','message.eml']) assert.equal((await stat(join(first.directory,name))).mode&0o777,0o600);
  const mail=await readFile(join(first.directory,'message.eml'),'utf8'); assert.match(mail,/Content-Type: multipart\/alternative/);
  assert.ok(!mail.includes('repository-brief.json')); assert.ok(!mail.includes('events.json')); assert.ok(!mail.includes('tokenUsage'));
});
test('known rejection retries exact bytes without analysis; allowance stops after three attempts',async t=>{
  const f=await fixture(t), hashes:string[]=[];
  const options={ ...f.options,sender:async(b:Buffer)=>{ hashes.push(bytesHash(b)); return 'rejected' as const; } };
  const first=await tick(config,options); assert.ok('occurrence' in first); assert.equal(first.status,'rejected');
  await tick(config,options); assert.equal(hashes.length,1);
  await deliver(config,first.occurrence,options); await deliver(config,first.occurrence,options);
  await assert.rejects(deliver(config,first.occurrence,options));
  assert.equal(hashes.length,3); assert.equal(new Set(hashes).size,1); assert.equal(f.generations(),1);
});
test('unknown effect requires evidence-based reconciliation; accepted reconciliation never resends',async t=>{
  const f=await fixture(t); let sends=0;
  const options={ ...f.options,sender:async()=>{ sends++; return 'unknown' as const; } };
  const first=await tick(config,options); assert.ok('occurrence' in first);
  assert.equal((await deliver(config,first.occurrence,options)).status,'unknown'); assert.equal(sends,1);
  await assert.rejects(reconcile(config,first.occurrence,'not_accepted','',options));
  await reconcile(config,first.occurrence,'accepted','relay journal reference 123',options);
  assert.equal((await deliver(config,first.occurrence,options)).status,'accepted'); assert.equal(sends,1);
  const seen=await inspect(config,first.occurrence,options.stateDirectory);
  assert.ok(!JSON.stringify(seen.events).includes('relay journal'));
  await assert.rejects(reconcile(config,first.occurrence,'not_accepted','different decision',options));
});
test('confirmed nonacceptance permits explicit retry of the same payload',async t=>{
  const f=await fixture(t); const first=await tick(config,{ ...f.options,sender:async()=> 'unknown' }); assert.ok('occurrence' in first);
  await reconcile(config,first.occurrence,'not_accepted','relay proved absent',f.options);
  const result=await deliver(config,first.occurrence,f.options); assert.equal(result.status,'accepted'); assert.equal(result.attempts,2); assert.equal(f.generations(),1);
});
test('storage failure before intent prevents send; after acceptance leaves unknown and prevents replay',async t=>{
  for(const failAt of ['sending','accepted']) {
    const f=await fixture(t); let sends=0;
    const options:DeliveryOptions={ ...f.options,sender:async()=>{ sends++; return 'accepted'; },persist:async(file,raw)=>{
      if(DeliveryRecord.parse(raw).attempts.at(-1)?.outcome===failAt) throw new Error('disk failure');
      await atomicJson(file,raw);
    } };
    await assert.rejects(tick(config,options)); assert.equal(sends,failAt==='sending'?0:1);
    const recovered=await tick(config,{ ...f.options,sender:options.sender });
    assert.equal(recovered.status,failAt==='sending'?'accepted':'unknown'); assert.equal(sends,1); assert.equal(f.generations(),1);
  }
});
test('concurrent ticks cannot admit duplicate analysis and a stale lock is never stolen',async t=>{
  const f=await fixture(t); let release!:()=>void;
  const gate=new Promise<void>(r=>release=r); let started!:()=>void; const ready=new Promise<void>(r=>started=r);
  const options={ ...f.options,generate:async(...args:Parameters<typeof createRepositoryBrief>)=>{ started(); await gate; return f.generate(...args); } };
  const work=tick(config,options); await ready;
  await assert.rejects(tick(config,options)); release(); const result=await work; assert.ok('directory' in result); assert.equal(f.generations(),1);
  await mkdir(join(result.directory,'.lock')); await assert.rejects(tick(config,options)); assert.equal(f.generations(),1);
});
test('interrupted analysis is not replayed; saved completed analysis is adopted without another model call',async t=>{
  for(const finished of [false,true]) {
    const f=await fixture(t), options={ ...f.options,generate:async(...args:Parameters<typeof createRepositoryBrief>)=>{
      if(finished) await f.generate(...args); throw new Error('process interrupted');
    } };
    await assert.rejects(tick(config,options)); const generations=f.generations();
    const result=await tick(config,f.options); assert.equal(result.status,finished?'accepted':'analysis_unfinished'); assert.equal(f.generations(),generations);
  }
});
test('artifact, destination and request substitution stop before sending',async t=>{
  const f=await fixture(t), b=await f.generate({ schemaVersion:1,repository:config.repository,since:'2026-09-11T13:00:00.000Z',until:'2026-09-18T13:00:00.000Z',maxSuggestions:0 },{ directory:join(f.parent,'saved'),models:async()=>{ throw Error('generate supplies the model'); } });
  const result=await prepareSaved(config,b,f.options);
  await assert.rejects(deliver({ ...config,to:'other@example.invalid' },result.occurrence,f.options));
  await writeFile(join(result.directory,'message.eml'),'tampered'); await assert.rejects(deliver(config,result.occurrence,f.options));
  assert.equal(f.generations(),1);
  await assert.rejects(prepareSaved({ ...config,repository:'other/widget' },b,f.options));
});
test('SMTP integration distinguishes acceptance, explicit rejection and lost final acknowledgement',async t=>{
  for(const mode of ['accept','reject','drop'] as const) {
    const s=await sink(t,mode), sender=smtpSender(s.config);
    const outcome=await sender(Buffer.from('From: onionsoup@example.invalid\r\nTo: maintainer@example.invalid\r\nSubject: Test\r\n\r\nHello\r\n'));
    assert.equal(outcome,mode==='accept'?'accepted':mode==='reject'?'rejected':'unknown');
    assert.equal(s.messages.length,mode==='reject'?0:1);
  }
});
test('SMTP sink receives a saved MIME brief and duplicate ticks send no second message',async t=>{
  const f=await fixture(t), s=await sink(t,'accept'), options={ ...f.options,sender:smtpSender(s.config) };
  const first=await tick(s.config,options); assert.equal(first.status,'accepted'); await tick(s.config,options);
  assert.equal(s.messages.length,1); assert.match(s.messages[0],/Message-ID: <[a-f0-9-]+@onionsoup.invalid>/);
  assert.equal(f.generations(),1);
});
test('malformed delivery histories cannot forge safe retry permission',()=>{
  const r={ schemaVersion:1,kind:'brief-delivery',workflowId:'01234567-89ab-4def-8123-456789abcdef',jobId:config.jobId,occurrence:'2026-09-18T09:00',
    dueAt:'2026-09-18T13:00:00Z',createdAt:'2026-09-18T13:00:00Z',configHash:'a'.repeat(64),
    request:{ schemaVersion:1,repository:config.repository,since:'2026-09-11T13:00:00Z',until:'2026-09-18T13:00:00Z',maxSuggestions:0 },attempts:[{ startedAt:'2026-09-18T13:00:00Z',outcome:'accepted' }] };
  assert.throws(()=>DeliveryRecord.parse(r));
});

test('capture relay persists mail privately, rejects oversize messages, and does not forward',async t=>{
  const { captureServer }=await import('@onionsoup/brief-delivery/capture');
  const { readdir }=await import('node:fs/promises');
  const f=await fixture(t), directory=join(f.parent,'captured'), server=await captureServer(directory);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.server.address() as import('node:net').AddressInfo).port;
  const sender=smtpSender({ ...config,smtp:{ ...config.smtp,port } });
  assert.equal(await sender(Buffer.from('Subject: Capture test\r\n\r\nSaved only\r\n')),'accepted');
  const files=await readdir(directory); assert.equal(files.length,1);
  assert.match(await readFile(join(directory,files[0]),'utf8'),/Saved only/);
  assert.equal((await stat(join(directory,files[0]))).mode&0o777,0o600);
  assert.equal(await sender(Buffer.from('Subject: Too large\r\n\r\n'+'x'.repeat(11*1024*1024))),'rejected');
  assert.equal((await readdir(directory)).length,1);
});

test('failed generation is visible, never mailed, and never replayed',async t=>{
  const f=await fixture(t); let calls=0,sends=0;
  const options={ ...f.options,generate:async(...args:Parameters<typeof createRepositoryBrief>)=>{
    calls++; return createRepositoryBrief(args[0],{ ...args[1],reader:async()=>{ throw new Error('source offline'); } });
  },sender:async()=>{ sends++; return 'accepted' as const; } };
  assert.equal((await tick(config,options)).status,'analysis_failed'); assert.equal((await tick(config,options)).status,'analysis_failed');
  assert.equal(calls,1); assert.equal(sends,0);
});


test('initial persistence failure admits neither analysis nor SMTP',async t=>{
  const f=await fixture(t); let sends=0;
  await assert.rejects(tick(config,{ ...f.options,persist:async()=>{ throw new Error('no storage'); },sender:async()=>{ sends++; return 'accepted'; } }));
  assert.equal(f.generations(),0); assert.equal(sends,0);
});

test('changed frozen request and unknown ledger version stop before SMTP',async t=>{
  const f=await fixture(t); let sends=0;
  const first=await tick(config,{ ...f.options,sender:async()=> 'rejected' }); assert.ok('directory' in first);
  const file=join(first.directory,'delivery.json'), raw=await readJson(file) as Record<string,any>;
  const options={ ...f.options,sender:async()=>{ sends++; return 'accepted' as const; } };
  await atomicJson(file,{ ...raw,request:{ ...raw.request,maxSuggestions:1 } });
  await assert.rejects(deliver(config,first.occurrence,options));
  await atomicJson(file,{ ...raw,schemaVersion:2 });
  await assert.rejects(deliver(config,first.occurrence,options)); assert.equal(sends,0);
});

test('delivery attempt precondition is checked inside the effect lock',async t=>{
  const f=await fixture(t);let sends=0;
  const options={ ...f.options,sender:async()=>{ sends++;return 'rejected' as const; } };
  const first=await tick(config,options);assert.ok('occurrence' in first);
  await assert.rejects(deliver(config,first.occurrence,{ ...options,expectedAttempts:0 }));assert.equal(sends,1);
  await deliver(config,first.occurrence,{ ...options,expectedAttempts:1 });assert.equal(sends,2);
});
