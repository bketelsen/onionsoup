import {definitionText} from '../definitions.ts';
import {readFile} from 'node:fs/promises';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {GO_PROFILE,projectProfile} from './profiles.ts';
import type {Verification} from './contracts.ts';
export const GO_LIMITS={memoryMiB:4096,pids:1024,cpus:4,scratchMiB:2048,wallMs:600000,outputBytes:2097152} as const;
export async function goProfileHash() {
 return hash({profile:projectProfile(GO_PROFILE),limits:GO_LIMITS,definitions:await Promise.all(['contracts.ts','profiles.ts','source.ts','go-profile.ts','go-sandbox.ts','go-dependencies.ts','go-harness.sh','go-checks.txt','container.ts'].map(async p=>[p,await definitionText(import.meta.url,p)]))});
}
export function goDocumentationSatisfied(text:string) {return /-bubble-color/.test(text)&&/\bRRGGBB\b/.test(text)&&/\bRRGGBBAA\b/.test(text)&&/FFFFBE/i.test(text)&&/default/i.test(text)&&/optional|without/i.test(text);}
export function evaluateGoOutput(output:string,nonce:string,docs:string):Verification['checks'] {
 const ids=projectProfile(GO_PROFILE).checks.filter(c=>c!=='documentation');
 const records=output.split('\n').filter(l=>l.startsWith(nonce+':'));
 if(records.length!==ids.length)throw new Error('Incomplete Go observations');
 return [...ids.map(id=>{
  const matches=records.filter(l=>l.startsWith(nonce+':'+id+':'));
  if(matches.length!==1||!/^\d+$/.test(matches[0].split(':').at(-1)!))throw new Error('Malformed Go observation');
  return {id,status:matches[0]===`${nonce}:${id}:0`?'passed' as const:'failed' as const};
 }),{id:'documentation',status:goDocumentationSatisfied(docs)?'passed':'failed'}];
}
