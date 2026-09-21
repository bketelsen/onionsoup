import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openJobHost, listenJobHost, tokenHash } from '@onionsoup/job-host';
import { registeredCapabilities, resolveCapabilityConfig } from '@onionsoup/host-capabilities';
import { readJson } from '@onionsoup/runtime/storage';
globalThis.AI_SDK_LOG_WARNINGS=false;
console.error=console.warn=()=>process.stderr.write('Provider diagnostic suppressed; inspect saved jobs.\n');
try{
  const {values}=parseArgs({strict:true,options:{config:{type:'string'},help:{type:'boolean'}}});
  if(values.help)process.stdout.write('Usage: npm run jobs -- --config HOST_CONFIG\n');
  else{
    if(!values.config)throw Error('Configuration required');const path=resolve(values.config),raw=await readJson(path);
    // Operator-only configuration, never accepted through the job API.
    const {HostConfig}=await import('@onionsoup/host-capabilities');const config=HostConfig.parse(raw);
    const capabilities=resolveCapabilityConfig(config.capabilities,path),invokers=[];
    for(const i of config.invokers){const token=(await readFile(resolve(dirname(path),i.tokenFile),'utf8')).trim();if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw Error('Invalid token');invokers.push({id:i.id,capabilities:i.capabilities,maxJobs:i.maxJobs,tokenHash:tokenHash(token)});}
    const host=await openJobHost({directory:resolve(dirname(path),config.directory),binding:capabilities,capabilities:registeredCapabilities(capabilities,{apiKey:process.env.TRUENAS_API_KEY}),invokers});
    let listener;try{listener=await listenJobHost(host,config.port);}catch(e){await host.close();throw e;}
    process.stdout.write(JSON.stringify({url:listener.url,pid:process.pid})+'\n');
    let closing=false;const close=()=>{if(!closing){closing=true;void listener.close();}};process.once('SIGINT',close);process.once('SIGTERM',close);
  }
}catch{process.stderr.write('Job host stopped. Check configuration, invoke token files, port and exclusive state lock.\n');process.exitCode=1;}
