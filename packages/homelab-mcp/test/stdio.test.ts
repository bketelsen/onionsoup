import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('compiled stdio host discovers and creates a saved-source brief without credentials or model calls',async t=>{
  const root=await mkdtemp(join(tmpdir(),'homelab-stdio-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'nas.json'),JSON.stringify({schemaVersion:1,kind:'truenas-observation',runId:randomUUID(),assetId:'nas',targetHash:'a'.repeat(64),binaryHash:'b'.repeat(64),readOnly:true,tlsInsecure:true,startedAt:'2026-09-19T00:00:00Z',finishedAt:'2026-09-19T00:00:01Z',status:'failed',failure:'connection_failed'}));
  const config=join(root,'config.json');await writeFile(config,JSON.stringify({schemaVersion:1,model:{provider:'copilot',model:'gpt-5.6-terra'},runsDirectory:'state',observations:['nas.json'],targets:[],maxJobs:1}));
  const client=new Client({name:'external-homelab-chat',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('apps/homelab-mcp/dist/main.js')],cwd:tmpdir(),env:{ONIONSOUP_HOMELAB_CONFIG:config,PATH:'/nonexistent'},stderr:'pipe'});
  t.after(()=>client.close());await client.connect(transport);
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args})).structuredContent as any;
  assert.equal((await client.listTools()).tools.length,7);assert.deepEqual((await call('discover_homelab')).targets,[]);
  const job=await call('create_homelab_brief');let final;
  for(let i=0;i<100;i++){final=await call('inspect_homelab_job',{jobId:job.jobId});if(final.status!=='running')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(final.status,'settled');assert.match(final.markdown,/TrueNAS coverage unavailable/);assert.match(final.markdown,/\*\*stale\*\*/);
  assert.equal(await readFile(join(root,'state',job.jobId,'brief.md'),'utf8'),final.markdown);
  assert.equal((await call('create_homelab_brief')).error,'job_limit');await client.close();
  await assert.rejects(stat(join(root,'state','.host-lock')),{code:'ENOENT'});
  const restarted=new Client({name:'restart-proof',version:'1'}),again=new StdioClientTransport({command:process.execPath,args:[resolve('apps/homelab-mcp/dist/main.js')],env:{ONIONSOUP_HOMELAB_CONFIG:config,PATH:'/nonexistent'},stderr:'pipe'});
  t.after(()=>restarted.close());await restarted.connect(again);
  const inspected=await restarted.callTool({name:'inspect_homelab_job',arguments:{jobId:job.jobId}});
  assert.equal((inspected.structuredContent as any).status,'settled');await restarted.close();
  await assert.rejects(stat(join(root,'state','.host-lock')),{code:'ENOENT'});
});
