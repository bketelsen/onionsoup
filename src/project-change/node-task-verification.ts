import {z} from 'zod';
import {NodeVerificationPlan,NodeRepositoryProfile,validateTask} from './repository-profile.ts';
import type {Job,Verification} from './contracts.ts';
const Command=z.object({code:z.number().int().nullable(),stdout:z.string().max(200000),stderr:z.string().max(200000),overflow:z.boolean()}).strict();
const Observations=z.object({nonce:z.string(),typecheck:Command,tests:Command,checks:z.array(z.object({id:z.string(),status:z.enum(['passed','failed'])}).strict()).max(8)}).strict();
export function nodeTestEvidence(output:string) {
 const values:Record<string,number>={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const matches=[...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`,'gm'))];
  if(matches.length!==1)return false;values[key]=Number(matches[0][1]);
 }
 return values.tests>0&&values.pass===values.tests&&['fail','cancelled','skipped','todo'].every(k=>values[k]===0);
}
export function nodeTaskInput(job:Job,raw:unknown,nonce:string){
 if(job.schemaVersion!==2)throw new Error('Repository task required');
 validateTask(job.repositoryProfile,job.task,raw);const profile=NodeRepositoryProfile.parse(job.repositoryProfile),plan=NodeVerificationPlan.parse(raw);
 return {nonce,testFiles:profile.verification.testFiles,checks:plan.checks.filter(c=>c.kind==='node-check')};
}
export function evaluateNodeTask(job:Job,raw:unknown,observations:unknown,nonce:string,files:Record<string,string>):Verification['checks']{
 const input=nodeTaskInput(job,raw,nonce),plan=NodeVerificationPlan.parse(raw),o=Observations.parse(observations);
 if(o.nonce!==nonce||o.checks.length!==input.checks.length||input.checks.some(c=>o.checks.filter(r=>r.id===c.id).length!==1))throw new Error('Incomplete Node check evidence');
 const check=(id:string,pass:boolean)=>({id,status:pass?'passed' as const:'failed' as const});
 return [check('node-typecheck',o.typecheck.code===0&&!o.typecheck.overflow),check('node-tests',o.tests.code===0&&!o.tests.overflow&&nodeTestEvidence(o.tests.stdout)),...o.checks,
  ...plan.checks.filter(c=>c.kind==='file-changed').map(c=>check(c.id,typeof files[c.path]==='string'&&files[c.path]!==job.files[c.path]))];
}
