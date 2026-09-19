import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readJson } from '../batch-store.ts';
import { providerName } from '../providers.ts';
import { createChangeProposal, renderChangeProposal } from './recipe.ts';
import { proposalResult } from './record.ts';
globalThis.AI_SDK_LOG_WARNINGS=false;
console.error=console.warn=()=>process.stderr.write('Provider diagnostic suppressed; inspect saved status.\n');
const usage='Usage: npm run proposal -- PACKET.json --provider copilot|codex --output NEW_DIRECTORY [--checkout PATH --query LITERAL]\n       npm run proposal -- render DIRECTORY\n';
try {
  const args=process.argv.slice(2);
  if(args.includes('--help')) process.stdout.write(usage);
  else {
    let w;
    if(args[0]==='render') {if(args.length!==2) throw new Error('Arguments');w=await renderChangeProposal(resolve(args[1]));}
    else {
      const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{provider:{type:'string'},output:{type:'string'},checkout:{type:'string'},query:{type:'string'}}});
      if(positionals.length!==1||!values.output||!values.provider) throw new Error('Arguments');
      const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
      try {w=await createChangeProposal(await readJson(resolve(positionals[0])),{directory:resolve(values.output),provider:providerName(values.provider),
        checkout:values.checkout?resolve(values.checkout):undefined,query:values.query,signal:controller.signal});}
      finally {process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
    }
    process.stdout.write(JSON.stringify({workflowId:w.workflowId,status:w.status,proposal:proposalResult(w)?.status,budget:w.budget})+'\n');
    if(w.status!=='completed') process.exitCode=1;
  }
} catch {process.stderr.write('Proposal command failed. Inspect saved artifacts and check arguments/subscription/source access. Existing directories cannot be reused.\n'+usage);process.exitCode=1;}
