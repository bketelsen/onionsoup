import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {atomicJson,readJson} from '../batch-store.ts';
import {hash} from '../repository-brief/contracts.ts';
import {git} from '../fixture-runner/fixture.ts';
import {liveModel} from '../providers.ts';
import {extractFeatureRequirements,draftChangeProposal,validateProposalAgentRun,type ProposalAgentRun} from '../change-proposal/agents.ts';
import {Proposal,FeatureRequirements} from '../change-proposal/contracts.ts';
import {sourceFiles} from './source.ts';
import {Job,validateJob,PROFILE,paths,type Files} from './contracts.ts';
export const requestText=`Operator-authored feature request, not a fetched GitHub issue: add publication-history filtering by status in Onionsoup's local console.
GET /publications defaults to all saved valid entries. Support one optional status query: all, prepared, approved, push_intent, branch_published, pr_intent, published, unknown, blocked. A valid specific status shows only matching entries. Invalid, empty or repeated status parameters return HTTP 400. Filtering is only for the list route; detail and artifact routes retain current behavior.
Provide a GET form with a status select, including All, preserving the selected status and allowing return to All. Keep unavailable/incomplete coverage warnings visible when filtered; empty selection results should be explicit. This is only a view over bounded saved history, never a model call, execution, publication or mutation. Preserve current authority, escaping and CSRF behavior.
Update docs/specs/draft-publication.md to describe the query values, default, invalid/repeated behavior, empty results and bounded coverage. No dependency, credential, test-policy or unrelated changes. Allowed files: src/publication/console.ts, src/console/server.ts, docs/specs/draft-publication.md.
Success will be checked with host-owned HTTP scenarios, typechecking and selected existing console compatibility tests; the model cannot change those checks.`;
export type ProjectProposal={schemaVersion:1;kind:'operator-project-proposal';requestId:string;repository:'bketelsen/onionsoup';commit:string;tree:string;files:Files;request:string;status:'running'|'completed'|'failed';reserved:number;requirements?:ProposalAgentRun;proposal?:ProposalAgentRun};
export function validateParent(raw:unknown):ProjectProposal {
  const p=raw as ProjectProposal;
  if(!p||p.schemaVersion!==1||p.kind!=='operator-project-proposal'||p.repository!=='bketelsen/onionsoup'||!z.uuid().safeParse(p.requestId).success||p.request!==requestText||p.status!=='completed'||p.reserved!==2)throw new Error('Incomplete project proposal');
  const r=validateProposalAgentRun(p.requirements),q=validateProposalAgentRun(p.proposal),input=q.input as any;
  if(r.agent!=='feature-requirements'||q.agent!=='change-proposal'||r.status!=='completed'||q.status!=='completed'||input.commit!==p.commit||input.packetId!==p.requestId||input.packetHash!==hash({requestId:p.requestId,text:p.request})||hash(input.requirements)!==hash(r.result)||hash(input.issue)!==hash((r.input as any).issue)||(r.input as any).issue.body!==p.request)throw new Error('Proposal handoff mismatch');
  for(const s of input.sources) {const text=p.files[s.path as keyof Files];if(typeof text!=='string'||text.split('\n').slice(s.startLine-1,s.endLine).join('\n')!==s.quote)throw new Error('Source citation changed');}
  return p;
}
export async function proposeProject(checkout:string,commit:string,directory:string,provider:'copilot'|'codex',options:{modelFactory?:typeof liveModel}={}) {
  if(!/^(git@github\.com:|https:\/\/github\.com\/)bketelsen\/onionsoup(?:\.git)?$/.test((await git(checkout,['remote','get-url','origin'])).trim()))throw new Error('Owned repository required');
  await mkdir(directory,{mode:0o700});const files=await sourceFiles(checkout,commit),p:ProjectProposal={schemaVersion:1,kind:'operator-project-proposal',requestId:randomUUID(),repository:'bketelsen/onionsoup',commit,tree:(await git(checkout,['rev-parse',commit+'^{tree}'])).trim(),files,request:requestText,status:'running',reserved:0};
  const save=()=>atomicJson(join(directory,'proposal.json'),p);await save();
  const issue={schemaVersion:1,repository:p.repository,number:1,title:'Operator request: filter publication history by status',body:p.request,updatedAt:new Date().toISOString()};
  // The existing snapshot envelope's number is a local request ordinal, never a GitHub issue identity.
  p.reserved++;await save();const adapter=await(options.modelFactory??liveModel)('gpt-5.6-terra',provider);
  if(adapter.provider!==provider||adapter.modelId!=='gpt-5.6-terra')throw new Error('Provider mismatch');
  p.requirements=await extractFeatureRequirements({schemaVersion:1,issue},{...adapter,checkpoint:async r=>{p.requirements=r;await save();}});
  if(p.requirements.status!=='completed'||FeatureRequirements.parse(p.requirements.result).status!=='sufficient_for_proposal'){p.status='failed';await save();return p;}
  const sources=paths.map((path,i)=>{
    const lines=files[path].split('\n');let start=path==='src/console/server.ts'?Math.max(0,lines.findIndex(l=>l.includes("parts[0]==='publications'"))-2):0;
    let end=start,quote='';while(end<lines.length&&(quote+lines[end]+'\n').length<=5500){quote+=(end===start?'':'\n')+lines[end];end++;}
    return {id:`source:${i+1}`,path,startLine:start+1,endLine:end,quote,relevance:'unassessed_search_lead'};
  });
  p.reserved++;await save();p.proposal=await draftChangeProposal({schemaVersion:1,packetId:p.requestId,packetHash:hash({requestId:p.requestId,text:p.request}),issue,commit,sources,
    limitations:['Operator-authored request with local ordinal 1, not a fetched GitHub issue.','Three pinned source excerpts; the host will inspect full allowed files before accepting. No execution or project acceptance yet.'],changeKind:'feature',requirements:p.requirements.result},
    {...adapter,checkpoint:async r=>{p.proposal=r;await save();}});
  p.status=p.proposal.status==='completed'?'completed':'failed';await save();return p;
}
export const proof=(r:ProposalAgentRun)=>({runId:r.runId,inputHash:r.inputHash,promptVersion:r.promptVersion,result:r.result});
export async function acceptProject(checkout:string,directory:string,mapping:Job['mapping'],reason:string) {
  const p=validateParent(await readJson(join(directory,'proposal.json')));
  if(Proposal.parse(p.proposal!.result).status!=='proposal_ready'||hash(await sourceFiles(checkout,p.commit))!==hash(p.files))throw new Error('Ready matching proposal required');
  const proposal=proof(p.proposal!),requirements=proof(p.requirements!);
  const j=validateJob({schemaVersion:1,kind:'accepted-project-job',jobId:randomUUID(),profile:PROFILE,repository:p.repository,baseCommit:p.commit,baseTree:p.tree,sourceHash:hash(p.files),files:p.files,parentHash:hash(p),
    proposal,proposalHash:hash(proposal),requirements,requirementsHash:hash(requirements),allowedFiles:paths,mapping,
    packageHash:hash(await git(checkout,['show',p.commit+':package.json'])),lockHash:hash(await git(checkout,['show',p.commit+':package-lock.json'])),profileHash:await (await import('./profile.ts')).profileHash(),acceptedAt:new Date().toISOString(),authority:'explicit_user_session',acceptedBy:'assistant_under_user_authority',reason});
  // Explicit one-shot acceptance; no replacement of existing authority.
  const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,'job.json'),JSON.stringify(j,null,2)+'\n',{flag:'wx',mode:0o600});return j;
}
