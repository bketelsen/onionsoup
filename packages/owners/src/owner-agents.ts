import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireFreelancer, type Craft, type Declarations, type OwnerDeclaration } from './declarations.ts';
import { familyOf, pickModel } from './families.ts';
import { IMPLEMENTER_BASH, READ_ONLY_BASH } from './opencode.ts';
import { REVIEW_SEVERITIES } from './repository-writing.ts';

/**
 * Owners run their own work: process lives in skills (adapted from obra/superpowers, see skills/NOTICE), and an
 * owner dispatches subagents for small tasks. Authority stays in configuration: the implementer's model comes from
 * the implementation freelancer, and each owner's reviewer is a review freelancer model outside the owner's family.
 */
export const SKILLS_DIRECTORY = fileURLToPath(new URL('../skills/', import.meta.url));
export const BOOTSTRAP_SKILL = 'using-onionsoup-skills';
/** The person's skills for running onionsoup itself (this repository's .agents/skills), registered for the operator. */
export const OPERATOR_SKILLS_DIRECTORY = fileURLToPath(new URL('../../../.agents/skills/', import.meta.url));
export const OPERATOR_SKILLS = ['operate-onionsoup', 'ship-onionsoup', 'create-owner'] as const;

/** Owners and their subagents never load the person's operating skills: those act on onionsoup, not on a domain. */
export const NO_OPERATOR_SKILLS = { skill: Object.fromEntries(OPERATOR_SKILLS.map(name => [name, 'deny'])) } as const;
export const IMPLEMENTER_AGENT = 'onionsoup-implementer';

/** Each owner has its own reviewer, so the reviewer's family can differ from that owner's. */
export function reviewerAgent(ownerId: string) {
  return `onionsoup-reviewer-${ownerId}`;
}

/** Subagents never reach onionsoup tools: effects and records belong to the owner (and host code). */
export const NO_ONIONSOUP_TOOLS = { 'onionsoup_*': 'deny' } as const;

const IMPLEMENTER_PERMISSION = {
  edit: 'allow', bash: IMPLEMENTER_BASH, webfetch: 'deny', websearch: 'deny', task: 'deny', question: 'deny',
  external_directory: 'ask', doom_loop: 'ask', ...NO_ONIONSOUP_TOOLS, ...NO_OPERATOR_SKILLS,
};

const REVIEWER_PERMISSION = {
  edit: 'deny', bash: READ_ONLY_BASH, webfetch: 'deny', websearch: 'deny', task: 'deny', question: 'deny',
  external_directory: 'deny', doom_loop: 'deny', ...NO_ONIONSOUP_TOOLS, ...NO_OPERATOR_SKILLS,
};

const IMPLEMENTER_PROMPT = `You are an implementer an onionsoup owner dispatched for one small task on its desk (a git worktree).
Do exactly the task you were given, test it, and report what you changed and how you verified it. You may run any
command the repository needs; never commit, push, use gh or sudo: the owner proposes the finished work and host code
lands it after verification and review. If something in the task is unclear, say so in your report instead of guessing.`;

const REVIEWER_PROMPT = `You are a reviewer an onionsoup owner dispatched to check one task on its desk. You come from a
different model family than the owner. Read the change and what it was meant to do; never edit anything. Report
findings with a severity, the file, the issue and a suggestion, and say plainly whether the task is done. Use the same
scale the required review of the finished change uses, so a blocker you miss here is one it sends back later:
${REVIEW_SEVERITIES}`;

export interface Subagent { mode: 'subagent'; hidden: true; description: string; model: string; prompt: string; permission: Record<string, unknown> }

function modelFor(declarations: Declarations, craft: Craft, excludedFamilies: readonly string[]) {
  return pickModel(declarations.families, requireFreelancer(declarations, craft).models, excludedFamilies).model;
}

/** A subagent whose model the configuration cannot supply is left out, with its reason, rather than breaking chats. */
function defined(name: string, build: () => Subagent): [string, Subagent][] {
  try {
    return [[name, build()]];
  } catch (error) {
    console.warn(`onionsoup_subagent_unavailable: ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function implementer(declarations: Declarations): Subagent {
  return {
    mode: 'subagent', hidden: true, description: 'onionsoup: implements one small task on the owner\'s desk',
    model: modelFor(declarations, 'implementation', []), prompt: IMPLEMENTER_PROMPT, permission: IMPLEMENTER_PERMISSION,
  };
}

function reviewer(declarations: Declarations, owner: OwnerDeclaration): Subagent {
  return {
    mode: 'subagent', hidden: true, description: `onionsoup: reviews one task for ${owner.persona?.name ?? owner.id}, from another model family`,
    model: modelFor(declarations, 'review', [familyOf(declarations.families, owner.model)]), prompt: REVIEWER_PROMPT,
    permission: REVIEWER_PERMISSION,
  };
}

/** The implementer every owner shares, and one reviewer per owner. */
export function subagents(declarations: Declarations, owners: readonly OwnerDeclaration[]) {
  return Object.fromEntries([
    ...defined(IMPLEMENTER_AGENT, () => implementer(declarations)),
    ...owners.flatMap(owner => defined(reviewerAgent(owner.id), () => reviewer(declarations, owner))),
  ]);
}

/** An owner may start only its own subagents. */
export function taskPermission(ownerId: string) {
  return { '*': 'deny', [IMPLEMENTER_AGENT]: 'allow', [reviewerAgent(ownerId)]: 'allow' };
}

/** What an owner's prompt says about its subagents, so the skills can name them. */
export function subagentsText(ownerId: string) {
  return `<subagents>
Implementer: task with subagent_type "${IMPLEMENTER_AGENT}". Reviewer (another model family): task with subagent_type "${reviewerAgent(ownerId)}".
</subagents>`;
}

interface SkillsConfig { skills?: { paths?: string[] } | unknown[] }

/** opencode discovers skills from these directories: the owners' own, and any others (the operator's). */
export function registerSkills(config: SkillsConfig, directories: readonly string[] = [SKILLS_DIRECTORY]) {
  if (Array.isArray(config.skills)) return;
  const skills = (config.skills ??= {}) as { paths?: string[] };
  const paths = (skills.paths ??= []);
  for (const directory of directories) if (!paths.includes(directory)) paths.push(directory);
}

function withoutFrontmatter(text: string) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

let bootstrap: string | undefined;

/** The using-onionsoup-skills skill, already loaded, for an owner's top-level sessions. */
export function bootstrapText() {
  bootstrap ??= `<onionsoup-skills>
The ${BOOTSTRAP_SKILL} skill is below and already loaded; do not load it again with the skill tool.

${withoutFrontmatter(readFileSync(join(SKILLS_DIRECTORY, BOOTSTRAP_SKILL, 'SKILL.md'), 'utf8')).trim()}
</onionsoup-skills>`;
  return bootstrap;
}

export const BOOTSTRAP_MARKER = '<onionsoup-skills>';
