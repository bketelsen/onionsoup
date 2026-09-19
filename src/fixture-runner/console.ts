import {readdir} from 'node:fs/promises';
import {z} from 'zod';
import {scopedJson} from '../console/history.ts';
import {validateFixtureWorkflow,type FixtureWorkflow} from './record.ts';
export async function fixtureHistory(roots:string[]) {
  const entries:Array<{record:FixtureWorkflow;root:string;directory:string}>=[];let invalid=0,truncated=false;
  for(const root of roots) {
    let names:string[];
    try {names=(await readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name).sort();}
    catch {invalid++;continue;}
    if(names.length>300) truncated=true;
    for(const directory of names.slice(0,300)) try {
      const record=validateFixtureWorkflow(await scopedJson(root,directory+'/fixture.json'));entries.push({record,root,directory});
    } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') invalid++;}
  }
  const counts=new Map<string,number>();for(const e of entries) counts.set(e.record.workflowId,(counts.get(e.record.workflowId)??0)+1);
  return {entries:entries.filter(e=>counts.get(e.record.workflowId)===1).sort((a,b)=>b.record.startedAt.localeCompare(a.record.startedAt)),invalid:invalid+[...counts.values()].filter(n=>n>1).length,truncated};
}
export const fixtureId=(id:string)=>z.uuid().parse(id);
