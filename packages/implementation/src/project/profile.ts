import {definitionText} from '../definitions.ts';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {validateBundle,validateState,identity,State,type Bundle} from '../publication/contracts.ts';
import {PROFILE,PROFILE_LIMITS,CheckId,type Verification} from './contracts.ts';
export const statuses=State.shape.status.options;
export async function profileHash(id:string=PROFILE) {
  if(id==='clippy-bubble-color-v1')return (await import('./go-profile.ts')).goProfileHash();
  if(id!==PROFILE)throw new Error('Unknown profile');
  return hash({profile:PROFILE,limits:PROFILE_LIMITS,definitions:await Promise.all(['profile.ts','profile-harness.mjs','sandbox.ts','contracts.ts','profiles.ts','source.ts','container.ts'].map(async p=>[p,await definitionText(import.meta.url,p)]))});
}
export function seedsFrom(raw:unknown) {
  const original=validateBundle(raw);if(original.schemaVersion!==1)throw new Error('Owned fixture seed required');
  return statuses.map((status,i)=>{
    const b=structuredClone(original);b.fixture.workflowId=randomUUID();b.fixtureHash=hash(b.fixture);b.publicationId=identity(b.target,b.fixtureHash);b.workflowId=randomUUID();b.branch='codex/onionsoup-'+b.publicationId.slice(0,32);
    b.title=`Profile item ${i}`;b.body=`Local scripted seed.\n<!-- onionsoup-publication:${b.publicationId} -->`;
    const bundle=validateBundle(b),at=new Date().toISOString();
    const pull={number:1,url:`https://github.com/${b.target.repository}/pull/1`,repositoryId:b.target.repositoryId,headRepositoryId:b.target.repositoryId,baseRepositoryId:b.target.repositoryId,head:b.branch,headCommit:b.headCommit,base:b.target.baseBranch,baseCommit:b.target.baseCommit,title:b.title,body:b.body,draft:true,state:'open',merged:false};
    const state=validateState({schemaVersion:1,publicationId:b.publicationId,bundleHash:hash(b),status,
      ...(status==='prepared'?{}:{approval:{bundleHash:hash(b),configHash:b.configHash,approvedAt:at,expiresAt:new Date(Date.now()+86400000).toISOString(),authority:'explicit_user_session',reason:'Synthetic verification seed, never live authority.'}}),
      ...(status==='published'?{pull}:{}),events:[{sequence:0,at,type:status}]},bundle);
    return {bundle,state};
  });
}
export function evaluateObservations(raw:any,seeds:ReturnType<typeof seedsFrom>):Verification['checks'] {
  if(!Array.isArray(raw.responses)||raw.responses.length!==statuses.length+9)throw new Error('Incomplete observations');
  const get=(q:string)=>{const values=raw.responses.filter((r:any)=>r.query===q);if(values.length!==1||typeof values[0].html!=='string'||values[0].html.length>200000)throw new Error('Invalid observation');return values[0];};
  const ids=(html:string)=>[...html.matchAll(/href="\/publications\/([a-f0-9]{64})"/g)].map(m=>m[1]).sort();
  const all=seeds.map(s=>s.bundle.publicationId).sort(),base=get(''),explicit=get('?status=all');
  const check=(id:typeof CheckId.options[number],passed:boolean)=>({id,status:passed?'passed' as const:'failed' as const});
  return [check('default-history',base.status===200&&explicit.status===200&&hash(ids(base.html))===hash(all)&&hash(ids(explicit.html))===hash(all)),
    check('status-filter',statuses.every(status=>{const r=get('?status='+status);return r.status===200&&hash(ids(r.html))===hash(seeds.filter(s=>s.state.status===status).map(s=>s.bundle.publicationId));})),
    check('invalid-filter',['?status=bogus','?status=blocked&status=unknown','?status='].every(q=>get(q).status===400)),
    check('filter-controls',get('empty-status').status===200&&ids(get('empty-status').html).length===0&&/no (?:[^<]{0,100})(?:match|publication|result|entr)/i.test(get('empty-status').html)&&statuses.every(status=>{const h=get('?status='+status).html;return /<form[^>]*method="get"/i.test(h)&&/<select[^>]*name="status"/i.test(h)&&new RegExp(`<option[^>]*value="${status}"[^>]*selected`).test(h)&&/<option[^>]*value="all"/.test(h);})),
    check('coverage-preserved',[base,...statuses.map(s=>get('?status='+s))].every(r=>/unavailable|incomplete|invalid|unreadable/i.test(r.html))&&raw.writes===0),
    check('detail-unchanged',['','/json','/events'].every(s=>get('/'+seeds[0].bundle.publicationId+s+'?status=bogus').status===200)),
    check('typecheck',raw.typecheck?.code===0),check('adjacent-console',raw.adjacent?.code===0&&/pass [1-9]/.test(raw.adjacent?.output??''))];
}

export function documentationSatisfied(text:string) {return /GET \/publications/.test(text)&&statuses.every(s=>text.includes(s))&&/all/i.test(text)&&/default|omitt|without|no [`\"]?status/i.test(text)&&/\b400\b/.test(text)&&/repeat|duplicate/i.test(text)&&/empty/i.test(text)&&/bounded|300/.test(text)&&/filter/i.test(text);}
