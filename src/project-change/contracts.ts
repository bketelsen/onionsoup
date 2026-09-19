import {z} from 'zod';
import {hash,contextText} from '../repository-brief/contracts.ts';
import {Digest,Runtime} from '../fixture-runner/contracts.ts';
import {Proposal,FeatureRequirements} from '../change-proposal/contracts.ts';
import {validateProposalAgentRun,type ProposalAgentRun} from '../change-proposal/agents.ts';
export const PROFILE='onionsoup-publication-filter-v1' as const;
export const paths=['src/publication/console.ts','src/console/server.ts','docs/specs/draft-publication.md'] as const;
export const Path=z.enum(paths);
export const Files=z.record(Path,z.string().max(40000));
export type Files=z.infer<typeof Files>;
export const Commit=z.string().regex(/^[a-f0-9]{40}$/);
export const CheckId=z.enum(['default-history','status-filter','invalid-filter','filter-controls','coverage-preserved','detail-unchanged','documentation','typecheck','adjacent-console']);
export const PROFILE_LIMITS={version:PROFILE,files:3,contextCharacters:180000,steps:3,agentMs:180000,workflowMs:900000,memoryMiB:768,pids:128,cpus:2,tmpMiB:128,wallMs:90000,outputBytes:524288,invocations:2} as const;
export const Dependency=z.object({schemaVersion:z.literal(1),directory:z.string(),packageHash:Digest,lockHash:Digest,treeHash:Digest,nodeHash:Digest,npmHash:Digest,npmVersion:z.string(),scripts:z.literal('disabled'),registry:z.literal('https://registry.npmjs.org/'),createdAt:z.iso.datetime()}).strict();
export type Dependency=z.infer<typeof Dependency>;
export const Job=z.object({schemaVersion:z.literal(1),kind:z.literal('accepted-project-job'),jobId:z.uuid(),profile:z.literal(PROFILE),repository:z.literal('bketelsen/onionsoup'),baseCommit:Commit,baseTree:Commit,
  sourceHash:Digest,files:Files,parentHash:Digest,proposal:z.object({runId:z.uuid(),inputHash:Digest,promptVersion:z.string(),result:Proposal}).strict(),proposalHash:Digest,requirements:z.object({runId:z.uuid(),inputHash:Digest,promptVersion:z.string(),result:FeatureRequirements}).strict(),requirementsHash:Digest,
  allowedFiles:z.tuple([z.literal(paths[0]),z.literal(paths[1]),z.literal(paths[2])]),
  mapping:z.array(z.object({criterionId:z.string().regex(/^AC[1-9][0-9]*$/),checks:z.array(CheckId).min(1)}).strict()).min(1).max(8),
  packageHash:Digest,lockHash:Digest,profileHash:Digest,acceptedAt:z.iso.datetime(),authority:z.literal('explicit_user_session'),acceptedBy:z.literal('assistant_under_user_authority'),reason:z.string().min(1).max(1500)}).strict();
export type Job=z.infer<typeof Job>;
export function validateJob(raw:unknown):Job {
  const j=Job.parse(raw),result=j.proposal.result;
  if(result.status!=='proposal_ready'||result.questions.some(q=>q.blocking)||j.requirements.result.status!=='sufficient_for_proposal'||
    hash(j.proposal)!==j.proposalHash||hash(j.requirements)!==j.requirementsHash||hash(j.files)!==j.sourceHash||new Set(j.mapping.map(m=>m.criterionId)).size!==j.mapping.length||
    hash(j.mapping.map(m=>m.criterionId).sort())!==hash(result.acceptanceCriteria.map(c=>c.id).sort())||
    CheckId.options.some(id=>!j.mapping.some(m=>m.checks.includes(id)))) throw new Error('Accepted project job mismatch');
  return j;
}
export const Check=z.object({id:CheckId,status:z.enum(['passed','failed'])}).strict();
export const Verification=z.object({schemaVersion:z.literal(1),receiptId:z.uuid(),phase:z.enum(['baseline','candidate']),jobHash:Digest,tree:Commit,runtimeHash:Digest,dependencyHash:Digest,profileHash:Digest,seedHash:Digest,
  startedAt:z.iso.datetime(),finishedAt:z.iso.datetime(),status:z.enum(['passed','checks_failed','execution_error','timeout','output_limit','cancelled']),checks:z.array(Check),exitCode:z.number().int().nullable(),cleanup:z.enum(['removed','failed']),commandHash:Digest,outputHash:Digest,containerName:z.string().regex(/^onionsoup-project-[a-f0-9-]{36}$/)}).strict();
