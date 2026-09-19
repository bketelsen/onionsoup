import {readFile} from 'node:fs/promises';
import {hash} from '../repository-brief/contracts.ts';
import {standardGoChecks,VerificationPlan,validateTask} from './repository-profile.ts';
import {GO_LIMITS} from './go-profile.ts';
import type {Job,Verification} from './contracts.ts';
export async function repositoryAdapterHash(adapter='go-module-v1') {
 if(adapter==='node-typescript-v1')return hash({adapter,definitions:await Promise.all(['repository-profile.ts','node-task-harness.mjs','node-task-verification.ts','task-verification.ts','sandbox.ts','contracts.ts','source.ts','container.ts'].map(async p=>[p,await readFile(new URL(p,import.meta.url),'utf8')]))});
 if(adapter!=='go-module-v1')throw new Error('Unknown adapter');
 return hash({adapter:'go-module-v1',limits:GO_LIMITS,definitions:await Promise.all(['repository-profile.ts','task-verification.ts','contracts.ts','source.ts','go-profile.ts','go-sandbox.ts','go-dependencies.ts','container.ts'].map(async p=>[p,await readFile(new URL(p,import.meta.url),'utf8')]))});
}
export function taskHarness(job:Job,raw:unknown) {
 if(job.schemaVersion!==2)throw new Error('Repository task required');validateTask(job.repositoryProfile,job.task,raw);const plan=VerificationPlan.parse(raw);if(plan.adapter!=='go-module-v1')throw new Error('Go checks required');
 // All executable strings below are fixed host commands; variable words pass closed schemas.
 const header=`#!/bin/sh
set -eu
mkdir -p /scratch/cache /scratch/tmp
export GOCACHE=/scratch/cache GOTMPDIR=/scratch/tmp
cd /work
nonce="$1"
check() { id="$1"; shift; set +e; "$@"; code=$?; set -e; printf '\\n%s:%s:%s\\n' "$nonce" "$id" "$code"; }
check go-build go build -o /scratch/application .
check go-test go test -count=1 -timeout=70s ./...
check go-vet go vet ./...
check gofmt /bin/sh -c 'test -z "$(gofmt -l .)"'
`;
 return header+plan.checks.filter(c=>c.kind==='go-test').map(c=>`check ${c.id} go test -json -overlay=/harness/overlay.json -count=1 -timeout=30s -run '^${c.test}$' .`).join('\n')+'\n';
}
export function evaluateTaskOutput(job:Job,raw:unknown,output:string,nonce:string,files:Record<string,string>):Verification['checks'] {
 if(job.schemaVersion!==2)throw new Error('Repository task required');validateTask(job.repositoryProfile,job.task,raw);const plan=VerificationPlan.parse(raw);if(plan.adapter!=='go-module-v1')throw new Error('Go checks required');
 const ids=[...standardGoChecks,...plan.checks.filter(c=>c.kind==='go-test').map(c=>c.id)],records=output.split('\n').filter(l=>l.startsWith(nonce+':'));
 if(records.length!==ids.length)throw new Error('Incomplete execution evidence');
 const lines=output.split('\n');
 const checks=ids.map(id=>{
  const matches=records.filter(l=>l.startsWith(nonce+':'+id+':'));if(matches.length!==1||!/^\d+$/.test(matches[0].split(':').at(-1)!))throw new Error('Invalid execution evidence');
  let passed=matches[0]===`${nonce}:${id}:0`;
  const def=plan.checks.find(c=>c.id===id);
  if(def?.kind==='go-test'){
   const end=lines.indexOf(matches[0]);let start=end-1;while(start>=0&&!lines[start].startsWith(nonce+':'))start--;
   const events=lines.slice(start+1,end).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
   passed&&=events.some(e=>e.Action==='pass'&&e.Test===def.test);
  }
  return {id,status:passed?'passed' as const:'failed' as const};
 });
 return [...checks,...plan.checks.filter(c=>c.kind==='file-changed').map(c=>({id:c.id,status:files[c.path]!==job.files[c.path]?'passed' as const:'failed' as const}))];
}
