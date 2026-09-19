import {z} from 'zod';
import {Proposal} from '../change-proposal/contracts.ts';
import {hash,contextText} from '../repository-brief/contracts.ts';
export const Digest=z.string().regex(/^[a-f0-9]{64}$/);
export const FilePath=z.enum(['tasks.mjs','README.md']);
export const Files=z.object({'tasks.mjs':z.string().min(1).max(16000),'README.md':z.string().min(1).max(8000)}).strict();
export type Files=z.infer<typeof Files>;
export const FixtureCase=z.enum(['bug','feature']);
export type FixtureCase=z.infer<typeof FixtureCase>;
export const Runtime=z.object({schemaVersion:z.literal(1),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  nodePath:z.string().min(1),nodeHash:Digest,podmanVersion:z.string().min(1).max(120)}).strict();
export type Runtime=z.infer<typeof Runtime>;
export const POLICY={version:'fixture-policy-v1',memoryMiB:256,pids:32,cpus:1,tmpMiB:8,wallMs:15000,outputBytes:65536,
  modelSteps:3,agentTimeoutMs:90000,workflowTimeoutMs:300000,invocations:2} as const;
export const Scope=z.object({schemaVersion:z.literal(1),scopeId:z.uuid(),case:FixtureCase,baseCommit:z.string().regex(/^[a-f0-9]{40}$/),
  baseTree:Digest,proposal:Proposal,proposalHash:Digest,allowedFiles:z.array(FilePath).min(1).max(2),
  authorization:z.literal('explicit_operator_owned_fixture_task'),policyVersion:z.literal('fixture-policy-v1')}).strict().superRefine((s,c)=>{
  if(s.proposalHash!==hash(s.proposal)||s.proposal.status!=='proposal_ready'||hash(s.allowedFiles)!==hash(s.case==='bug'?['tasks.mjs']:['tasks.mjs','README.md'])) c.addIssue({code:'custom',message:'Invalid accepted fixture scope'});
});
export type Scope=z.infer<typeof Scope>;
export const Check=z.object({id:z.string().regex(/^[a-z0-9-]+$/),criterionIds:z.array(z.string()).min(1),
  status:z.enum(['passed','assertion_failed','capability_absent']),reason:z.enum(['matched','value_mismatch','export_absent'])}).strict();
export const Receipt=z.object({schemaVersion:z.literal(1),receiptId:z.uuid(),phase:z.enum(['baseline','candidate','probe']),
  startedAt:z.iso.datetime(),finishedAt:z.iso.datetime(),treeHash:Digest,scopeHash:Digest,runtimeHash:Digest,policyHash:Digest,
  status:z.enum(['passed','assertion_failed','capability_absent','setup_error','execution_error','timeout','output_limit','cancelled']),
  checks:z.array(Check).max(30),exitCode:z.number().int().nullable(),oomKilled:z.boolean().nullable(),
  cleanup:z.enum(['removed','failed']),containerName:z.string().regex(/^onionsoup-fixture-[a-f0-9-]{36}$/),
  commandHash:Digest.optional(),definitionHash:Digest.optional(),caseSetHash:Digest,outputHash:Digest,outputBytes:z.number().int().nonnegative(),harnessHash:Digest,
}).strict();
export type Receipt=z.infer<typeof Receipt>;
export const PatchInput=z.object({schemaVersion:z.literal(1),scope:Scope,files:Files,fileHashes:z.object({'tasks.mjs':Digest,'README.md':Digest}).strict(),baseline:Receipt}).strict();
export const PatchResult=z.object({schemaVersion:z.literal(1),status:z.enum(['candidate','needs_information']),
  summary:z.string().min(1).max(800),edits:z.array(z.object({path:FilePath,beforeHash:Digest,content:z.string().min(1).max(16000)}).strict()).max(2),
  questions:z.array(z.string().min(1).max(500)).max(5)}).strict();
