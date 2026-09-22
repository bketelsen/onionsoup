import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContainerTarget } from '@onionsoup/container-source';
import { digest } from '@onionsoup/kubernetes-source/workloads';
import { createHomelabMcpServer, HomelabMcpConfig } from '../src/index.ts';
import { RefreshSource, validateRefresh } from '../src/refresh.ts';
const target=ContainerTarget.parse({schemaVersion:1,assetId:'containers',host:'example.invalid',user:'operator',engines:['docker']});
const source={sourceId:'containers',kind:'containers' as const,target};
function observation(old=false){const at=new Date(Date.now()-(old?3600000:1000)).toISOString();return {schemaVersion:1,kind:'container-inventory',runId:randomUUID(),assetId:target.assetId,targetHash:digest(target),commandVersion:'ssh-container-states-v1',readOnlyCommands:true,startedAt:at,finishedAt:at,status:'partial',queries:[{engine:'docker',scope:'local-default-docker-socket',commandHash:'a'.repeat(64),status:'unavailable',failure:'cli_unavailable'}]};}
test('refresh IDs reuse fixed collectors, persist admission and replace only explicit matching baseline sources',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-refresh-'));t.after(()=>rm(root,{recursive:true,force:true}));const baseline=join(root,'baseline.json');await writeFile(baseline,JSON.stringify(observation(true)));let collections=0;
  const host=createHomelabMcpServer({schemaVersion:1,model:{provider:'copilot',model:'gpt-5.6-terra'},runsDirectory:join(root,'jobs'),observations:[baseline],targets:[],refreshSources:[source],maxJobs:4},
    {modelFactory:async()=>{throw Error('No model');},refresh:async(s,options)=>{collections++;assert.deepEqual(s,source);const saved=JSON.parse(await readFile(join(options.directory,'../job.json'),'utf8'));assert.equal(saved.status,'admitted');
      await mkdir(options.directory);const result=observation();await writeFile(join(options.directory,'observation.json'),JSON.stringify(result));return result;}});
  const client=new Client({name:'refresh-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await host.server.connect(a);await client.connect(b);t.after(async()=>{await host.shutdown();await client.close();});
  const call=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});return {error:r.isError,body:r.structuredContent as any};};
  const finish=async(id:string)=>{for(let n=0;n<100;n++){const r=(await call('inspect_homelab_job',{jobId:id})).body;if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,5));}throw Error('Timeout');};
  const discovery=(await call('discover_homelab')).body;assert.deepEqual(discovery.refreshSources,[{sourceId:'containers',kind:'containers',assetId:'containers'}]);assert.ok(!JSON.stringify(discovery).includes('example.invalid'));
  assert.equal((await call('refresh_homelab_source',{sourceId:'unknown'})).body.error,'source_not_allowed');assert.equal((await call('refresh_homelab_source',{sourceId:'containers',command:'delete'})).error,true);assert.equal(collections,0);
  const refreshed=(await call('refresh_homelab_source',{sourceId:'containers'})).body;const result=await finish(refreshed.jobId);assert.equal(result.resultStatus,'partial');assert.equal(collections,1);
  const brief=(await call('create_homelab_brief',{refreshJobIds:[refreshed.jobId]})).body;const rendered=await finish(brief.jobId);
  assert.equal(rendered.sources.length,1);assert.equal(rendered.sources[0].runId,result.runId);assert.equal(rendered.sources[0].freshnessAtGeneration,'fresh');assert.match(rendered.markdown,/unavailable/);
  assert.equal((await call('create_homelab_brief',{refreshJobIds:[refreshed.jobId,refreshed.jobId]})).body.error,'duplicate_refresh');
  const wrong=(await call('create_homelab_brief',{refreshJobIds:[brief.jobId]})).body;assert.equal((await finish(wrong.jobId)).status,'execution_failed');
});
test('refresh configuration and result provenance cannot substitute hosts, commands or raw fields',()=>{
  assert.throws(()=>RefreshSource.parse({...source,command:'sudo reboot'}));assert.throws(()=>RefreshSource.parse({...source,target:{...target,credentials:'private'}}));
  assert.throws(()=>HomelabMcpConfig.parse({schemaVersion:1,model:{provider:'copilot',model:'gpt-5.6-terra'},runsDirectory:'x',observations:[],targets:[],refreshSources:[source,source]}));
  assert.throws(()=>validateRefresh(source,{...observation(),assetId:'foreign'}));assert.throws(()=>validateRefresh(source,{...observation(),targetHash:'0'.repeat(64)}));
  assert.throws(()=>validateRefresh(source,{...observation(),rawLogs:'private'}));assert.equal(validateRefresh(source,observation()).status,'partial');
});
