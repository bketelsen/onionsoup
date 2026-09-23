import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const ModelRef = z.string().regex(/^[^/\s]+\/\S+$/, 'model must be provider/model');
export type ModelRef = z.infer<typeof ModelRef>;

export const Duty = z.object({
  id: z.string(),
  /**
   * survey: look at the domain and propose work. request-instance: ask another owner for an instance.
   * maintain-prs: keep the owner's published PRs mergeable (record merges, rebase conflicts).
   */
  kind: z.enum(['survey', 'request-instance', 'maintain-prs', 'app-updates']).default('survey'),
  every: z.string().regex(/^\d+[mhd]$/).optional(),
  on: z.string().optional(),
  instructions: z.string(),
  requestTo: z.string().optional(),
  followUp: z.string().optional(),
  /** What a survey duty produces: work items for freelancers, or attention items for the person. */
  raises: z.enum(['work', 'attention']).default('work'),
});
export type Duty = z.infer<typeof Duty>;

export const RepositoryDomain = z.object({
  kind: z.literal('git-repository'),
  name: z.string(),
  remote: z.string(),
  baseBranch: z.string(),
  /** Host-run verification after every implementation. Freelancer claims are not evidence. */
  verify: z.array(z.array(z.string()).min(1)).min(1),
});
export type RepositoryDomain = z.infer<typeof RepositoryDomain>;

/** The directory name a group member's checkout and desk use: the last part of owner/name. */
export function repositoryShortName(name: string) {
  return name.split('/').at(-1)!;
}

/**
 * Several related repositories owned together (e.g. an image platform). Each work item names one of them;
 * the runtime then treats the owner as that repository's owner, with its own checkout, desk and verification.
 */
export const RepositoryGroupDomain = z.object({
  kind: z.literal('repository-group'),
  /** The group's name, e.g. frostyard/image-platform. */
  name: z.string(),
  repositories: z.array(RepositoryDomain.omit({ kind: true })).min(2),
}).superRefine((group, context) => {
  const names = group.repositories.map(repository => repositoryShortName(repository.name));
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length) context.addIssue({ code: 'custom', path: ['repositories'], message: `repository names must differ after the owner: ${[...new Set(repeated)].join(', ')}` });
});
export type RepositoryGroupDomain = z.infer<typeof RepositoryGroupDomain>;

export const IncusPermission = z.enum(['observe', 'create', 'delete']);
export type IncusPermission = z.infer<typeof IncusPermission>;

export const IncusDomain = z.object({
  kind: z.literal('incus'),
  remotes: z.array(z.object({ name: z.string(), host: z.string(), allow: z.array(IncusPermission).min(1) })).min(1),
  /** Images an approved create may use; anything else is refused before a person is asked. */
  images: z.array(z.string()).min(1),
  namePrefix: z.string().default('onionsoup-'),
  maxManagedInstances: z.number().int().positive().default(3),
});
export type IncusDomain = z.infer<typeof IncusDomain>;

export const PermissionAction = z.enum(['allow', 'ask', 'deny']);

/** Who the owner is in conversation: a name, a title and a voice. Identity, not authority. */
export const Persona = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z-]+( [A-Z][A-Za-z-]+)?$/),
  title: z.string(),
  source: z.string(),
  voice: z.string(),
  /** OpenChamber project icon and color keys for the owner's desk. */
  icon: z.enum(['code', 'terminal', 'rocket', 'flask', 'gamepad', 'briefcase', 'home', 'globe', 'leaf', 'shield', 'palette', 'server', 'phone', 'database', 'lightbulb', 'music', 'camera', 'book', 'heart']).default('briefcase'),
  color: z.string().default('primary'),
});
export type Persona = z.infer<typeof Persona>;

/**
 * Rules for chats with a person. The person is present, so "ask" is cheap: the owner reaches for its
 * own tools first and anything else waits for the person's approval in the chat.
 */
export const ConversationMode = z.object({
  bash: z.record(z.string(), PermissionAction).default({ '*': 'ask' }),
  edit: PermissionAction.default('ask'),
  webfetch: PermissionAction.default('ask'),
});
export type ConversationMode = z.infer<typeof ConversationMode>;

