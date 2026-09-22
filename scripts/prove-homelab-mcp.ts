import { mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { liveModel, providerName } from '@onionsoup/providers';
import { HomelabMcpConfig } from '@onionsoup/homelab-mcp';
import { proveHomelabDelegation } from './lib/homelab-delegation.ts';
globalThis.AI_SDK_LOG_WARNINGS=false;
console.error=console.warn=()=>process.stderr.write('Provider diagnostic suppressed.\n');
async function main(){
  const [name,config,output,...extra]=process.argv.slice(2);
  if(!name||!config||extra.length)throw Error('Usage');const provider=providerName(name);
  const {model}=HomelabMcpConfig.parse(JSON.parse(await readFile(resolve(config),'utf8')));
  if(model.provider!==provider)throw Error('Provider mismatch');
  const directory=resolve(output??`runs/homelab-delegation/${randomUUID()}`);await mkdir(dirname(directory),{recursive:true,mode:0o700});
  const client=new Client({name:'onionsoup-model-delegation-proof',version:'1.0.0'});
  const env=Object.fromEntries(Object.entries({PATH:process.env.PATH,HOME:process.env.HOME,SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,
    ONIONSOUP_AUTH_PATH:process.env.ONIONSOUP_AUTH_PATH,ONIONSOUP_HOMELAB_CONFIG:resolve(config)}).filter((row):row is [string,string]=>typeof row[1]==='string'));
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('apps/homelab-mcp/dist/main.js')],cwd:process.cwd(),env,stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  try{
    await client.connect(transport);
    const catalog=await client.listTools();for(const name of ['discover_homelab','investigate_workload_findings','inspect_homelab_job','create_homelab_brief','cancel_homelab_job'])if(!catalog.tools.some(t=>t.name===name))throw Error('Missing tool');
    const record=await proveHomelabDelegation({directory,provider,modelId:model.model,modelFactory:async()=>(await liveModel(model.model,provider)).model,
      call:async(name,args,signal)=>{const result=await client.callTool({name,arguments:args},undefined,{signal,timeout:30000});return {isError:result.isError===true,structuredContent:result.structuredContent};}});
    process.stdout.write(JSON.stringify({directory,runId:record.runId,status:record.status,steps:record.steps,tokenUsage:record.tokenUsage,answer:record.answer})+'\n');
    if(record.status!=='completed')process.exitCode=1;
  }finally{await client.close();}
}
main().catch(()=>{process.stderr.write('Homelab delegation failed; inspect the private run artifacts and host configuration.\n');process.exitCode=1;});
