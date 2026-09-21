import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {atomicJson,readJson} from '@onionsoup/runtime/storage';
import {providerName} from '@onionsoup/providers';
import {pinRuntime} from './sandbox.ts';
import {Runtime} from './contracts.ts';
import {runFixture,renderFixture} from './recipe.ts';
globalThis.AI_SDK_LOG_WARNINGS=false;console.error=console.warn=()=>process.stderr.write('Provider diagnostic suppressed; inspect saved artifacts.\n');
const usage='npm run fixture -- pin --image LOCAL_IMAGE --output RUNTIME.json\nnpm run fixture -- baseline|patch bug|feature --runtime RUNTIME.json --output NEW_DIR --provider copilot|codex\nnpm run fixture -- render DIRECTORY\n';
try {
  const {positionals,values}=parseArgs({allowPositionals:true,strict:true,options:{image:{type:'string'},output:{type:'string'},runtime:{type:'string'},provider:{type:'string'},help:{type:'boolean'}}});
  if(values.help) process.stdout.write(usage);
  else if(positionals[0]==='pin') {
    if(positionals.length!==1||!values.image||!values.output) throw new Error('Arguments');
    const r=await pinRuntime(values.image,process.execPath);await atomicJson(resolve(values.output),r);process.stdout.write(JSON.stringify({imageId:r.imageId,nodeHash:r.nodeHash})+'\n');
  } else {
    let w;
    if(positionals[0]==='render') {if(positionals.length!==2) throw new Error('Arguments');w=await renderFixture(resolve(positionals[1]));}
    else {
      if(positionals.length!==2||!['baseline','patch'].includes(positionals[0])||!values.runtime||!values.output||!values.provider) throw new Error('Arguments');
      const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
      try {w=await runFixture(positionals[1],{mode:positionals[0] as 'baseline'|'patch',directory:resolve(values.output),runtime:Runtime.parse(await readJson(resolve(values.runtime))),provider:providerName(values.provider),signal:controller.signal});}
      finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
    }
    process.stdout.write(JSON.stringify({workflowId:w.workflowId,status:w.status,outcome:w.outcome,budget:w.budget})+'\n');if(!['candidate_verified','baseline_observed'].includes(w.outcome??'')) process.exitCode=1;
  }
} catch {process.stderr.write('Fixture command failed. Check runtime, arguments and saved artifacts; no automatic replay.\n'+usage);process.exitCode=1;}
