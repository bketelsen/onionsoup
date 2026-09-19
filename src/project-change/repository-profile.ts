import {z} from 'zod';
import {hash} from '../repository-brief/contracts.ts';
export const REPOSITORY_TASK='repository-task-v1' as const;
export const SafePath=z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/).refine(p=>!p.split('/').some(s=>['.','..','.git','node_modules'].includes(s)));
const Pattern=z.union([SafePath,z.string().endsWith('/**').refine(p=>SafePath.safeParse(p.slice(0,-3)).success)]);
const Digest=z.string().regex(/^[a-f0-9]{64}$/),Commit=z.string().regex(/^[a-f0-9]{40}$/);
export const standardGoChecks=['go-build','go-test','go-vet','gofmt'] as const;
export const RepositoryProfile=z.object({schemaVersion:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9-]{0,70}$/),repository:z.string().regex(/^bketelsen\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),repositoryId:z.number().int().positive(),baseBranch:z.string().regex(/^[\w/-]{1,100}$/),
 execution:z.object({adapter:z.literal('go-module-v1'),sandbox:z.literal('offline-go-v1'),toolchain:z.object({version:z.string().regex(/^go version go1\.\d+\.\d+ linux\/amd64$/),digest:Digest}).strict(),dependencies:z.literal('public-checksummed-go-v1')}).strict(),
 verification:z.object({required:z.tuple([z.literal('go-build'),z.literal('go-test'),z.literal('go-vet'),z.literal('gofmt')])}).strict(),
 changes:z.object({allowed:z.array(Pattern).min(1).max(30),protected:z.array(Pattern).max(30),maximumFiles:z.number().int().min(1).max(6),existingTests:z.literal('append-only')}).strict(),publication:z.literal('draft')}).strict();
export type RepositoryProfile=z.infer<typeof RepositoryProfile>;
export const TaskCheckId=z.string().regex(/^task-[a-z][a-z0-9-]{0,50}$/);
export const Task=z.object({schemaVersion:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9-]{0,70}$/),repositoryProfileHash:Digest,baseCommit:Commit,title:z.string().min(1).max(140),request:z.string().min(1).max(12000),allowedFiles:z.array(SafePath).min(1).max(6),
 context:z.array(z.object({path:SafePath,startLine:z.number().int().positive(),endLine:z.number().int().positive()}).strict()).min(1).max(7),
 verificationHash:Digest,checks:z.array(z.object({id:TaskCheckId,baseline:z.enum(['pass','fail','observe'])}).strict()).min(1).max(8)}).strict();
export type Task=z.infer<typeof Task>;
export const VerificationPlan=z.object({schemaVersion:z.literal(1),adapter:z.literal('go-module-v1'),source:z.string().min(1).max(30000),checks:z.array(z.discriminatedUnion('kind',[
 z.object({id:TaskCheckId,kind:z.literal('go-test'),test:z.string().regex(/^Test[A-Za-z0-9_]{1,100}$/)}).strict(),
 z.object({id:TaskCheckId,kind:z.literal('file-changed'),path:SafePath}).strict(),
])).min(1).max(8)}).strict();
export type VerificationPlan=z.infer<typeof VerificationPlan>;
const matches=(pattern:string,path:string)=>pattern.endsWith('/**')?path.startsWith(pattern.slice(0,-2)):pattern===path;
export function validateTask(rawProfile:unknown,rawTask:unknown,rawPlan?:unknown) {
 const profile=RepositoryProfile.parse(rawProfile),task=Task.parse(rawTask);
 const denied=['.github/**','.onionsoup/**','go.mod','go.sum','resources/**',...profile.changes.protected];
 if(task.repositoryProfileHash!==hash(profile)||new Set(task.allowedFiles).size!==task.allowedFiles.length||task.allowedFiles.length>profile.changes.maximumFiles||
  task.allowedFiles.some(p=>denied.some(d=>matches(d,p))||!profile.changes.allowed.some(a=>matches(a,p)))||
  task.context.some(c=>!task.allowedFiles.includes(c.path)||c.endLine<c.startLine)||new Set(task.checks.map(c=>c.id)).size!==task.checks.length)throw new Error('Task exceeds repository policy');
 if(rawPlan!==undefined){const plan=VerificationPlan.parse(rawPlan);
  if(hash(plan)!==task.verificationHash||hash(plan.checks.map(c=>c.id).sort())!==hash(task.checks.map(c=>c.id).sort())||plan.checks.some(c=>c.kind==='file-changed'&&!task.allowedFiles.includes(c.path)))throw new Error('Task checks changed');
  for(const c of plan.checks)if(c.kind==='go-test'&&!new RegExp(`^func ${c.test}\\(t \\*testing\\.T\\) \\{`,'m').test(plan.source))throw new Error('Declared host test missing');
 }
 return {profile,task};
}
export function profilePolicy(profile:RepositoryProfile,task:Task) {return {repository:profile.repository,title:task.title,request:task.request,paths:task.allowedFiles,manifests:['go.mod','go.sum'] as const,language:'go' as const,checks:[...standardGoChecks,...task.checks.map(c=>c.id)],baseline:[...standardGoChecks,...task.checks.filter(c=>c.baseline==='pass').map(c=>c.id)]};}
