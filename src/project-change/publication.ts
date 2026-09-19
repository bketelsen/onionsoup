import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,atomicJson,optionalJson} from '../batch-store.ts';
import {hash} from '../repository-brief/contracts.ts';
import {git} from '../fixture-runner/fixture.ts';
import {PublicationConfig,Target,identity,validateBundle,validateState,type ProjectBundle,type State} from '../publication/contracts.ts';
import {locked,directory,loadState,assertConfig,validateCommit} from '../publication/bundle.ts';
import {validateProject} from './record.ts';
import {ReviewResult} from './contracts.ts';
export async function prepareProjectPublication(c:PublicationConfig,projectDirectory:string,rawTarget:unknown):Promise<ProjectBundle> {
  PublicationConfig.parse(c);const target=Target.parse(rawTarget),w=validateProject(await readJson(join(projectDirectory,'project.json')));
  if(w.outcome!=='candidate_verified'||target.repository!==w.job.repository||target.baseCommit!==w.job.baseCommit||!c.targets.some(t=>hash(t)===hash(target)))throw new Error('Approved target and verified project required');
  const id=identity(target,hash(w));
  return locked(c,async()=>{
    const dir=directory(c,id),prior=await optionalJson(join(dir,'bundle.json'));if(prior){const b=validateBundle(prior);assertConfig(c,b);await loadState(c,b);if(b.schemaVersion!==2)throw new Error('Project bundle required');return b;}
    await mkdir(dir,{mode:0o700});await git(dir,['clone','--no-local','--quiet','--no-checkout',resolve(projectDirectory,'candidate'),join(dir,'git')]);
    const review=ReviewResult.parse(w.stages[1].run!.result);
    const body=[w.job.proposal.result.outcome.text,'Request kind: feature. This is the first owned-project proposal-to-draft trial. Human code-quality acceptance is not recorded.',
      'Accepted criteria and evidence:\n'+w.job.proposal.result.acceptanceCriteria.map(a=>`- ${a.id}: ${a.criterion.text}\n  Checks: ${w.job.mapping.find(m=>m.criterionId===a.id)!.checks.map(id=>`${id}: ${w.candidate!.checks.find(c=>c.id===id)!.status}`).join(', ')}`).join('\n'),
      `Baseline: ${w.baseline!.status}; candidate: ${w.candidate!.status}. The baseline's new-feature gaps are not existing bug claims. Fixed host checks ran offline in the project sandbox; this does not claim GitHub CI passed.`,
      'Separate-context review: no blocking findings.\n'+review.findings.map(f=>`- ${f.severity}: ${f.path}:${f.line}: ${f.explanation}`).join('\n'),
      'Limits:\n'+review.limitations.map(s=>'- '+s).join('\n'),
      `Provenance: project workflow ${w.workflowId}; accepted job ${w.job.jobId}; proposal run ${w.job.proposal.runId}; record hash ${hash(w)}; diff ${w.diffHash}; baseline receipt ${w.baseline!.receiptId}; candidate receipt ${w.candidate!.receiptId}; dependency tree ${w.dependencies.treeHash}; profile ${w.job.profileHash}. Raw evidence remains local. No merge authorized.`,
      `<!-- onionsoup-publication:${id} -->`].join('\n\n');
    const b=validateBundle({schemaVersion:2,kind:'project-publication',workflowId:randomUUID(),publicationId:id,createdAt:new Date().toISOString(),target,configHash:hash(c),projectHash:hash(w),project:w,
      headCommit:w.headCommit,headTree:w.headTree,branch:`codex/onionsoup-${id.slice(0,32)}`,diff:w.diff,diffHash:w.diffHash,title:'Filter publication history by status',body});
    if(b.schemaVersion!==2)throw new Error('Project bundle required');await validateCommit(c,b);await writeFile(join(dir,'candidate.patch'),b.diff,{mode:0o600,flag:'wx'});await atomicJson(join(dir,'bundle.json'),b);
    const s:State={schemaVersion:1,publicationId:id,bundleHash:hash(b),status:'prepared',events:[{sequence:0,at:b.createdAt,type:'prepared',reason:'prepared'}]};await atomicJson(join(dir,'state.json'),validateState(s,b));return b;
  });
}
