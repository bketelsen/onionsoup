import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const ModelRef = z.string().regex(/^[^/\s]+\/\S+$/, 'model must be provider/model');
export type ModelRef = z.infer<typeof ModelRef>;

export const Duty = z.object({
  id: z.string(),
  every: z.string().optional(),
  on: z.string().optional(),
  instructions: z.string(),
});
export type Duty = z.infer<typeof Duty>;

export const OwnerDeclaration = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  domain: z.object({ kind: z.literal('git-repository'), name: z.string(), remote: z.string() }),
  checkout: z.string(),
  baseBranch: z.string(),
  verify: z.array(z.array(z.string()).min(1)).min(1),
  model: ModelRef,
  workflow: z.string(),
  duties: z.array(Duty),
  maxProposals: z.number().int().positive().default(3),
});
export type OwnerDeclaration = z.infer<typeof OwnerDeclaration>;

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
