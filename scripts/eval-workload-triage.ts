import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentChoice, liveModel, providerName } from '@onionsoup/providers';
import { atomicJson } from '@onionsoup/runtime/storage';
import { triageWorkloads } from '@onionsoup/workload-triage';
import { cases, fixture } from '../packages/workload-triage/test/fixtures.ts';
globalThis.AI_SDK_LOG_WARNINGS=false;
console.error=console.warn=()=>process.stderr.write('Provider diagnostic suppressed.\n');
const provider=providerName(process.argv[2]);const {model:modelId}=environmentChoice(provider);if(!process.argv[2]||process.argv.length>3)throw new Error('Usage: eval-workload-triage.ts copilot|codex');
const directory=resolve('runs','workload-evaluation',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
const report:{schemaVersion:number;provider:string;model:string;directory:string;cases:unknown[]}={schemaVersion:1,provider,model:modelId,directory,cases:[]};
await atomicJson(join(directory,'evaluation.json'),report);
let failures=0;
for(const [name,expected] of cases){
  const run=await triageWorkloads(fixture(name),{directory:join(directory,name),provider,modelId:modelId,modelFactory:async()=>(await liveModel(modelId,provider)).model});
  const actual=run.result?.findings[0]?.classification;if(actual!==expected)failures++;
  report.cases.push({name,expected,actual:actual??null,runId:run.runId,status:run.status,matched:actual===expected,tokenUsage:run.tokenUsage??null});
  await atomicJson(join(directory,'evaluation.json'),report);process.stdout.write(JSON.stringify(report.cases.at(-1))+'\n');
}
process.stdout.write(JSON.stringify({directory,completed:report.cases.length})+'\n');
if(failures)process.exitCode=1;