/** A static site a NAS owner hosts: where it lives, which app serves it, and whose repository it is built from. */
export const HostedSite = z.object({
  id: z.string(),
  path: z.string().describe('Dataset directory holding site/ and its site.prev-* copies'),
  app: z.string().describe('TrueNAS app that bind-mounts site/'),
  url: z.string().describe('Where the published index.html can be fetched to verify'),
  source: z.string().describe('The owner whose repository the site is built from'),
  build: z.array(z.string()).min(1).describe('Build command run in the source checkout; {tools} and {out} are substituted'),
});
export type HostedSite = z.infer<typeof HostedSite>;

export const TruenasDomain = z.object({
  kind: z.literal('truenas'),
  mcp: z.object({ binary: z.string(), envFile: z.string(), tlsInsecure: z.boolean().default(false) }),
  ssh: z.object({ host: z.string(), user: z.string() }),
  sites: z.array(HostedSite).default([]),
});
export type TruenasDomain = z.infer<typeof TruenasDomain>;

/** A GitHub organization: observed read-only through gh; the owner watches over the org's repositories and owners. */
export const GithubOrgDomain = z.object({
  kind: z.literal('github-org'),
  org: z.string(),
  /** Repositories whose default-branch CI the snapshot checks; empty means all of them. */
  watch: z.array(z.string()).default([]),
});
export type GithubOrgDomain = z.infer<typeof GithubOrgDomain>;

/**
 * A standing approval the person grants in configuration: requests of this kind from this owner skip the
 * per-request human gate and are recorded as approved by the grant.
 */
export const Grant = z.object({
  to: z.string(),
  /**
   * publish-site and update-app are requests to another owner; merge lets an owner merge its own reviewed PRs;
   * ship lets an owner deploy its repository where it runs.
   */
  action: z.enum(['publish-site', 'update-app', 'merge', 'ship']),
  /** The site or app, or "*" for all of them. */
  target: z.string(),
});
export type Grant = z.infer<typeof Grant>;

/**
 * A tool server an owner uses in chats: any MCP server, visible to this owner alone. Rules map the server's
 * tool names (or "*") to allow, ask (the person approves in the chat) or deny (the tool is hidden).
 * This is how owners get new tools without onionsoup code.
 */
export const OwnerToolServer = z.object({
  command: z.array(z.string()).min(1),
  envFile: z.string().optional().describe('KEY=VALUE file (e.g. an .envrc) whose values become the server environment'),
  environment: z.record(z.string(), z.string()).default({}),
  rules: z.record(z.string(), PermissionAction).default({ '*': 'ask' }),
});
export type OwnerToolServer = z.infer<typeof OwnerToolServer>;

export const OwnerDeclaration = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  persona: Persona.optional(),
  conversation: ConversationMode.optional(),
  domain: z.discriminatedUnion('kind', [RepositoryDomain, RepositoryGroupDomain, IncusDomain, TruenasDomain, GithubOrgDomain]),
  /**
   * The directory the owner's sessions read: a checkout, or an evidence snapshot. The owner never writes it.
   * Optional: it defaults to <home>/checkouts/<id> for repositories and <home>/evidence/<id> otherwise.
   */
  workspace: z.string().optional(),
  model: ModelRef,
  /** Incus hosts a repository owner also holds (observe; create/delete behind approvals). */
  incus: IncusDomain.omit({ kind: true }).optional(),
  /** Workflow for change work items; owners without one raise attention items instead. */
  workflow: z.string().optional(),
  duties: z.array(Duty),
  maxProposals: z.number().int().min(0).default(3),
  grants: z.array(Grant).default([]),
  /** Where the owner's repository runs, for the ship action: the running checkout and the units to restart. */
  deploy: z.object({
    checkout: z.string(),
    services: z.array(z.string()).min(1),
    restartOpenChamber: z.boolean().default(false),
  }).optional(),
  /**
   * Stewardship: this owner may create, change and retire owners whose domain (repository, org or host name)
   * matches one of these globs, with the person's approval for each write. Authority fields stay the person's.
   */
  manages: z.object({ owners: z.array(z.string()).min(1) }).optional(),
  /** MCP tool servers this owner uses in chats, keyed by a short name. */
  mcp: z.record(z.string().regex(/^[a-z][a-z0-9]*$/), OwnerToolServer).default({}),
});
export type OwnerDeclaration = z.infer<typeof OwnerDeclaration>;
/**
 * An owner as the runtime uses it: its workspace resolved to a real directory. A group member's view also
 * carries its own desk directory (desks/<owner>/<repository>).
 */
export type ResolvedOwner = OwnerDeclaration & { workspace: string; desk?: string };
export type RepositoryOwner = ResolvedOwner & { domain: RepositoryDomain };
export type IncusOwner = ResolvedOwner & { domain: IncusDomain };
export type TruenasOwner = ResolvedOwner & { domain: TruenasDomain };

