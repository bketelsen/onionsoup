import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {Files,Scope,type FixtureCase} from './contracts.ts';
export const git=async(directory:string,args:string[])=> (await promisify(execFile)('/usr/bin/git',['-C',directory,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],
  {timeout:10000,maxBuffer:8000000,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout;
export async function createFixture(directory:string) {
  await mkdir(directory,{mode:0o700});
  const files=Files.parse(Object.fromEntries(await Promise.all(['tasks.mjs','README.md'].map(async path=>[path,await readFile(fileURLToPath(new URL('../../../../examples/fixture-project/'+path,import.meta.url)),'utf8')]))));
  for(const [path,content] of Object.entries(files)) await writeFile(join(directory,path),content,{mode:0o600,flag:'wx'});
  await git(directory,['init','-q']);await git(directory,['add','--','tasks.mjs','README.md']);
  await git(directory,['-c','user.name=Onionsoup Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Owned verification baseline']);
  return {files,commit:(await git(directory,['rev-parse','HEAD'])).trim()};
}
export function acceptedScope(which:FixtureCase,files:Files,commit:string):Scope {
  const c=(text:string)=>({text,basis:'reported' as const,evidenceIds:['issue:body']});
  const criteria=which==='bug'?[
    {id:'AC1',criterion:c('completedCount counts only tasks with done exactly boolean true, including empty input and mixed true/false/truthy values.')},
    {id:'AC2',criterion:c('listTasks keeps input order and newline joining, including empty lists and names with Unicode/newlines.')}]:[
    {id:'AC1',criterion:c('Add named export exportTasks(tasks), returning a JSON string of name-only objects in input order, preserving Unicode and JSON escaping; empty input returns [] as a string.')},
    {id:'AC2',criterion:c('Preserve listTasks and completedCount current behavior; fixing the separate completed-count defect is outside this feature.')},
    {id:'AC3',criterion:c('Document exportTasks with a usage example in README.md. No persistence, dependencies, schema versioning or migration.')}];
  const proposal={schemaVersion:1 as const,status:'proposal_ready' as const,outcome:c(which==='bug'?'Correct completed-count boolean semantics.':'Add a JSON task export.'),
    changes:[c(which==='bug'?'Correct completedCount only.':'Add exportTasks and document it.')],nonGoals:[c('No dependencies, shell commands, networking, changes to tests or unrelated behavior.')],
    acceptanceCriteria:criteria,verification:criteria.map(a=>({criterionIds:[a.id],kind:a.id==='AC3'?'documentation' as const:a.id==='AC2'?'compatibility' as const:which==='bug'?'regression' as const:'acceptance' as const,
      check:c(a.criterion.text),baselineExpectation:a.id==='AC1'?(which==='bug'?'reported_failure' as const:'capability_absent' as const):'existing_behavior' as const})),
    compatibility:c('Keep the unchanged function contracts.'),migration:c('No migration; dependency-free in-memory library.'),documentation:c(which==='bug'?'Existing documentation already states the intended boolean behavior.':'Add exportTasks documentation and an example.'),questions:[],risks:[c('Finite fixture checks cannot prove behavior for all inputs.')]};
  return Scope.parse({schemaVersion:1,scopeId:randomUUID(),case:which,baseCommit:commit,baseTree:hash(files),proposal,proposalHash:hash(proposal),
    allowedFiles:which==='bug'?['tasks.mjs']:['tasks.mjs','README.md'],authorization:'explicit_operator_owned_fixture_task',policyVersion:'fixture-policy-v1'});
}
export type Invocation={id:string;criterionIds:string[];name:string;args:unknown[];expected:unknown};
export function checks(which:FixtureCase,seed:string):Invocation[] {
  const names=[`task-${seed}`,'quote " and slash \\','snow ☃\nnext'];
  const tasks=names.map((name,i)=>({name,done:i===0?true:i===1?'false':false,private:'exclude'}));
  return [
    ...(which==='bug'?[{id:'strict-boolean',criterionIds:['AC1'],name:'completedCount',args:[tasks],expected:1},
      {id:'empty-count',criterionIds:['AC1'],name:'completedCount',args:[[]],expected:0},
      {id:'mixed-count',criterionIds:['AC1'],name:'completedCount',args:[[{done:1},{done:'yes'},{done:null},{done:true},{done:true}]],expected:2}]:[
      {id:'json-export',criterionIds:['AC1'],name:'exportTasks',args:[tasks],expected:JSON.stringify(tasks.map(({name})=>({name})))},
      {id:'empty-export',criterionIds:['AC1'],name:'exportTasks',args:[[]],expected:'[]'},
      {id:'count-compatibility',criterionIds:['AC2'],name:'completedCount',args:[tasks],expected:2}]),
    {id:'list-compatibility',criterionIds:['AC2'],name:'listTasks',args:[tasks],expected:names.join('\n')},
    {id:'empty-list',criterionIds:['AC2'],name:'listTasks',args:[[]],expected:''},
  ];
}