export type PatchResult=z.infer<typeof PatchResult>;
export const ReviewInput=z.object({schemaVersion:z.literal(1),scope:Scope,before:Files,after:Files,baseline:Receipt,candidate:Receipt,diff:z.string().min(1).max(40000),diffHash:Digest}).strict();
export const ReviewResult=z.object({schemaVersion:z.literal(1),verdict:z.enum(['no_blocking_findings','changes_requested','insufficient_evidence']),
  findings:z.array(z.object({severity:z.enum(['blocking','advisory']),path:FilePath,line:z.number().int().positive(),criterionIds:z.array(z.string()).min(1),
    explanation:z.string().min(1).max(1000)}).strict()).max(8),limitations:z.array(z.string().min(1).max(600)).min(1).max(6)}).strict();
export const FixtureAgentId=z.enum(['scoped-patch','change-review']);
export type FixtureAgentId=z.infer<typeof FixtureAgentId>;
export const inputSchema=(id:FixtureAgentId)=>id==='scoped-patch'?PatchInput:ReviewInput;
export const resultSchema=(id:FixtureAgentId)=>id==='scoped-patch'?PatchResult:ReviewResult;
export function safeInput(id:FixtureAgentId,raw:unknown) {
  const p=inputSchema(id).parse(raw),s=JSON.stringify(p);
  if(s.length>90000||contextText(s)!==s) throw new Error('Invalid or sensitive context');
  const before='files' in p?p.files:p.before;
  if(hash(before)!==p.scope.baseTree||p.baseline.treeHash!==p.scope.baseTree||p.baseline.scopeHash!==hash(p.scope)||p.baseline.phase!=='baseline'||p.baseline.cleanup!=='removed') throw new Error('Baseline binding mismatch');
  if('files' in p&&Object.entries(p.files).some(([path,text])=>p.fileHashes[path as keyof Files]!==hash(text))) throw new Error('File hash mismatch');
  if('after' in p&&p.diffHash!==hash(p.diff)) throw new Error('Diff hash mismatch');
  if('after' in p&&(p.candidate.treeHash!==hash(p.after)||p.candidate.scopeHash!==hash(p.scope)||p.candidate.phase!=='candidate'||p.candidate.runtimeHash!==p.baseline.runtimeHash||p.candidate.policyHash!==p.baseline.policyHash||p.candidate.caseSetHash!==p.baseline.caseSetHash||p.candidate.harnessHash!==p.baseline.harnessHash||p.candidate.cleanup!=='removed')) throw new Error('Candidate binding mismatch');
  return p;
}
export function validateResult(id:FixtureAgentId,raw:unknown,input:unknown) {
  const p=safeInput(id,input),r=resultSchema(id).parse(raw);
  if('edits' in r) {
    const i=PatchInput.parse(p),seen=new Set<string>();
    if(r.status==='candidate'?(!r.edits.length||r.questions.length>0):(r.edits.length>0||!r.questions.length)) throw new Error('Patch outcome mismatch');
    for(const e of r.edits) {
      if(seen.has(e.path)||!i.scope.allowedFiles.includes(e.path)||e.beforeHash!==hash(i.files[e.path])||e.content===i.files[e.path]) throw new Error('DENIED_EDIT: choose a changed allowed file with its exact beforeHash');
      seen.add(e.path);
    }
    Files.parse({...i.files,...Object.fromEntries(r.edits.map(e=>[e.path,e.content]))});
  } else {
    const i=ReviewInput.parse(p),ids=i.scope.proposal.acceptanceCriteria.map(c=>c.id);
    if(r.findings.some(f=>f.line>i.after[f.path].split('\n').length||f.criterionIds.some(id=>!ids.includes(id)))) throw new Error('Invalid review citation');
    if(r.verdict==='no_blocking_findings'&&(r.findings.some(f=>f.severity==='blocking')||i.candidate.status!=='passed')) throw new Error('Invalid review clearance');
    if(r.verdict==='changes_requested'&&!r.findings.some(f=>f.severity==='blocking')) throw new Error('Blocking finding required');
  }
  if(contextText(JSON.stringify(r))!==JSON.stringify(r)) throw new Error('Sensitive result');return r;
}
