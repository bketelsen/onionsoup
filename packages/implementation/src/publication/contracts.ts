import {validateProject,type ProjectWorkflow} from '../project/record.ts';
import {z} from 'zod';
import {Digest} from '../fixture/contracts.ts';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {validateFixtureWorkflow,type FixtureWorkflow} from '../fixture/record.ts';
const Commit=z.string().regex(/^[a-f0-9]{40}$/);
export const Repository=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const Branch=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,99}$/).refine(s=>!s.endsWith('/')&&!s.includes('//'));
/** A bundle's target always names the exact base commit the candidate was built on. */
export const Target=z.object({repository:Repository,repositoryId:z.number().int().positive(),baseBranch:Branch,baseCommit:Commit}).strict();
/** An operator target may leave the base commit open: the candidate's own base is used and a moved branch does not block a draft PR. */
export const ConfiguredTarget=Target.extend({baseCommit:Commit.optional()}).strict();
export type ConfiguredTarget=z.infer<typeof ConfiguredTarget>;
export const PublicationConfig=z.object({schemaVersion:z.literal(1),stateDirectory:z.string().min(1),
  /** How long an approval stays valid for publishing. */
  approvalDays:z.number().int().min(1).max(3650).optional(),
  targets:z.array(ConfiguredTarget).min(1).max(50)}).strict().refine(c=>new Set(c.targets.map(t=>t.repository+':'+t.baseBranch)).size===c.targets.length,'Duplicate target');
export type PublicationConfig=z.infer<typeof PublicationConfig>;
const sameTarget=(configured:ConfiguredTarget,target:z.infer<typeof Target>)=>configured.repository===target.repository&&configured.repositoryId===target.repositoryId&&configured.baseBranch===target.baseBranch&&(configured.baseCommit===undefined||configured.baseCommit===target.baseCommit);
/** The configured target that covers a bundle target, if any. */
export function configuredTarget(c:PublicationConfig,target:z.infer<typeof Target>){return c.targets.find(t=>sameTarget(t,target));}
/** Whether the operator pinned this target's base commit, which makes a moved base block publication. */
export function pinnedBase(c:PublicationConfig,target:z.infer<typeof Target>){return configuredTarget(c,target)?.baseCommit!==undefined;}
/** Turn an operator target into a bundle target for a candidate built on `baseCommit`. */
export function resolveTarget(c:PublicationConfig,rawTarget:unknown,baseCommit:string):z.infer<typeof Target>{
  const requested=ConfiguredTarget.parse(rawTarget),target=Target.parse({...requested,baseCommit:requested.baseCommit??baseCommit});
  if(!configuredTarget(c,target))throw new Error('Target not configured');
  if(target.baseCommit!==baseCommit)throw new Error('Approved target and verified project required');
  return target;
}
export const FixtureBundle=z.object({schemaVersion:z.literal(1),kind:z.literal('fixture-publication'),workflowId:z.uuid(),publicationId:Digest,createdAt:z.iso.datetime(),
  target:Target,configHash:Digest,fixtureHash:Digest,fixture:z.unknown(),headCommit:Commit,headTree:Commit,
  branch:z.string().regex(/^codex\/onionsoup-[a-f0-9]{32}$/),diff:z.string().min(1).max(40000),diffHash:Digest,
  title:z.string().min(1).max(180),body:z.string().min(1).max(20000)}).strict();
export type FixtureBundle=Omit<z.infer<typeof FixtureBundle>,'fixture'> & {fixture:FixtureWorkflow};
export const ProjectBundle=FixtureBundle.omit({fixture:true,fixtureHash:true}).extend({schemaVersion:z.literal(2),kind:z.literal('project-publication'),project:z.unknown(),projectHash:Digest}).strict();
export type ProjectBundle=Omit<z.infer<typeof ProjectBundle>,'project'> & {project:ProjectWorkflow};
export const Bundle=z.discriminatedUnion('schemaVersion',[FixtureBundle,ProjectBundle]);
export type Bundle=FixtureBundle|ProjectBundle;
export const Approval=z.object({bundleHash:Digest,configHash:Digest,approvedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
  authority:z.enum(['console_operator','explicit_user_session']),reason:z.string().min(1).max(1000)}).strict();
