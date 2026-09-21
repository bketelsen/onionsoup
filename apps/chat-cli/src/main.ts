import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openChatSession, closeChatSession, chatTurn, sessionUsage, hash, type ChatHandle } from '@onionsoup/chat';
import { createHomelabChatProfile, HOMELAB_CHAT_VERSION, HomelabChatMemory } from '@onionsoup/homelab-chat';
import { HomelabMcpConfig } from '@onionsoup/homelab-mcp';
import { readJson } from '@onionsoup/runtime/storage';
import { liveModel, providerName, ProviderAuthError } from '@onionsoup/providers';
import { EVALUATION_MODEL } from '@onionsoup/providers/evaluation-policy';
import { createJobClient } from '@onionsoup/job-host/client';
import { homelabJobCaller } from '@onionsoup/host-capabilities/consumers';

globalThis.AI_SDK_LOG_WARNINGS=false;
console.error=console.warn=()=>process.stderr.write('Provider diagnostic suppressed; inspect the saved turn.\n');
const usage=`Usage: npm run chat -- (--config MCP_CONFIG | --host URL --token-file FILE) --provider copilot|codex [--session DIRECTORY --resume] [--target ID] [--message TEXT | --status]
Interactive commands: /help, /status, /target ID, /quit. Ctrl-C cancels an active turn.
Credentials: existing ONIONSOUP_AUTH_PATH, SSH agent/keys; optional TRUENAS_API_KEY for configured NAS refresh.
Sessions are private and profile-bound. No service writes, logs or shell tools.
`;
async function main(){
  const {values,positionals}=parseArgs({strict:true,options:{config:{type:'string'},host:{type:'string'},'token-file':{type:'string'},provider:{type:'string'},session:{type:'string'},resume:{type:'boolean'},target:{type:'string'},message:{type:'string'},status:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){process.stdout.write(usage);return;}
  if(positionals.length||Boolean(values.config)===Boolean(values.host)||Boolean(values.host)!==Boolean(values['token-file'])||!values.provider||values.resume&&!values.session||values.status&&values.message!==undefined)throw Error('ARGUMENTS');
  const provider=providerName(values.provider),configPath=values.config?resolve(values.config):undefined,config=configPath?HomelabMcpConfig.parse(await readJson(configPath)):undefined;
  if(config){if(config.provider!==provider)throw Error('PROVIDER_MISMATCH');config.runsDirectory=resolve(dirname(configPath!),config.runsDirectory);config.observations=config.observations.map(p=>resolve(dirname(configPath!),p));}
  const remote=values.host?createJobClient({url:values.host,token:(await readFile(resolve(values['token-file']!),'utf8')).trim()}):undefined;
  const discovery=await remote?.discover(),remoteCapability=discovery?.capabilities.find((c:any)=>c.id==='homelab.investigate');
  if(remote&&(!remoteCapability||remoteCapability.metadata.provider!==provider))throw Error('PROVIDER_OR_CAPABILITY_MISMATCH');
  const targets:string[]=config?config.targets.map(t=>t.assetId):remoteCapability.metadata.targets;
  let targetId=values.target;if(targetId&&!targets.includes(targetId))throw Error('TARGET_NOT_CONFIGURED');
  const directory=resolve(values.session??`runs/chat/${randomUUID()}`);if(!values.resume)await mkdir(dirname(directory),{recursive:true,mode:0o700});
  const client=new Client({name:'onionsoup-chat',version:'0.1.0'});let connected=false,handle:ChatHandle|undefined,active:AbortController|undefined,closing=false;
  const profile=createHomelabChatProfile({bindingHash:hash(remote?{profile:HOMELAB_CHAT_VERSION,binding:discovery.binding,invoker:discovery.invoker}:{profile:HOMELAB_CHAT_VERSION,config}),call:async(name,args,signal)=>{
    if(remote)return homelabJobCaller(remote,handle?.session.sessionId)(name,args,signal);
    if(!connected)throw Error('MCP_NOT_CONNECTED');const r=await client.callTool({name,arguments:args},undefined,{signal,timeout:30000});return {isError:r.isError===true,structuredContent:r.structuredContent};
  }});
  const status=()=>{const memory=HomelabChatMemory.parse(handle!.session.memory);return {directory,sessionId:handle!.session.sessionId,turns:handle!.session.turns.length,selectedTarget:targetId??memory.selectedTarget??null,
    parentUsage:sessionUsage(handle!.session),childAdmissions:memory.admissions,remainingChildAdmissions:16-memory.admissions,jobs:memory.jobs};};
  let input:ReturnType<typeof createInterface>|undefined;
  const interrupt=()=>{if(active)active.abort();else{closing=true;input?.close();}};
  const terminate=()=>{closing=true;active?.abort();input?.close();};process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try{
    handle=await openChatSession({directory,profile,provider,modelId:EVALUATION_MODEL,resume:values.resume});
    if(targetId){handle.session.memory=HomelabChatMemory.parse({...HomelabChatMemory.parse(handle.session.memory),selectedTarget:targetId});await handle.save();}
    if(values.status){process.stdout.write(JSON.stringify(status(),null,2)+'\n');return;}
    if(!remote){const env=Object.fromEntries(Object.entries({PATH:process.env.PATH,HOME:process.env.HOME,SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,ONIONSOUP_AUTH_PATH:process.env.ONIONSOUP_AUTH_PATH,
      TRUENAS_API_KEY:process.env.TRUENAS_API_KEY,ONIONSOUP_HOMELAB_CONFIG:configPath}).filter((r):r is [string,string]=>typeof r[1]==='string'));
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../homelab-mcp/dist/main.js',import.meta.url))],env,stderr:'pipe'});
    transport.stderr?.on('data',()=>{});await client.connect(transport,{timeout:15000});connected=true;
    const catalog=await client.listTools();for(const name of ['discover_homelab','investigate_workload_findings','inspect_homelab_job','inspect_workload_finding','refresh_homelab_source','create_homelab_brief','cancel_homelab_job'])if(!catalog.tools.some(t=>t.name===name))throw Error('MISSING_CAPABILITY');
    }
    const ask=async(message:string)=>{
      active=new AbortController();
      try{
        // Resolve local provider setup before spending a turn or admitting child work.
        // Only fixed diagnostics reach the terminal; never print arbitrary auth errors.
        let configured;
        try{configured=await liveModel(EVALUATION_MODEL,provider);}
        catch(error){
          const code=error instanceof ProviderAuthError?error.code:'provider_initialization_failed';
          const message=code==='provider_auth_missing'?`No ${provider} sign-in was found. Set ONIONSOUP_AUTH_PATH to your existing AgentLayer/OpenCode auth file, or run npm run triage -- login ${provider}.`:
            code==='provider_auth_unreadable'?'The provider auth file could not be read. Check ONIONSOUP_AUTH_PATH, file permissions and JSON format.':`Could not initialize ${provider}. Check the provider configuration and subscription setup.`;
          if(values.message!==undefined){process.stdout.write(JSON.stringify({error:code,message})+'\n');process.exitCode=1;}
          else process.stderr.write(message+' No turn or child allowance was consumed.\n');
          return;
        }
        const turn=await chatTurn(handle!,message,{targetId,signal:active.signal,modelFactory:async()=>configured.model,
          onProgress:values.message===undefined?e=>{if(e.stage==='intent')process.stderr.write(`Working: ${e.tool}\n`);}:undefined});
        if(values.message!==undefined)process.stdout.write(JSON.stringify({directory,sessionId:handle!.session.sessionId,turn})+'\n');
        else{process.stdout.write(`\n${(turn.answer?.text??`Turn ${turn.status}: ${turn.failure??'unavailable'}. Saved evidence remains inspectable.`).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'')}\n`);if(turn.evidence)process.stdout.write(`Evidence (host-generated): ${JSON.stringify(turn.evidence)}\n`);}
        if(turn.status!=='completed'&&values.message!==undefined)process.exitCode=1;
      }catch{process.stderr.write('Turn was not completed. Check session limits, input and saved state.\n');if(values.message!==undefined)process.exitCode=1;}
      finally{active=undefined;}
    };
    if(values.message!==undefined){await ask(values.message);return;}
    process.stdout.write(`Onionsoup homelab chat. Session: ${directory}\n/help for commands.\n`);
    input=createInterface({input:process.stdin,output:process.stdout,terminal:Boolean(process.stdin.isTTY)});input.on('SIGINT',interrupt);let inputClosed=false;input.once('close',()=>{inputClosed=true;});if(process.stdin.isTTY){input.setPrompt('you> ');input.prompt();}
    for await(const raw of input){
      const line=raw.trim();if(closing||line==='/quit')break;
      if(line==='/help')process.stdout.write(usage);
      else if(line==='/status')process.stdout.write(JSON.stringify(status(),null,2)+'\n');
      else if(line.startsWith('/target ')){const selected=line.slice(8).trim();if(targets.includes(selected)){targetId=selected;handle.session.memory=HomelabChatMemory.parse({...HomelabChatMemory.parse(handle.session.memory),selectedTarget:selected});await handle.save();process.stdout.write(`Selected ${selected}.\n`);}else process.stdout.write(`Configured targets: ${targets.join(', ')}\n`);}
      else if(line.startsWith('/'))process.stdout.write('Unknown command. Use /help.\n');
      else if(line)await ask(line);
      if(closing)break;if(process.stdin.isTTY&&!inputClosed)input.prompt();
    }
  }finally{input?.close();await client.close();if(handle)await closeChatSession(handle);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
}
main().catch(()=>{process.stderr.write('Chat stopped. Check arguments, matching profile/provider, session directory and exclusive locks.\n'+usage);process.exitCode=1;});
