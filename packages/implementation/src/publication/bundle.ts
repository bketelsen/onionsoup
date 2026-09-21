import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {atomicJson,readJson,optionalJson} from '@onionsoup/runtime/storage';
import {git} from '../fixture/fixture.ts';
import {validateFixtureWorkflow} from '../fixture/record.ts';
import {PublicationConfig,identity,validateBundle,validateState,configuredTarget,resolveTarget,type Bundle,type FixtureBundle,type State} from './contracts.ts';
export async function loadPublicationConfig(file:string) {
  const c=PublicationConfig.parse(await readJson(file));return {...c,stateDirectory:resolve(dirname(resolve(file)),c.stateDirectory)};
}
export function directory(config:PublicationConfig,id:string) {
  if(!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid publication identity');return join(config.stateDirectory,id);
}
export async function locked<T>(config:PublicationConfig,work:()=>Promise<T>) {
  await mkdir(config.stateDirectory,{recursive:true,mode:0o700});const lock=join(config.stateDirectory,'.publication.lock');await mkdir(lock,{mode:0o700});
  try {return await work();}finally {await rm(lock,{recursive:true});}
}
export async function loadBundle(config:PublicationConfig,id:string) {
  return validateBundle(await readJson(join(directory(config,id),'bundle.json')));
}
export async function loadState(config:PublicationConfig,b:Bundle) {
  return validateState(await readJson(join(directory(config,b.publicationId),'state.json')),b);
}
export function assertConfig(c:PublicationConfig,b:Bundle) {
  PublicationConfig.parse(c);
  if(hash(c)!==b.configHash||!configuredTarget(c,b.target)) throw new Error('Publication configuration changed');
}
export function bodyFor(w:ReturnType<typeof validateFixtureWorkflow>,id:string) {
  const review=w.stages[1].run!.result as {findings:Array<{severity:string;path:string;line:number;explanation:string}>;limitations:string[]};
  return [`Owned fixture ${w.case==='bug'?'bug fix':'feature addition'} produced by Onionsoup. This is a draft trial, not a general repair qualification.`,
    `Request kind: ${w.case==='bug'?'bug_fix':'feature'}.\n\n${w.scope!.proposal.outcome!.text}`,
    'Accepted criteria:\n'+w.scope!.proposal.acceptanceCriteria.map(c=>`- ${c.id}: ${c.criterion.text}`).join('\n'),
    `Verification: baseline **${w.baseline!.status}**; candidate **${w.candidate!.status}**.\n`+w.candidate!.checks.map(c=>`- ${c.id} (${c.criterionIds.join(', ')}): ${c.status}`).join('\n'),
    `Separate-context model review: no blocking findings. Human code acceptance: not recorded.\n`+review.findings.map(f=>`- ${f.severity}: ${f.path}:${f.line}: ${f.explanation}`).join('\n'),
    'Limits:\n'+[...review.limitations,'Finite owned-fixture checks; no external project qualification. No merge is authorized.','Checks ran locally in the isolated fixture runner; this PR does not claim GitHub CI ran.'].map(s=>'- '+s).join('\n'),
    `Evidence: workflow \`${w.workflowId}\`; fixture digest \`${hash(w)}\`; scope \`${w.scope!.scopeId}\`; diff \`${w.diffHash}\`; baseline receipt \`${w.baseline!.receiptId}\`; candidate receipt \`${w.candidate!.receiptId}\`; candidate content \`${w.candidate!.treeHash}\`; runtime \`${w.candidate!.runtimeHash}\`. Raw evidence remains in the operator's local artifact store.`,
    `<!-- onionsoup-publication:${id} -->`].join('\n\n');
}
export async function preparePublication(config:PublicationConfig,fixtureDirectory:string,rawTarget:unknown):Promise<FixtureBundle> {
  PublicationConfig.parse(config);
  const w=validateFixtureWorkflow(await readJson(join(fixtureDirectory,'fixture.json')));
  if(w.outcome!=='candidate_verified'||w.status!=='completed'||!w.scope) throw new Error('Verified exact-base candidate required');
  const target=resolveTarget(config,rawTarget,w.scope.baseCommit);
  const id=identity(target,hash(w));
  return locked(config,async()=>{
    const dir=directory(config,id),prior=await optionalJson(join(dir,'bundle.json'));
    if(prior) {const b=validateBundle(prior);assertConfig(config,b);await loadState(config,b);if(b.schemaVersion!==1)throw new Error('Fixture bundle required');return b;}
    await mkdir(dir,{mode:0o700});const checkout=join(dir,'git');
    await git(dir,['clone','--no-local','--quiet','--no-checkout',resolve(fixtureDirectory,'base'),checkout]);
    const entries=(await git(checkout,['ls-tree',target.baseCommit])).trim().split('\n');
    if(entries.length!==2||entries.some(e=>!/^100644 blob [a-f0-9]{40}\t(README.md|tasks.mjs)$/.test(e))) throw new Error('Only the owned two-file fixture is publishable');
    for(const [path,text] of Object.entries(w.before!)) if(await git(checkout,['show',`${target.baseCommit}:${path}`])!==text) throw new Error('Base contents changed');
    await git(checkout,['read-tree',target.baseCommit]);
    for(const [path,text] of Object.entries(w.after!)) await writeFile(join(checkout,path),text,{flag:'wx',mode:0o600});
    const diff=await git(checkout,['diff','--no-ext-diff','--no-textconv',target.baseCommit]);
    if(diff!==w.diff) throw new Error('Candidate diff differs from reviewed diff');
    const patchFile=join(dir,'candidate.patch');await writeFile(patchFile,diff,{flag:'wx',mode:0o600});
    // Reconstruct the exact exported diff independently before committing it.
    const check=join(dir,'apply-check');await git(dir,['clone','--quiet','--no-local',checkout,check]);
    await git(check,['checkout','--quiet',target.baseCommit]);await git(check,['apply',patchFile]);
    for(const [path,text] of Object.entries(w.after!)) if(await readFile(join(check,path),'utf8')!==text) throw new Error('Diff reconstruction failed');
    await git(checkout,['add','--','tasks.mjs','README.md']);const tree=(await git(checkout,['write-tree'])).trim();
    const head=(await git(checkout,['-c','user.name=Onionsoup Fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-p',target.baseCommit,'-m',`Owned fixture ${w.case} candidate ${id}`])).trim();
    const b=validateBundle({schemaVersion:1,kind:'fixture-publication',workflowId:randomUUID(),publicationId:id,createdAt:new Date().toISOString(),target,configHash:hash(config),fixtureHash:hash(w),fixture:w,
      headCommit:head,headTree:tree,branch:`codex/onionsoup-${id.slice(0,32)}`,diff,diffHash:hash(diff),
      title:w.case==='bug'?'Fix exact-boolean completed task count (fixture trial)':'Add JSON task export (fixture trial)',body:bodyFor(w,id)});
    if(b.schemaVersion!==1)throw new Error('Fixture bundle required');
    await atomicJson(join(dir,'bundle.json'),b);
    const s:State={schemaVersion:1,publicationId:id,bundleHash:hash(b),status:'prepared',events:[{sequence:0,at:b.createdAt,type:'prepared',reason:'prepared'}]};
    await atomicJson(join(dir,'state.json'),validateState(s,b));return b;
  });
}
export async function validateCommit(config:PublicationConfig,b:Bundle) {
  const repo=join(directory(config,b.publicationId),'git');
  const parent=(await git(repo,['rev-list','--parents','-n','1',b.headCommit])).trim();
  if(parent!==`${b.headCommit} ${b.target.baseCommit}`||(await git(repo,['rev-parse',`${b.headCommit}^{tree}`])).trim()!==b.headTree||
    await git(repo,['diff','--no-ext-diff','--no-textconv',b.target.baseCommit,b.headCommit])!==b.diff) throw new Error('Prepared commit changed');
  if(b.schemaVersion===2) {
    const paths=b.project.job.allowedFiles,changed=(await git(repo,['diff','--name-only',b.target.baseCommit,b.headCommit])).trim().split('\n');
    if(changed.some(p=>!paths.includes(p as any)))throw new Error('Project scope changed');
    for(const path of paths) {
      if(!/^100644 blob [a-f0-9]{40}\t/.test(await git(repo,['ls-tree',b.headCommit,'--',path]))||await git(repo,['show',`${b.headCommit}:${path}`])!==b.project.after![path])throw new Error('Project candidate changed');
    }
    return repo;
  }
  const entries=(await git(repo,['ls-tree',b.headCommit])).trim().split('\n');
  if(entries.length!==2||entries.some(e=>!/^100644 blob [a-f0-9]{40}\t(README.md|tasks.mjs)$/.test(e))) throw new Error('Candidate contains unexpected entries');
  for(const [path,text] of Object.entries(b.fixture.after!)) if(await git(repo,['show',`${b.headCommit}:${path}`])!==text) throw new Error('Commit differs from verified candidate');
  return repo;
}