export function isTruenasOwner(owner: ResolvedOwner): owner is TruenasOwner {
  return owner.domain.kind === 'truenas';
}

export function isRepositoryOwner(owner: ResolvedOwner): owner is RepositoryOwner {
  return owner.domain.kind === 'git-repository';
}

/** Owners whose workspace is checkouts rather than a snapshot: one repository, or a group of them. */
export function ownsRepositories(owner: OwnerDeclaration) {
  return owner.domain.kind === 'git-repository' || owner.domain.kind === 'repository-group';
}

/** The repositories an owner owns, by full name. */
export function repositoryNames(owner: OwnerDeclaration) {
  if (owner.domain.kind === 'git-repository') return [owner.domain.name];
  if (owner.domain.kind === 'repository-group') return owner.domain.repositories.map(repository => repository.name);
  return [];
}

/** An owner holds incus either as its whole domain or as an incus section beside a repository. */
export function hasIncus(owner: OwnerDeclaration) {
  return owner.domain.kind === 'incus' || owner.incus !== undefined;
}

export const Craft = z.enum(['planning', 'implementation', 'review']);
export type Craft = z.infer<typeof Craft>;

export const FreelancerDeclaration = z.object({
  craft: Craft,
  rubric: z.string(),
  models: z.array(ModelRef).min(1),
});
export type FreelancerDeclaration = z.infer<typeof FreelancerDeclaration>;

export const StageId = z.enum(['plan', 'implement', 'review', 'land']);
export type StageId = z.infer<typeof StageId>;

export const WorkflowDeclaration = z.object({
  id: z.string(),
  plan: z.object({ craft: z.literal('planning'), gate: z.literal('human'), consultOwner: z.boolean() }),
  implement: z.object({ craft: z.literal('implementation') }),
  review: z.object({
    craft: z.literal('review'),
    familyDiffersFrom: z.array(z.enum(['plan', 'implement'])),
    maxRevisions: z.number().int().min(0),
    maxReplans: z.number().int().min(0),
  }),
});
export type WorkflowDeclaration = z.infer<typeof WorkflowDeclaration>;

export const FamilyTable = z.object({
  families: z.array(z.object({ family: z.string(), match: z.array(z.string()).min(1) })),
});
export type FamilyTable = z.infer<typeof FamilyTable>;

export interface Declarations {
  root: string;
  owners: Map<string, OwnerDeclaration>;
  freelancers: Map<Craft, FreelancerDeclaration>;
  workflows: Map<string, WorkflowDeclaration>;
  families: FamilyTable;
}

async function yamlFiles(directory: string) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.yaml'));
  return Promise.all(names.map(async name => parse(await readFile(join(directory, name), 'utf8')) as unknown));
}

async function loadAll<T>(directory: string, schema: z.ZodType<T>) {
  return (await yamlFiles(directory)).map(document => schema.parse(document));
}

export async function loadDeclarations(root: string): Promise<Declarations> {
  const base = resolve(root);
  const owners = await loadAll(join(base, 'owners'), OwnerDeclaration);
  const freelancers = await loadAll(join(base, 'freelancers'), FreelancerDeclaration);
  const workflows = await loadAll(join(base, 'workflows'), WorkflowDeclaration);
  const families = FamilyTable.parse(parse(await readFile(join(base, 'families.yaml'), 'utf8')));
  return {
    root: base,
    owners: new Map(owners.map(owner => [owner.id, owner])),
    freelancers: new Map(freelancers.map(freelancer => [freelancer.craft, freelancer])),
    workflows: new Map(workflows.map(workflow => [workflow.id, workflow])),
    families,
  };
}

export function requireOwner(declarations: Declarations, ownerId: string) {
  const owner = declarations.owners.get(ownerId);
  if (!owner) throw new Error(`unknown_owner: ${ownerId}`);
  return owner;
}

export function requireFreelancer(declarations: Declarations, craft: Craft) {
  const freelancer = declarations.freelancers.get(craft);
  if (!freelancer) throw new Error(`no_freelancer_for_craft: ${craft}`);
  return freelancer;
}

export function requireWorkflow(declarations: Declarations, workflowId: string) {
  const workflow = declarations.workflows.get(workflowId);
  if (!workflow) throw new Error(`unknown_workflow: ${workflowId}`);
  return workflow;
}
