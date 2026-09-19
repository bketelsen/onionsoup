import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readJson } from '../batch-store.ts';
import { tick, prepareSaved, deliver, inspect, reconcile } from './runtime.ts';
globalThis.AI_SDK_LOG_WARNINGS=false;
console.error=console.warn=()=>process.stderr.write('Diagnostic suppressed; inspect saved delivery status.\n');
const usage=`Usage: npm run delivery -- tick CONFIG [--state DIRECTORY]
       npm run delivery -- prepare CONFIG BRIEF_JSON [--state DIRECTORY]
       npm run delivery -- send CONFIG OCCURRENCE [--state DIRECTORY]
       npm run delivery -- inspect CONFIG OCCURRENCE [--state DIRECTORY]
       npm run delivery -- reconcile CONFIG OCCURRENCE accepted|not_accepted --evidence REFERENCE [--state DIRECTORY]
`;
try {
  const args=process.argv.slice(2);
  if (args.includes('--help')) process.stdout.write(usage);
  else {
    const { values,positionals:p }=parseArgs({ args,allowPositionals:true,strict:true,options:{ state:{ type:'string' },evidence:{ type:'string' } } });
    const [command,file,key,outcome]=p;
    if (!file || !['tick','prepare','send','inspect','reconcile'].includes(command) ||
      p.length!==(command==='tick'?2:command==='reconcile'?4:3) ||
      (command==='reconcile' ? !values.evidence || !['accepted','not_accepted'].includes(outcome):!!values.evidence)) throw new Error('Invalid arguments');
    const config=await readJson(resolve(file)), options={ stateDirectory:resolve(values.state??'runs/deliveries') };
    const result=command==='tick'?await tick(config,options):command==='prepare'?await prepareSaved(config,await readJson(resolve(key)),options):
      command==='send'?await deliver(config,key,options):command==='inspect'?await inspect(config,key,options.stateDirectory):
      await reconcile(config,key,outcome as 'accepted'|'not_accepted',values.evidence!,options);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if (['unknown','rejected','analysis_unfinished','analysis_failed'].includes(result.status)) process.exitCode=1;
  }
} catch { process.stderr.write('Delivery command stopped. Check configuration, lock, environment and saved ledger; no automatic recovery was attempted.\n'+usage); process.exitCode=1; }
