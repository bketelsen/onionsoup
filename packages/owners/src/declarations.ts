import { ChatContextPolicy } from './chat-context.ts';
import { Span } from './span.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { MemoryPolicy } from './memory-config.ts';
import { expandHome } from './paths.ts';

export const ModelRef = z.string().regex(/^[^/\s]+\/\S+$/, 'model must be provider/model');
export type ModelRef = z.infer<typeof ModelRef>;

export const Duty = z.object({
  id: z.string(),
  /**
   * survey: look at the domain and propose work. request-instance: ask another owner for an instance.
   * maintain-prs: keep the owner's published PRs mergeable (record merges, rebase conflicts).
   */
  kind: z.enum(['survey', 'request-instance', 'maintain-prs', 'app-updates']).default('survey'),
  every: Span.optional(),
  on: z.string().optional(),
  instructions: z.string(),
  requestTo: z.string().optional(),
  followUp: z.string().optional(),
  /** What a survey duty raises for the person: work the owner could plan with them, or attention items only they can act on. */
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

/** The icons the surface draws for owners and the operator. */
export const PersonaIcon = z.enum([
  'code', 'terminal', 'rocket', 'flask', 'gamepad', 'briefcase', 'home', 'globe', 'leaf', 'shield', 'palette', 'server', 'phone', 'database',
  'lightbulb', 'music', 'camera', 'book', 'heart',
]);

/** Who the owner is in conversation: a name, a title and a voice. Identity, not authority. */
export const Persona = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z-]+( [A-Z][A-Za-z-]+)?$/),
  title: z.string(),
  source: z.string(),
  voice: z.string(),
  /** Icon and color keys for the owner in the surface. */
  icon: PersonaIcon.default('briefcase'),
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
   * ship lets an owner deploy its repository where it runs; approve-plans lets this owner's manager (`to`) approve
   * the plans of work it carries out for the manager's initiatives.
   */
  action: z.enum(['publish-site', 'update-app', 'merge', 'ship', 'approve-plans']),
  /** The site, app or repository, or "*" for all of them. */
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
  duties: z.array(Duty),
  maxProposals: z.number().int().min(0).default(3),
  chatContext: ChatContextPolicy.default(() => ChatContextPolicy.parse({})),
  memory: MemoryPolicy.default(() => MemoryPolicy.parse({})),
  grants: z.array(Grant).default([]),
  /** Where the owner's repository runs, for the ship action: the running checkout and the units to restart. */
  deploy: z.object({
    checkout: z.string(),
    services: z.array(z.string()).min(1),
  }).optional(),
  /**
   * Stewardship: this owner may create, change and retire owners whose domain (repository, org or host name)
   * matches one of these globs, with the person's approval for each write. Authority fields stay the person's.
   */
  manages: z.object({ owners: z.array(z.string()).min(1) }).optional(),
  /** MCP tool servers this owner uses in chats, keyed by a short name. */
  mcp: z.record(z.string().regex(/^[a-z][a-z0-9]*$/), OwnerToolServer).default({}),
  /** The owner this one reports to: its manager's assignments are accepted automatically. Read it through managerOf. */
  reportsTo: z.string().optional(),
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

/**
 * Whether an owner changes its domain itself: it owns repositories, and has a persona to plan and work in sessions.
 * Others raise attention items for the person instead.
 */
export function canChange(owner: OwnerDeclaration) {
  return ownsRepositories(owner) && Boolean(owner.persona);
}

/** An owner holds incus either as its whole domain or as an incus section beside a repository. */
export function hasIncus(owner: OwnerDeclaration) {
  return owner.domain.kind === 'incus' || owner.incus !== undefined;
}

/** Which models may implement (an owner's implementer subagent, conflict resolution) and review (another family). */
export const Craft = z.enum(['implementation', 'review']);
export type Craft = z.infer<typeof Craft>;

/** Crafts of the retired freelancer pipeline: a person's config may still declare them, and they are skipped. */
const RETIRED_CRAFTS = new Set(['planning']);

export const FreelancerDeclaration = z.object({
  craft: Craft,
  models: z.array(ModelRef).min(1),
});
export type FreelancerDeclaration = z.infer<typeof FreelancerDeclaration>;

export const FamilyTable = z.object({
  families: z.array(z.object({ family: z.string(), match: z.array(z.string()).min(1) })),
});
export type FamilyTable = z.infer<typeof FamilyTable>;

/** The id the operator's chat and journal go by; no owner may take it. */
export const OPERATOR_ID = 'operator';
export const OPERATOR_FILE = 'operator.yaml';

/**
 * The person's operator (operator.yaml): one nearly unrestricted agent the person directs in a chat of its own,
 * outside the owners' rules. Absent file, no operator.
 */
export const OperatorDeclaration = z.object({
  /** Its agent name in opencode and the surface, with the title and icon the surface shows. */
  name: Persona.shape.name.default('Operator'),
  title: z.string().min(1).default('Acts for you'),
  icon: PersonaIcon.default('terminal'),
  model: ModelRef,
  /** Where its chats run; ~/ is expanded. */
  directory: z.string().min(1).default('~/projects').transform(expandHome),
  /** Bash patterns that ask the person, on top of the built-in irreversible ones. */
  ask: z.array(z.string().min(1)).default([]),
});
export type OperatorDeclaration = z.infer<typeof OperatorDeclaration>;