export const Pull=z.object({number:z.number().int().positive(),url:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[a-zA-Z0-9_.-]+\/pull\/[1-9][0-9]*$/),repositoryId:z.number().int().positive(),
  headRepositoryId:z.number().int().positive(),baseRepositoryId:z.number().int().positive(),head:z.string(),headCommit:Commit,base:z.string(),baseCommit:Commit,
  title:z.string(),body:z.string(),draft:z.boolean(),state:z.enum(['open','closed']),merged:z.boolean()}).strict();
export type Pull=z.infer<typeof Pull>;
export const State=z.object({schemaVersion:z.literal(1),publicationId:Digest,bundleHash:Digest,
  status:z.enum(['prepared','approved','push_intent','branch_published','pr_intent','published','unknown','blocked']),
  approval:Approval.optional(),pull:Pull.optional(),events:z.array(z.object({sequence:z.number().int().nonnegative(),at:z.iso.datetime(),
    type:z.enum(['prepared','approved','push_intent','branch_published','pr_intent','published','unknown','blocked']),
    reason:z.enum(['operator_authorized','remote_observed','effect_intent','remote_uncertain','remote_conflict','stale_base','stale_approval','prepared']).optional()}).strict()).max(1000)}).strict();
export type State=z.infer<typeof State>;
export function identity(target:z.infer<typeof Target>,fixtureHash:string) {return hash({version:1,target,fixtureHash});}
export function validateBundle(raw:unknown):Bundle {
  const parsed=Bundle.parse(raw);
  if(parsed.schemaVersion===2) {
    const w=validateProject(parsed.project),b=parsed;
    if(w.job.schemaVersion===2&&(b.target.repositoryId!==w.job.repositoryProfile.repositoryId||b.target.baseBranch!==w.job.repositoryProfile.baseBranch))throw new Error('Publication profile identity changed');
    if(w.status!=='completed'||w.outcome!=='candidate_verified'||hash(w)!==b.projectHash||b.target.repository!==w.job.repository||b.target.baseCommit!==w.job.baseCommit||b.headCommit!==w.headCommit||b.headTree!==w.headTree||b.diff!==w.diff||b.diffHash!==hash(b.diff)||b.publicationId!==identity(b.target,b.projectHash)||b.branch!==`codex/onionsoup-${b.publicationId.slice(0,32)}`||!b.body.endsWith(`<!-- onionsoup-publication:${b.publicationId} -->`))throw new Error('Invalid project publication');
    return {...b,project:w};
  }
  const b=parsed,w=validateFixtureWorkflow(b.fixture);
  if(w.status!=='completed'||w.outcome!=='candidate_verified'||!w.diff||w.pendingExecution||hash(w)!==b.fixtureHash||
    b.target.baseCommit!==w.scope!.baseCommit||b.diff!==w.diff||b.diffHash!==hash(b.diff)||b.publicationId!==identity(b.target,b.fixtureHash)||
    b.branch!==`codex/onionsoup-${b.publicationId.slice(0,32)}`||!b.body.endsWith(`<!-- onionsoup-publication:${b.publicationId} -->`)) throw new Error('Invalid publication bundle');
  return {...b,fixture:w};
}
export function validateState(raw:unknown,b:Bundle):State {
  const s=State.parse(raw);
  if(s.publicationId!==b.publicationId||s.bundleHash!==hash(b)||!s.events.length||s.events.at(-1)!.type!==s.status||
    s.events.some((e,i)=>e.sequence!==i)||s.approval&&(s.approval.bundleHash!==s.bundleHash||s.approval.configHash!==b.configHash)||
    s.status!=='prepared'&&!s.approval||s.status==='published'&&!s.pull) throw new Error('Invalid publication state');
  return s;
}