export type Verification=z.infer<typeof Verification>;
const BaseInput={schemaVersion:z.literal(2),job:Job,before:Files,fileHashes:z.record(Path,Digest),baseline:Verification};
export const PatchInput=z.object(BaseInput).strict();
export const PatchResult=z.object({schemaVersion:z.literal(2),status:z.enum(['candidate','needs_information']),summary:z.string().min(1).max(1000),edits:z.array(z.object({path:Path,beforeHash:Digest,content:z.string().min(1).max(40000)}).strict()).max(3),questions:z.array(z.string().min(1).max(600)).max(6)}).strict();
export const ReviewInput=z.object({...BaseInput,after:Files,candidate:Verification,diff:z.string().min(1).max(60000),diffHash:Digest}).strict();
export const ReviewResult=z.object({schemaVersion:z.literal(2),verdict:z.enum(['no_blocking_findings','changes_requested','insufficient_evidence']),findings:z.array(z.object({severity:z.enum(['blocking','advisory']),path:Path,line:z.number().int().positive(),criterionIds:z.array(z.string()).min(1),explanation:z.string().min(1).max(1200)}).strict()).max(10),limitations:z.array(z.string().min(1).max(800)).min(1).max(8)}).strict();
export type WorkerId='scoped-patch'|'change-review';
export const inputSchema=(id:WorkerId)=>id==='scoped-patch'?PatchInput:ReviewInput;
export const resultSchema=(id:WorkerId)=>id==='scoped-patch'?PatchResult:ReviewResult;
export function safeInput(id:WorkerId,raw:unknown) {
  const p=inputSchema(id).parse(raw),j=validateJob(p.job),text=JSON.stringify(p);
  if(text.length>PROFILE_LIMITS.contextCharacters||contextText(text)!==text||hash(p.before)!==j.sourceHash||p.baseline.jobHash!==hash(j)||p.baseline.phase!=='baseline'||p.baseline.tree!==j.baseTree||p.baseline.cleanup!=='removed')throw new Error('Invalid project context');
  if(paths.some(path=>p.fileHashes[path]!==hash(p.before[path])))throw new Error('Source hashes changed');
  if(id==='change-review'){const q=ReviewInput.parse(p);if(q.diffHash!==hash(q.diff)||q.candidate.jobHash!==hash(j)||q.candidate.phase!=='candidate'||q.candidate.dependencyHash!==q.baseline.dependencyHash||q.candidate.runtimeHash!==q.baseline.runtimeHash||q.candidate.profileHash!==j.profileHash||q.candidate.seedHash!==q.baseline.seedHash||q.candidate.cleanup!=='removed')throw new Error('Candidate evidence changed');}
  return p;
}
export function validateResult(id:WorkerId,raw:unknown,input:unknown) {
  const p=safeInput(id,input),r=resultSchema(id).parse(raw);
  if('edits'in r) {
    if(r.status==='candidate'?(!r.edits.length||r.questions.length>0):(r.edits.length>0||!r.questions.length))throw new Error('Patch outcome mismatch');
    if(new Set(r.edits.map(e=>e.path)).size!==r.edits.length||r.edits.some(e=>e.beforeHash!==hash(p.before[e.path])||e.content===p.before[e.path]))throw new Error('Denied project edit');
  }else {
    const q=ReviewInput.parse(p),criteria=q.job.proposal.result.acceptanceCriteria.map(c=>c.id);
    if(r.findings.some(f=>f.line>q.after[f.path].split('\n').length||f.criterionIds.some(id=>!criteria.includes(id))))throw new Error('Invalid review citation');
    if(r.verdict==='no_blocking_findings'&&(q.candidate.status!=='passed'||r.findings.some(f=>f.severity==='blocking'))||r.verdict==='changes_requested'&&!r.findings.some(f=>f.severity==='blocking'))throw new Error('Invalid review clearance');
  }
  if(contextText(JSON.stringify(r))!==JSON.stringify(r))throw new Error('Sensitive output');return r;
}