export interface Declarations {
  root: string;
  owners: Map<string, OwnerDeclaration>;
  freelancers: Map<Craft, FreelancerDeclaration>;
  families: FamilyTable;
  operator?: OperatorDeclaration;
}

async function yamlFiles(directory: string) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.yaml'));
  return Promise.all(names.map(async name => parse(await readFile(join(directory, name), 'utf8')) as unknown));
}

async function loadAll<T>(directory: string, schema: z.ZodType<T>) {
  return (await yamlFiles(directory)).map(document => schema.parse(document));
}

function isRetiredCraft(document: unknown) {
  const craft = (document as { craft?: unknown } | null)?.craft;
  return typeof craft === 'string' && RETIRED_CRAFTS.has(craft);
}

async function loadFreelancers(directory: string) {
  return (await yamlFiles(directory)).filter(document => !isRetiredCraft(document)).map(document => FreelancerDeclaration.parse(document));
}

/** The reporting line must name declared owners and never loop back on itself. */
export function checkOrgChart(owners: ReadonlyMap<string, OwnerDeclaration>) {
  for (const owner of owners.values()) {
    if (owner.reportsTo === undefined) continue;
    if (owner.reportsTo === owner.id) throw new Error(`org_chart_self: ${owner.id} reports to itself`);
    if (!owners.has(owner.reportsTo)) throw new Error(`org_chart_unknown_manager: ${owner.id} reports to ${owner.reportsTo}, which is not declared`);
  }
  for (const owner of owners.values()) checkNoCycle(owners, owner.id);
  for (const owner of owners.values()) checkPlanGrants(owner);
}

/** Only an owner's manager may hold its approve-plans grant. */
function checkPlanGrants(owner: OwnerDeclaration) {
  const misplaced = owner.grants.find(grant => grant.action === 'approve-plans' && grant.to !== owner.reportsTo);
  if (misplaced) throw new Error(`grant_not_to_manager: ${owner.id} grants approve-plans to ${misplaced.to}, who is not its manager`);
}

/** The person's standing approval for a manager to approve this owner's plans in one repository, if given. */
export function planGrantFor(owner: OwnerDeclaration, managerId: string, repository: string) {
  return owner.grants.find(grant => grant.action === 'approve-plans' && grant.to === managerId && (grant.target === repository || grant.target === '*'));
}

function checkNoCycle(owners: ReadonlyMap<string, OwnerDeclaration>, start: string) {
  const seen = new Set<string>([start]);
  for (let current = owners.get(start)?.reportsTo; current; current = owners.get(current)?.reportsTo) {
    if (seen.has(current)) throw new Error(`org_chart_cycle: ${[...seen, current].join(' → ')}`);
    seen.add(current);
  }
}

/** The owner an owner reports to, if any. */
export function managerOf(declarations: Declarations, ownerId: string) {
  const managerId = declarations.owners.get(ownerId)?.reportsTo;
  return managerId ? declarations.owners.get(managerId) : undefined;
}

/** The owners that report to this one. */
export function directReports(declarations: Declarations, managerId: string) {
  return [...declarations.owners.values()].filter(owner => owner.reportsTo === managerId);
}

export function isDirectReport(declarations: Declarations, managerId: string, reportId: string) {
  return managerOf(declarations, reportId)?.id === managerId;
}

/** operator.yaml, if the person wrote one. */
async function loadOperator(base: string) {
  const text = await readFile(join(base, OPERATOR_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const parsed = OperatorDeclaration.safeParse(parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`operator_invalid: ${OPERATOR_FILE}: ${issues}`);
  }
  return parsed.data;
}

/** The operator's id is never an owner's, and its name is never an owner persona's: both name one agent each. */
export function checkOperatorReserved(owners: ReadonlyMap<string, OwnerDeclaration>, operator: OperatorDeclaration | undefined) {
  if (owners.has(OPERATOR_ID)) throw new Error(`operator_reserved: no owner may have the id ${OPERATOR_ID}`);
  if (!operator) return;
  const name = operator.name.toLowerCase();
  const namesake = [...owners.values()].find(owner => owner.persona?.name.toLowerCase() === name);
  if (namesake) throw new Error(`operator_reserved: ${namesake.id} is called ${namesake.persona!.name}, the operator's name`);
}

export async function loadDeclarations(root: string): Promise<Declarations> {
  const base = resolve(root);
  const owners = await loadAll(join(base, 'owners'), OwnerDeclaration);
  const freelancers = await loadFreelancers(join(base, 'freelancers'));
  const families = FamilyTable.parse(parse(await readFile(join(base, 'families.yaml'), 'utf8')));
  const operator = await loadOperator(base);
  const ownersById = new Map(owners.map(owner => [owner.id, owner]));
  checkOrgChart(ownersById);
  checkOperatorReserved(ownersById, operator);
  return {
    root: base,
    owners: ownersById,
    freelancers: new Map(freelancers.map(freelancer => [freelancer.craft, freelancer])),
    families,
    operator,
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

